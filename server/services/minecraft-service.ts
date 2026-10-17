import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import * as yauzl from 'yauzl';

import { AppError, errorMessage } from '../lib/errors.js';
import { resolveInside, resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import {
  type MinecraftVersion,
  type ProvisionableServerSoftware,
  type ServerFlavor,
  type ServerRecord,
  type ServerSoftware,
  type ServerStartupConfig,
} from '../types.js';

const VANILLA_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_PROJECT_URL = 'https://fill.papermc.io/v3/projects/paper';
const PURPUR_PROJECT_URL = 'https://api.purpurmc.org/v2/purpur';
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2';
const QUILT_META_URL = 'https://meta.quiltmc.org/v3';
const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const SPIGOT_BUILD_TOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';
const BEDROCK_DOWNLOADS_JSON_URL = 'https://raw.githubusercontent.com/kittizz/bedrock-server-downloads/main/bedrock-server-downloads.json';
const DOWNLOAD_USER_AGENT = 'NodePilot/0.1 (https://github.com/nodepilot/nodepilot; local-server-manager)';
const MAX_DOWNLOAD_BYTES = 1_500 * 1024 * 1024;
const METADATA_CACHE_MS = 10 * 60 * 1000;
const PAPER_METADATA_CONCURRENCY = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_FALLBACK_BEDROCK_VERSIONS = [
  '1.26.52', '1.26.51', '1.26.45', '1.26.44', '1.26.43', '1.26.42', '1.26.40',
  '1.26.36', '1.26.34', '1.26.33', '1.26.32', '1.26.31', '1.26.30', '1.26.23',
  '1.26.21', '1.26.20', '1.26.14', '1.26.13', '1.26.12', '1.26.11', '1.26.10',
  '1.26.3', '1.26.2', '1.26.1', '1.26.0', '1.21.95', '1.21.94', '1.21.93',
  '1.21.92', '1.21.90', '1.21.84', '1.21.73', '1.21.72', '1.21.70', '1.21.62',
  '1.21.60', '1.21.51', '1.21.50',
];

type VanillaManifestEntry = {
  id: string;
  type: 'release' | 'snapshot';
  url: string;
  releaseTime: string;
};

type VanillaManifest = { versions: VanillaManifestEntry[] };

type VanillaVersionDetails = {
  downloads?: { server?: { url: string; sha1?: string; size?: number } };
  javaVersion?: { majorVersion?: number };
};

type PaperProject = { versions?: Record<string, string[]> | string[] };
type PaperDownload = { url?: string; checksums?: { sha256?: string }; size?: number };
type PaperBuild = {
  id?: number;
  number?: number;
  channel?: string;
  downloads?: Record<string, PaperDownload>;
};

type PaperAvailableVersion = {
  id: string;
  stable: boolean;
};

type PurpurProject = { versions?: string[] };
type PurpurBuild = { version?: string; build?: string | number; md5?: string; result?: string };
type LoaderEntry = {
  version?: string;
  stable?: boolean;
  loader?: { version?: string; stable?: boolean };
};
type InstallerEntry = {
  version?: string;
  stable?: boolean;
  url?: string;
  file_size?: number;
  hashes?: { sha1?: string; sha256?: string };
};
type GameVersionEntry = { version?: string; stable?: boolean };

export type InstalledServerRuntime = {
  software: ProvisionableServerSoftware;
  loaderVersion: string | null;
  startupConfig: ServerStartupConfig;
};

function flattenPaperVersions(versions: PaperProject['versions']): string[] {
  if (Array.isArray(versions)) return versions;
  if (!versions || typeof versions !== 'object') return [];
  return Object.values(versions).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

function isReleaseVersion(value: string): boolean {
  // Paper's project catalogue also includes pre-release and release-candidate identifiers.
  // NodePilot presents only normal Minecraft releases; the build query later enforces STABLE.
  return /^\d+\.\d+(?:\.\d+)?$/.test(value);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function trustedDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(502, 'invalid_download_url', 'The upstream service returned an invalid download URL.');
  }

  const allowedHosts = new Set([
    'piston-meta.mojang.com',
    'piston-data.mojang.com',
    'launchermeta.mojang.com',
    'fill.papermc.io',
    'fill-data.papermc.io',
    'api.purpurmc.org',
    'meta.fabricmc.net',
    'maven.fabricmc.net',
    'meta.quiltmc.org',
    'maven.quiltmc.org',
    'maven.minecraftforge.net',
    'maven.neoforged.net',
    'hub.spigotmc.org',
    'www.minecraft.net',
    'minecraft.net',
    'raw.githubusercontent.com',
  ]);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new AppError(502, 'untrusted_download_url', 'The upstream service returned an untrusted download URL.');
  }
  return url;
}

async function trustedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = trustedDownloadUrl(url).toString();
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    // Metadata gets a short internal deadline. Large JAR downloads pass their own longer-lived
    // signal so the deadline covers the response body as well as its headers.
    const ownsSignal = !init.signal;
    const timeout = ownsSignal ? setTimeout(() => controller.abort(), 30_000) : undefined;
    try {
      const response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: init.signal ?? controller.signal,
        headers: {
          Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.1',
          'User-Agent': DOWNLOAD_USER_AGENT,
          ...init.headers,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new AppError(502, 'download_redirect_failed', 'The upstream service sent an invalid redirect.');
        current = trustedDownloadUrl(new URL(location, current).toString()).toString();
        continue;
      }
      return response;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw new AppError(502, 'download_redirect_failed', 'The upstream service redirected too many times.');
}

async function requestJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await trustedFetch(url);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'metadata_unavailable', 'Could not reach the upstream Minecraft metadata service.');
  }
  if (!response.ok) {
    throw new AppError(502, 'metadata_request_failed', `The upstream metadata service returned HTTP ${response.status}.`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError(502, 'metadata_invalid', 'The upstream metadata service returned invalid JSON.');
  }
}

async function requestText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await trustedFetch(url, { headers: { Accept: 'text/plain, application/xml;q=0.9, */*;q=0.1' } });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'metadata_unavailable', 'Could not reach the upstream Minecraft metadata service.');
  }
  if (!response.ok) {
    throw new AppError(502, 'metadata_request_failed', 'The upstream metadata service returned HTTP ' + response.status + '.');
  }
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new AppError(502, 'metadata_too_large', 'The upstream metadata response was unexpectedly large.');
  return text;
}

function checksumFromSidecar(text: string, algorithm: 'sha1' | 'sha256'): string | undefined {
  const expression = algorithm === 'sha1' ? /\b([a-fA-F0-9]{40})\b/ : /\b([a-fA-F0-9]{64})\b/;
  return text.match(expression)?.[1]?.toLowerCase();
}

async function downloadFile(
  url: string,
  destination: string,
  expectedChecksum?: { algorithm: 'sha1' | 'sha256' | 'md5'; value?: string },
  expectedSize?: number,
  allowNoChecksum = false,
): Promise<void> {
  if (!expectedChecksum?.value && !allowNoChecksum) {
    throw new AppError(502, 'download_checksum_missing', 'The upstream service did not provide a checksum for this server file.');
  }
  const controller = new AbortController();
  const downloadTimeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  downloadTimeout.unref();
  let response: Response;
  try {
    response = await trustedFetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/java-archive, application/octet-stream;q=0.9' },
    });
  } catch (error) {
    clearTimeout(downloadTimeout);
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'download_unavailable', 'Could not reach the upstream download service.');
  }
  if (!response.ok || !response.body) {
    clearTimeout(downloadTimeout);
    throw new AppError(502, 'download_failed', `The upstream download service returned HTTP ${response.status}.`);
  }

  const advertisedSize = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertisedSize) && advertisedSize > MAX_DOWNLOAD_BYTES) {
    clearTimeout(downloadTimeout);
    throw new AppError(502, 'download_too_large', 'The server file is larger than the allowed download limit.');
  }
  if (expectedSize && Number.isSafeInteger(expectedSize) && advertisedSize && advertisedSize !== expectedSize) {
    clearTimeout(downloadTimeout);
    throw new AppError(502, 'download_size_mismatch', 'The upstream file size did not match its metadata.');
  }

  const partialPath = `${destination}.partial-${randomUUID()}`;
  const hash = createHash(expectedChecksum?.algorithm ?? 'sha256');
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        callback(new AppError(502, 'download_too_large', 'The server file is larger than the allowed download limit.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(partialPath, { flags: 'wx' }));
    if (bytes === 0) throw new AppError(502, 'download_empty', 'The downloaded server file was empty.');
    if (expectedSize && Number.isSafeInteger(expectedSize) && bytes !== expectedSize) {
      throw new AppError(502, 'download_size_mismatch', 'The downloaded server file did not match its metadata size.');
    }
    if (expectedChecksum?.value) {
      const normalizedExpected = expectedChecksum.value.toLowerCase();
      const checksumExpression = expectedChecksum.algorithm === 'sha256'
        ? /^[a-f0-9]{64}$/
        : expectedChecksum.algorithm === 'sha1'
          ? /^[a-f0-9]{40}$/
          : /^[a-f0-9]{32}$/;
      if (!checksumExpression.test(normalizedExpected) || hash.digest('hex') !== normalizedExpected) {
        throw new AppError(502, 'download_checksum_failed', 'The downloaded server file did not pass checksum verification.');
      }
    }
    await rename(partialPath, destination);
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'download_failed', `The server file could not be downloaded: ${errorMessage(error)}`);
  } finally {
    clearTimeout(downloadTimeout);
  }
}

function normalizeSoftware(value: ServerSoftware | ServerFlavor): ProvisionableServerSoftware {
  if (value === 'unknown') throw new AppError(422, 'unsupported_software', 'Choose a supported Minecraft server implementation.');
  return value;
}

function sortVersionsDescending(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
}

function versionsFromMavenMetadata(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<\s]+)<\/version>/g)].map((match) => match[1]).filter(Boolean);
}

function minecraftVersionForNeoForge(artifactVersion: string): string | undefined {
  if (/^1\.\d+(?:\.\d+)?-/.test(artifactVersion)) return artifactVersion.split('-')[0];
  const match = artifactVersion.match(/^(\d+)\.(\d+)\./);
  if (!match) return undefined;
  // NeoForge's modern Maven versions intentionally omit the leading "1." (21.4 → 1.21.4).
  return Number(match[1]) >= 20 ? '1.' + match[1] + '.' + match[2] : match[1] + '.' + match[2];
}

function minecraftVersionForForge(artifactVersion: string): string | undefined {
  return artifactVersion.match(/^(1\.\d+(?:\.\d+)?)-/)?.[1];
}

function defaultJarStartup(jarPath = 'server.jar'): ServerStartupConfig {
  return { mode: 'jar', jarPath, gameArguments: ['nogui'] };
}

function installerJarName(software: 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'spigot'): string {
  return '.nodepilot-' + software + '-installer.jar';
}

async function runJavaInstaller(javaPath: string, args: string[], cwd: string, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    try {
      child = spawn(javaPath, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new AppError(502, 'installer_start_failed', label + ' could not be started: ' + errorMessage(error)));
      return;
    }
    const append = (chunk: string | Buffer) => {
      output += chunk.toString();
      if (output.length > 24_000) output = output.slice(-24_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timeout = setTimeout(() => {
      child.kill();
      settle(() => reject(new AppError(504, 'installer_timeout', label + ' did not finish within 15 minutes.')));
    }, INSTALLER_TIMEOUT_MS);
    timeout.unref();
    child.once('error', (error) => {
      clearTimeout(timeout);
      settle(() => reject(new AppError(502, 'installer_start_failed', label + ' could not be started: ' + error.message)));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        settle(resolve);
        return;
      }
      const detail = output.trim().slice(-4_000);
      settle(() => reject(new AppError(
        422,
        'installer_failed',
        label + ' exited with code ' + (code ?? 'unknown') + (detail ? ': ' + detail : '.'),
      )));
    });
  });
}

async function commandIsAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

async function requireInstallerOutput(directory: string, fileName: string, label: string): Promise<void> {
  try {
    const details = await lstat(path.join(directory, fileName));
    if (!details.isFile() || details.isSymbolicLink() || details.size === 0) throw new Error('invalid');
  } catch {
    throw new AppError(422, 'installer_output_missing', label + ' completed without creating ' + fileName + '.');
  }
}

async function extractBedrockZip(archivePath: string, destination: string): Promise<void> {
  const zip = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: false,
    strictFileNames: false,
  });
  try {
    for await (const entry of zip.eachEntry()) {
      const rawPath = entry.fileName.replace(/\\/g, '/');
      if (
        !rawPath ||
        rawPath.startsWith('/') ||
        rawPath.startsWith('\\') ||
        /^[a-zA-Z]:/.test(rawPath) ||
        rawPath.split('/').some((part) => part === '..')
      ) {
        continue;
      }
      const targetPath = await resolveInside(destination, rawPath, false);
      if (rawPath.endsWith('/')) {
        await mkdir(targetPath, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      const readStream = await zip.openReadStreamPromise(entry);
      await pipeline(readStream, createWriteStream(targetPath, { flags: 'w' }));
      if (process.platform !== 'win32') {
        const base = path.basename(targetPath);
        if (base === 'bedrock_server' || base.endsWith('.so') || base.includes('.so.')) {
          await chmod(targetPath, 0o755).catch(() => undefined);
        }
      }
    }
  } finally {
    zip.close();
  }
}

export class MinecraftService {
  constructor(
    private readonly repository: ServerRepository,
    private readonly serversDirectory: string,
  ) {}

  async getVersions(softwareInput: ServerSoftware | ServerFlavor): Promise<MinecraftVersion[]> {
    const software = normalizeSoftware(softwareInput);
    if (software === 'bedrock') {
      return (await this.getBedrockAvailableVersions()).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    if (software === 'vanilla') {
      const manifest = await this.getVanillaManifest();
      return manifest.versions
        .filter((entry) => entry.type === 'release')
        .map((entry) => ({ id: entry.id, type: entry.type, releaseTime: entry.releaseTime, available: true }));
    }
    if (software === 'paper') {
      const versions = await this.getPaperAvailableVersions();
      return versions
        .filter((version) => version.stable)
        .sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true }))
        .map(({ id }) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    if (software === 'purpur') {
      return (await this.getPurpurVersions()).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    if (software === 'fabric') {
      return (await this.getLoaderGameVersions('fabric')).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    if (software === 'quilt') {
      return (await this.getLoaderGameVersions('quilt')).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    if (software === 'forge' || software === 'neoforge') {
      return (await this.getForgeLikeGameVersions(software)).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
    }
    return (await this.getSpigotAvailableVersions()).map((id) => ({ id, type: 'release', releaseTime: null, available: true }));
  }

  async getRequiredJavaMajor(softwareInput: ServerSoftware | ServerFlavor, version: string): Promise<number | null> {
    const software = normalizeSoftware(softwareInput);
    if (software === 'bedrock') return null;
    // Paper tracks Minecraft release versions, so Mojang's per-release metadata remains the
    // authoritative Java requirement for both supported distributions.
    const details = await this.getVanillaDetails(version);
    const major = details.javaVersion?.majorVersion;
    if (typeof major === 'number' && Number.isInteger(major)) return major;
    // Older Paper releases predate the Mojang javaVersion field. These are Paper's published
    // compatibility requirements and only serve as a backwards-compatible fallback.
    if (software !== 'vanilla') {
      const numbers = version.split('.').map((part) => Number.parseInt(part, 10));
      const minor = numbers[1] ?? 0;
      const patch = numbers[2] ?? 0;
      if (minor <= 11) return 8;
      if (minor <= 16) return minor === 16 && patch === 5 ? 16 : 11;
      if (minor <= 19) return 17;
      return 21;
    }
    return null;
  }

  async install(server: ServerRecord): Promise<InstalledServerRuntime> {
    const software = normalizeSoftware(server.software);
    await this.assertVersionAvailable(software, server.version);
    // Server directories are generated by NodePilot and verified not to be symlinks/junctions.
    const directory = await resolveManagedServerRoot(this.serversDirectory, server.directory, true);
    let runtime: InstalledServerRuntime;
    if (software === 'vanilla') runtime = await this.installVanilla(server, directory);
    else if (software === 'paper') runtime = await this.installPaper(server, directory);
    else if (software === 'purpur') runtime = await this.installPurpur(server, directory);
    else if (software === 'fabric') runtime = await this.installFabric(server, directory);
    else if (software === 'quilt') runtime = await this.installQuilt(server, directory);
    else if (software === 'forge' || software === 'neoforge') runtime = await this.installForgeLike(server, directory, software);
    else if (software === 'bedrock') runtime = await this.installBedrock(server, directory);
    else runtime = await this.installSpigot(server, directory);
    await this.writeStarterConfiguration(server, directory);
    return runtime;
  }

  async assertVersionAvailable(softwareInput: ServerSoftware | ServerFlavor, version: string): Promise<void> {
    const software = normalizeSoftware(softwareInput);
    if (software === 'vanilla') {
      const manifest = await this.getVanillaManifest();
      if (manifest.versions.some((entry) => entry.id === version && entry.type === 'release')) return;
    } else if (software === 'paper') {
      if ((await this.getPaperAvailableVersions()).some((candidate) => candidate.id === version && candidate.stable)) return;
    } else if (software === 'purpur') {
      if ((await this.getPurpurVersions()).includes(version)) return;
    } else if (software === 'fabric' || software === 'quilt') {
      if ((await this.getLoaderGameVersions(software)).includes(version)) return;
    } else if (software === 'forge' || software === 'neoforge') {
      if ((await this.getForgeLikeGameVersions(software)).includes(version)) return;
    } else if (software === 'bedrock') {
      if ((await this.getBedrockAvailableVersions()).includes(version)) return;
    } else if ((await this.getSpigotAvailableVersions()).includes(version)) {
      return;
    }
    throw new AppError(422, 'unsupported_version', software[0].toUpperCase() + software.slice(1) + ' Minecraft ' + version + ' is not available from its trusted upstream metadata.');
  }

  private async getVanillaManifest(): Promise<VanillaManifest> {
    const cached = this.repository.getCache<VanillaManifest>('minecraft:vanilla-manifest', METADATA_CACHE_MS);
    if (cached?.versions?.length) return cached;
    const manifest = await requestJson<VanillaManifest>(VANILLA_MANIFEST_URL);
    if (!Array.isArray(manifest.versions)) {
      throw new AppError(502, 'metadata_invalid', 'Mojang returned an invalid version manifest.');
    }
    this.repository.setCache('minecraft:vanilla-manifest', manifest);
    return manifest;
  }

  private async getVanillaDetails(version: string): Promise<VanillaVersionDetails> {
    const cacheKey = `minecraft:vanilla:${version}`;
    const cached = this.repository.getCache<VanillaVersionDetails>(cacheKey, 24 * 60 * 60 * 1000);
    if (cached) return cached;
    const manifest = await this.getVanillaManifest();
    const entry = manifest.versions.find((candidate) => candidate.id === version);
    if (!entry) throw new AppError(422, 'unsupported_version', `Minecraft ${version} is not available.`);
    const details = await requestJson<VanillaVersionDetails>(entry.url);
    this.repository.setCache(cacheKey, details);
    return details;
  }

  private async getPaperProject(): Promise<PaperProject> {
    const cached = this.repository.getCache<PaperProject>('minecraft:paper-project', METADATA_CACHE_MS);
    if (cached?.versions) return cached;
    const project = await requestJson<PaperProject>(PAPER_PROJECT_URL);
    if (!project.versions) throw new AppError(502, 'metadata_invalid', 'Paper returned an invalid project response.');
    this.repository.setCache('minecraft:paper-project', project);
    return project;
  }

  /**
   * Paper's project index lists all version lines, including releases currently in beta. We
   * resolve each normal release against its build list and retain only those with a STABLE
   * downloadable artifact, so the UI never advertises a selection creation must reject.
   */
  private async getPaperAvailableVersions(): Promise<PaperAvailableVersion[]> {
    const cacheKey = 'minecraft:paper-available-versions';
    const cached = this.repository.getCache<PaperAvailableVersion[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const project = await this.getPaperProject();
    const candidates = [...new Set(flattenPaperVersions(project.versions))]
      .filter((version): version is string => typeof version === 'string' && isReleaseVersion(version));
    const resolved = await mapWithConcurrency(candidates, PAPER_METADATA_CONCURRENCY, async (id): Promise<PaperAvailableVersion> => {
      try {
        await this.getLatestPaperBuild(id);
        return { id, stable: true };
      } catch (error) {
        if (error instanceof AppError && error.code === 'server_jar_unavailable') return { id, stable: false };
        throw error;
      }
    });
    this.repository.setCache(cacheKey, resolved);
    return resolved;
  }

  private async getLatestPaperBuild(version: string): Promise<PaperBuild> {
    const cacheKey = `minecraft:paper-build:${version}`;
    const cached = this.repository.getCache<PaperBuild>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const builds = await requestJson<PaperBuild[]>(
      `${PAPER_PROJECT_URL}/versions/${encodeURIComponent(version)}/builds`,
    );
    if (!Array.isArray(builds)) throw new AppError(502, 'metadata_invalid', 'Paper returned an invalid builds response.');
    const stable = [...builds]
      .sort((left, right) => (right.id ?? right.number ?? 0) - (left.id ?? left.number ?? 0))
      .find((build) => build.channel === 'STABLE' && build.downloads?.['server:default']?.url);
    if (!stable) throw new AppError(422, 'server_jar_unavailable', `Paper does not have a stable build for ${version}.`);
    this.repository.setCache(cacheKey, stable);
    return stable;
  }

  private async installVanilla(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const details = await this.getVanillaDetails(server.version);
    const download = details.downloads?.server;
    if (!download?.url) throw new AppError(422, 'server_jar_unavailable', 'Minecraft ' + server.version + ' does not provide a server JAR.');
    await downloadFile(download.url, path.join(directory, 'server.jar'), { algorithm: 'sha1', value: download.sha1 }, download.size);
    return { software: 'vanilla', loaderVersion: null, startupConfig: defaultJarStartup() };
  }

  private async installPaper(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const build = await this.getLatestPaperBuild(server.version);
    const download = build.downloads?.['server:default'];
    if (!download?.url) throw new AppError(422, 'server_jar_unavailable', 'Paper does not provide a stable build for ' + server.version + '.');
    await downloadFile(download.url, path.join(directory, 'server.jar'), { algorithm: 'sha256', value: download.checksums?.sha256 }, download.size);
    return { software: 'paper', loaderVersion: String(build.id ?? build.number ?? '') || null, startupConfig: defaultJarStartup() };
  }

  private async installPurpur(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const build = await this.getPurpurBuild(server.version);
    const downloadUrl = PURPUR_PROJECT_URL + '/' + encodeURIComponent(server.version) + '/latest/download';
    if (!build.md5) throw new AppError(502, 'download_checksum_missing', 'Purpur did not publish an integrity value for this build.');
    // Purpur's official API currently publishes an MD5 integrity value. It is checked here as
    // supplied by upstream; TLS and the fixed official API host are additionally enforced.
    await downloadFile(downloadUrl, path.join(directory, 'server.jar'), { algorithm: 'md5', value: build.md5 });
    return { software: 'purpur', loaderVersion: build.build === undefined ? null : String(build.build), startupConfig: defaultJarStartup() };
  }

  private async installFabric(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const loaderVersion = await this.getLoaderVersion('fabric', server.version);
    const installer = await this.getFabricInstaller();
    const installerPath = path.join(directory, installerJarName('fabric'));
    const checksum = await this.fetchSidecarChecksum(installer.url, 'sha1');
    try {
      await downloadFile(installer.url, installerPath, { algorithm: 'sha1', value: checksum });
      const javaPath = this.requireJavaForInstaller(server, 'Fabric');
      await runJavaInstaller(
        javaPath,
        ['-jar', installerPath, 'server', '-dir', directory, '-mcversion', server.version, '-loader', loaderVersion, '-downloadMinecraft'],
        directory,
        'Fabric installer',
      );
      await requireInstallerOutput(directory, 'fabric-server-launch.jar', 'Fabric installer');
      return { software: 'fabric', loaderVersion, startupConfig: defaultJarStartup('fabric-server-launch.jar') };
    } finally {
      await rm(installerPath, { force: true }).catch(() => undefined);
    }
  }

  private async installQuilt(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const loaderVersion = await this.getLoaderVersion('quilt', server.version);
    const installer = await this.getQuiltInstaller();
    const installerPath = path.join(directory, installerJarName('quilt'));
    try {
      await downloadFile(
        installer.url,
        installerPath,
        { algorithm: 'sha256', value: installer.hashes?.sha256 },
        installer.file_size,
      );
      const javaPath = this.requireJavaForInstaller(server, 'Quilt');
      await runJavaInstaller(
        javaPath,
        ['-jar', installerPath, 'install', 'server', server.version, loaderVersion, '--download-server', '--install-dir=.'],
        directory,
        'Quilt installer',
      );
      await requireInstallerOutput(directory, 'quilt-server-launch.jar', 'Quilt installer');
      return { software: 'quilt', loaderVersion, startupConfig: defaultJarStartup('quilt-server-launch.jar') };
    } finally {
      await rm(installerPath, { force: true }).catch(() => undefined);
    }
  }

  private async installForgeLike(
    server: ServerRecord,
    directory: string,
    software: 'forge' | 'neoforge',
  ): Promise<InstalledServerRuntime> {
    const loaderVersion = await this.getForgeLikeLoaderVersion(software, server.version);
    const host = software === 'forge' ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/' : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/';
    const artifact = software === 'forge' ? 'forge' : 'neoforge';
    const installerUrl = host + encodeURIComponent(loaderVersion) + '/' + artifact + '-' + encodeURIComponent(loaderVersion) + '-installer.jar';
    const installerPath = path.join(directory, installerJarName(software));
    try {
      const checksum = await this.fetchSidecarChecksum(installerUrl, 'sha1');
      await downloadFile(installerUrl, installerPath, { algorithm: 'sha1', value: checksum });
      await runJavaInstaller(
        this.requireJavaForInstaller(server, software === 'forge' ? 'Forge' : 'NeoForge'),
        ['-jar', installerPath, '--installServer'],
        directory,
        software === 'forge' ? 'Forge installer' : 'NeoForge installer',
      );
      const startupConfig = await this.loaderArgFileStartup(directory);
      return { software, loaderVersion, startupConfig };
    } finally {
      await rm(installerPath, { force: true }).catch(() => undefined);
    }
  }

  private async installSpigot(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    if (!await commandIsAvailable('git', ['--version'])) {
      throw new AppError(422, 'git_missing', 'Spigot BuildTools requires Git. Install Git, make it available on PATH, then retry creation.');
    }
    const buildToolsPath = path.join(directory, installerJarName('spigot'));
    try {
      // Spigot's official Jenkins artifact does not expose a checksum sidecar. It is fetched
      // only over the fixed HTTPS project host, size-limited, then executed without a shell.
      await downloadFile(SPIGOT_BUILD_TOOLS_URL, buildToolsPath, undefined, undefined, true);
      await runJavaInstaller(
        this.requireJavaForInstaller(server, 'Spigot BuildTools'),
        ['-jar', buildToolsPath, '--rev', server.version],
        directory,
        'Spigot BuildTools',
      );
      const candidates = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^spigot-.+\.jar$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      const output = candidates.find((name) => name.toLowerCase().includes(server.version.toLowerCase())) ?? candidates[0];
      if (!output) throw new AppError(422, 'installer_output_missing', 'Spigot BuildTools completed without creating a Spigot server JAR.');
      await rename(path.join(directory, output), path.join(directory, 'server.jar'));
      return { software: 'spigot', loaderVersion: null, startupConfig: defaultJarStartup() };
    } finally {
      await rm(buildToolsPath, { force: true }).catch(() => undefined);
    }
  }

  private async installBedrock(server: ServerRecord, directory: string): Promise<InstalledServerRuntime> {
    const manifest = await this.getBedrockManifest();
    const platform = process.platform === 'win32' ? 'windows' : 'linux';
    const entry = manifest[server.version];
    const platformUrl = entry?.[platform]?.url ?? (
      platform === 'windows'
        ? `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${server.version}.zip`
        : `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${server.version}.zip`
    );

    const zipTempPath = path.join(directory, `bedrock-download-${randomUUID()}.zip`);
    try {
      await downloadFile(platformUrl, zipTempPath, undefined, undefined, true);
      await extractBedrockZip(zipTempPath, directory);
      const exeName = process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';
      await requireInstallerOutput(directory, exeName, 'Bedrock Dedicated Server');
      return {
        software: 'bedrock',
        loaderVersion: null,
        startupConfig: {
          mode: 'executable',
          executablePath: exeName,
          gameArguments: [],
        },
      };
    } finally {
      await rm(zipTempPath, { force: true }).catch(() => undefined);
    }
  }

  private async getBedrockManifest(): Promise<Record<string, { windows?: { url: string }; linux?: { url: string } }>> {
    const cacheKey = 'minecraft:bedrock-manifest';
    const cached = this.repository.getCache<Record<string, { windows?: { url: string }; linux?: { url: string } }>>(cacheKey, METADATA_CACHE_MS);
    if (cached && Object.keys(cached).length > 0) return cached;
    try {
      const raw = await requestJson<Record<string, unknown>>(BEDROCK_DOWNLOADS_JSON_URL);
      const manifest: Record<string, { windows?: { url: string }; linux?: { url: string } }> =
        raw?.release && typeof raw.release === 'object'
          ? (raw.release as Record<string, { windows?: { url: string }; linux?: { url: string } }>)
          : (raw as Record<string, { windows?: { url: string }; linux?: { url: string } }>);
      if (manifest && typeof manifest === 'object' && Object.keys(manifest).length > 0) {
        this.repository.setCache(cacheKey, manifest);
        return manifest;
      }
    } catch {
      // Fallback to embedded version catalogue
    }
    const fallback: Record<string, { windows?: { url: string }; linux?: { url: string } }> = {};
    for (const v of DEFAULT_FALLBACK_BEDROCK_VERSIONS) {
      fallback[v] = {
        windows: { url: `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${v}.zip` },
        linux: { url: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${v}.zip` },
      };
    }
    return fallback;
  }

  private async getBedrockAvailableVersions(): Promise<string[]> {
    const manifest = await this.getBedrockManifest();
    return sortVersionsDescending(Object.keys(manifest));
  }

  private async writeStarterConfiguration(server: ServerRecord, directory: string): Promise<void> {
    if (server.software === 'bedrock') {
      const propertiesPath = path.join(directory, 'server.properties');
      let content = '';
      try {
        content = await readFile(propertiesPath, 'utf8');
      } catch {
        content = '';
      }
      if (content) {
        if (/^server-name=/m.test(content)) {
          content = content.replace(/^server-name=.*$/m, `server-name=${server.name}`);
        } else {
          content += `\nserver-name=${server.name}`;
        }
        if (/^server-port=/m.test(content)) {
          content = content.replace(/^server-port=.*$/m, `server-port=${server.port}`);
        } else {
          content += `\nserver-port=${server.port}`;
        }
        if (/^server-portv6=/m.test(content)) {
          content = content.replace(/^server-portv6=.*$/m, `server-portv6=${server.port + 1}`);
        } else {
          content += `\nserver-portv6=${server.port + 1}`;
        }
      } else {
        content = [
          '# Managed by NodePilot Bedrock Server',
          `server-name=${server.name}`,
          'gamemode=survival',
          'difficulty=easy',
          'allow-cheats=false',
          'max-players=10',
          'online-mode=true',
          'white-list=false',
          `server-port=${server.port}`,
          `server-portv6=${server.port + 1}`,
          'view-distance=32',
          'tick-distance=4',
          'player-idle-timeout=30',
          'max-threads=8',
          'level-name=Bedrock level',
          '',
        ].join('\n');
      }
      await writeFile(propertiesPath, content, { encoding: 'utf8' });
      return;
    }

    const serverProperties = [
      '# Managed by NodePilot. Values can be changed in the Server Properties editor.',
      'server-port=' + server.port,
      'motd=' + server.name,
      'enable-rcon=false',
      'online-mode=true',
      'max-players=20',
      'view-distance=10',
      '',
    ].join('\n');
    // These are new managed directories. Write EULA only after the request schema has required
    // explicit acceptance; installers are allowed to create their own defaults before this step.
    await writeFile(path.join(directory, 'server.properties'), serverProperties, { encoding: 'utf8' });
    await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n', { encoding: 'utf8' });
  }

  private requireJavaForInstaller(server: ServerRecord, label: string): string {
    if (!server.javaPath) {
      throw new AppError(422, 'java_missing', label + ' requires a compatible Java installation.');
    }
    return server.javaPath;
  }

  private async fetchSidecarChecksum(url: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
    const checksum = checksumFromSidecar(await requestText(url + '.' + algorithm), algorithm);
    if (!checksum) throw new AppError(502, 'download_checksum_missing', 'The upstream installer did not publish a valid ' + algorithm + ' checksum.');
    return checksum;
  }

  private async getPurpurVersions(): Promise<string[]> {
    const cacheKey = 'minecraft:purpur-versions';
    const cached = this.repository.getCache<string[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const project = await requestJson<PurpurProject>(PURPUR_PROJECT_URL);
    const versions = sortVersionsDescending((project.versions ?? []).filter((entry) => typeof entry === 'string' && isReleaseVersion(entry)));
    if (!versions.length) throw new AppError(502, 'metadata_invalid', 'Purpur returned no supported release versions.');
    this.repository.setCache(cacheKey, versions);
    return versions;
  }

  private async getPurpurBuild(version: string): Promise<PurpurBuild> {
    const cacheKey = 'minecraft:purpur-build:' + version;
    const cached = this.repository.getCache<PurpurBuild>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const build = await requestJson<PurpurBuild>(PURPUR_PROJECT_URL + '/' + encodeURIComponent(version) + '/latest');
    if (!build.md5 || build.result === 'error') throw new AppError(422, 'server_jar_unavailable', 'Purpur does not provide a build for ' + version + '.');
    this.repository.setCache(cacheKey, build);
    return build;
  }

  private async getLoaderGameVersions(software: 'fabric' | 'quilt'): Promise<string[]> {
    const cacheKey = 'minecraft:' + software + '-game-versions';
    const cached = this.repository.getCache<string[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const base = software === 'fabric' ? FABRIC_META_URL : QUILT_META_URL;
    const entries = await requestJson<GameVersionEntry[]>(base + '/versions/game');
    if (!Array.isArray(entries)) throw new AppError(502, 'metadata_invalid', software + ' returned invalid game version metadata.');
    const candidates = sortVersionsDescending(entries
      .filter((entry) => entry.stable !== false && typeof entry.version === 'string' && isReleaseVersion(entry.version))
      .map((entry) => entry.version as string))
      .slice(0, 80);
    const checked = await mapWithConcurrency(candidates, PAPER_METADATA_CONCURRENCY, async (version) => {
      try {
        await this.getLoaderVersion(software, version);
        return version;
      } catch {
        return undefined;
      }
    });
    const versions = checked.filter((version): version is string => Boolean(version));
    if (!versions.length) throw new AppError(502, 'metadata_invalid', software + ' returned no compatible stable loader releases.');
    this.repository.setCache(cacheKey, versions);
    return versions;
  }

  private async getLoaderVersion(software: 'fabric' | 'quilt', minecraftVersion: string): Promise<string> {
    const cacheKey = 'minecraft:' + software + '-loader:' + minecraftVersion;
    const cached = this.repository.getCache<string>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const base = software === 'fabric' ? FABRIC_META_URL : QUILT_META_URL;
    const entries = await requestJson<LoaderEntry[]>(base + '/versions/loader/' + encodeURIComponent(minecraftVersion));
    if (!Array.isArray(entries)) throw new AppError(422, 'unsupported_version', software + ' has no loader metadata for ' + minecraftVersion + '.');
    const entry = entries.find((candidate) => candidate.loader?.stable === true && candidate.loader.version)
      ?? entries.find((candidate) => candidate.stable === true && candidate.version)
      ?? entries.find((candidate) => candidate.loader?.version)
      ?? entries.find((candidate) => candidate.version);
    const version = entry?.loader?.version ?? entry?.version;
    if (!version) throw new AppError(422, 'unsupported_version', software + ' has no compatible loader for ' + minecraftVersion + '.');
    this.repository.setCache(cacheKey, version);
    return version;
  }

  private async getFabricInstaller(): Promise<{ version: string; url: string }> {
    const cacheKey = 'minecraft:fabric-installer';
    const cached = this.repository.getCache<{ version: string; url: string }>(cacheKey, 24 * 60 * 60 * 1000);
    if (cached) return cached;
    const entries = await requestJson<InstallerEntry[]>(FABRIC_META_URL + '/versions/installer');
    const entry = entries.find((candidate) => candidate.stable === true && candidate.version) ?? entries.find((candidate) => candidate.version);
    if (!entry?.version) throw new AppError(502, 'metadata_invalid', 'Fabric did not publish an installer version.');
    const result = {
      version: entry.version,
      url: entry.url ?? 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/' + entry.version + '/fabric-installer-' + entry.version + '.jar',
    };
    this.repository.setCache(cacheKey, result);
    return result;
  }

  private async getQuiltInstaller(): Promise<Required<Pick<InstallerEntry, 'url' | 'file_size' | 'hashes'>> & { version: string }> {
    const cacheKey = 'minecraft:quilt-installer';
    const cached = this.repository.getCache<Required<Pick<InstallerEntry, 'url' | 'file_size' | 'hashes'>> & { version: string }>(cacheKey, 24 * 60 * 60 * 1000);
    if (cached) return cached;
    const entries = await requestJson<InstallerEntry[]>(QUILT_META_URL + '/versions/installer');
    const entry = entries.find((candidate) => candidate.stable !== false && candidate.version && candidate.url && candidate.file_size && candidate.hashes?.sha256);
    if (!entry?.version || !entry.url || !entry.file_size || !entry.hashes?.sha256) {
      throw new AppError(502, 'metadata_invalid', 'Quilt did not publish a verifiable installer.');
    }
    const result = { version: entry.version, url: entry.url, file_size: entry.file_size, hashes: entry.hashes };
    this.repository.setCache(cacheKey, result);
    return result;
  }

  private async getForgeLikeArtifactVersions(software: 'forge' | 'neoforge'): Promise<string[]> {
    const cacheKey = 'minecraft:' + software + '-maven-versions';
    const cached = this.repository.getCache<string[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const xml = await requestText(software === 'forge' ? FORGE_METADATA_URL : NEOFORGE_METADATA_URL);
    const versions = sortVersionsDescending(versionsFromMavenMetadata(xml));
    if (!versions.length) throw new AppError(502, 'metadata_invalid', software + ' returned no Maven versions.');
    this.repository.setCache(cacheKey, versions);
    return versions;
  }

  private async getForgeLikeGameVersions(software: 'forge' | 'neoforge'): Promise<string[]> {
    const cacheKey = 'minecraft:' + software + '-game-versions';
    const cached = this.repository.getCache<string[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const parse = software === 'forge' ? minecraftVersionForForge : minecraftVersionForNeoForge;
    const versions = sortVersionsDescending((await this.getForgeLikeArtifactVersions(software))
      .map(parse)
      .filter((value): value is string => typeof value === 'string' && isReleaseVersion(value)));
    if (!versions.length) throw new AppError(502, 'metadata_invalid', software + ' did not list usable Minecraft versions.');
    this.repository.setCache(cacheKey, versions);
    return versions;
  }

  private async getForgeLikeLoaderVersion(software: 'forge' | 'neoforge', minecraftVersion: string): Promise<string> {
    const parse = software === 'forge' ? minecraftVersionForForge : minecraftVersionForNeoForge;
    const version = (await this.getForgeLikeArtifactVersions(software))
      .filter((candidate) => parse(candidate) === minecraftVersion)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
    if (!version) throw new AppError(422, 'unsupported_version', software + ' has no loader release for Minecraft ' + minecraftVersion + '.');
    return version;
  }

  private async getSpigotAvailableVersions(): Promise<string[]> {
    const cacheKey = 'minecraft:spigot-versions';
    const cached = this.repository.getCache<string[]>(cacheKey, METADATA_CACHE_MS);
    if (cached) return cached;
    const manifest = await this.getVanillaManifest();
    // BuildTools has broad historical coverage. Probe a bounded recent release set through
    // Spigot's own BuildData metadata, rather than advertising every Mojang version blindly.
    const candidates = manifest.versions
      .filter((entry) => entry.type === 'release' && isReleaseVersion(entry.id))
      .map((entry) => entry.id)
      .slice(0, 80);
    const checked = await mapWithConcurrency(candidates, PAPER_METADATA_CONCURRENCY, async (version) => {
      try {
        const details = await requestJson<{ refs?: Record<string, string> }>('https://hub.spigotmc.org/versions/' + encodeURIComponent(version) + '.json');
        return details.refs && Object.keys(details.refs).length ? version : undefined;
      } catch {
        return undefined;
      }
    });
    const versions = checked.filter((version): version is string => Boolean(version));
    if (!versions.length) throw new AppError(502, 'metadata_invalid', 'Spigot BuildTools did not report any compatible releases.');
    this.repository.setCache(cacheKey, versions);
    return versions;
  }

  private async loaderArgFileStartup(directory: string): Promise<ServerStartupConfig> {
    const pending = ['libraries'];
    const matches: Array<{ relative: string; parent: string; kind: 'windows' | 'linux' }> = [];
    let inspected = 0;
    while (pending.length) {
      const relativeDirectory = pending.pop() as string;
      const absoluteDirectory = path.join(directory, relativeDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        inspected += 1;
        if (inspected > 100_000) throw new AppError(422, 'installer_output_invalid', 'The loader installation created too many files to inspect safely.');
        if (entry.isSymbolicLink()) continue;
        const relative = relativeDirectory.replaceAll('\\', '/') + '/' + entry.name;
        if (entry.isDirectory()) pending.push(relative);
        if (entry.isFile() && /^win_args\.txt$/i.test(entry.name)) matches.push({ relative, parent: path.posix.dirname(relative), kind: 'windows' });
        if (entry.isFile() && /^unix_args\.txt$/i.test(entry.name)) matches.push({ relative, parent: path.posix.dirname(relative), kind: 'linux' });
      }
    }
    const windows = new Map(matches.filter((entry) => entry.kind === 'windows').map((entry) => [entry.parent, entry.relative]));
    const linux = matches.find((entry) => entry.kind === 'linux' && windows.has(entry.parent));
    if (!linux) throw new AppError(422, 'installer_output_missing', 'The loader installer did not create matching Windows and Linux launch argument files.');
    const userJvmArgs = await lstat(path.join(directory, 'user_jvm_args.txt'))
      .then((details) => details.isFile() && !details.isSymbolicLink())
      .catch(() => false);
    return {
      mode: 'arg-files',
      windowsArgFile: windows.get(linux.parent) as string,
      linuxArgFile: linux.relative,
      jvmArgFiles: userJvmArgs ? ['user_jvm_args.txt'] : [],
      gameArguments: ['nogui'],
    };
  }
}
