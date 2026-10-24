import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as openpgp from 'openpgp';
import * as tar from 'tar';

import { AppError } from '../lib/errors.js';
import type { TorStatus } from '../types.js';

const ONION_ADDRESS_PATTERN = /^[a-z2-7]{56}\.onion$/;
const TOR_DOWNLOAD_CATALOG_URL = 'https://download.torproject.org/tor/';
const TOR_DISTRIBUTION_HOSTNAME = 'dist.torproject.org';
const TOR_SIGNING_KEY_URL = 'https://openpgpkey.torproject.org/.well-known/openpgpkey/torproject.org/hu/kounek7zrdx745qydx6p59t9mqjpuhdf';
const TOR_SIGNING_KEY_HOSTNAME = 'openpgpkey.torproject.org';
const TOR_SIGNING_KEY_FINGERPRINT = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290';
const MAX_TOR_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_TOR_EXTRACTED_BYTES = 180 * 1024 * 1024;
const MAX_TOR_ARCHIVE_ENTRIES = 2_000;
const MAX_TOR_DECOMPRESSION_RATIO = 64;
const METADATA_DOWNLOAD_LIMIT = 512 * 1024;
const TOR_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const TOR_METADATA_TIMEOUT_MS = 30_000;

export type TorInstallStage = 'idle' | 'resolving' | 'verifying' | 'downloading' | 'installing' | 'failed';

export interface TorExpertBundleRelease {
  version: string;
  archiveName: string;
  archiveUrl: string;
  checksumsUrl: string;
  checksumSignatureUrl: string;
}

interface TimedFetchResponse {
  response: Response;
  finish: () => void;
  didTimeout: () => boolean;
}

function isStableTorVersion(value: string): boolean {
  return /^\d+(?:\.\d+){2,3}$/.test(value);
}

function compareStableTorVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function bundlePlatform(platform: NodeJS.Platform): 'windows' | 'linux' | null {
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return null;
}

function trustedHttpsUrl(value: string, expectedHostname: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== expectedHostname
      || url.port !== ''
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Select the latest stable x64 Expert Bundle published in Tor Project's official
 * catalog. Alpha builds and any URL outside the expected distribution host are
 * deliberately ignored.
 */
export function selectTorExpertBundle(catalog: string, platform: NodeJS.Platform = process.platform): TorExpertBundleRelease | null {
  const targetPlatform = bundlePlatform(platform);
  if (!targetPlatform) return null;

  const hrefPattern = /\bhref\s*=\s*(['"])(.*?)\1/gi;
  const archivePattern = /^\/torbrowser\/(\d+(?:\.\d+){2,3})\/tor-expert-bundle-(windows|linux)-x86_64-(\d+(?:\.\d+){2,3})\.tar\.gz$/;
  let candidate: TorExpertBundleRelease | null = null;

  for (const match of catalog.matchAll(hrefPattern)) {
    const url = trustedHttpsUrl(match[2], TOR_DISTRIBUTION_HOSTNAME);
    if (!url) continue;
    const pathMatch = url.pathname.match(archivePattern);
    if (!pathMatch) continue;

    const [, version, archivePlatform, archiveVersion] = pathMatch;
    if (archivePlatform !== targetPlatform || version !== archiveVersion || !isStableTorVersion(version)) continue;
    const archiveName = path.posix.basename(url.pathname);
    const directory = 'https://' + TOR_DISTRIBUTION_HOSTNAME + '/torbrowser/' + version + '/';
    const release: TorExpertBundleRelease = {
      version,
      archiveName,
      archiveUrl: url.href,
      checksumsUrl: directory + 'sha256sums-signed-build.txt',
      checksumSignatureUrl: directory + 'sha256sums-signed-build.txt.asc',
    };

    if (!candidate || compareStableTorVersions(release.version, candidate.version) > 0) {
      candidate = release;
    }
  }

  return candidate;
}

/** Return the one exact SHA-256 record for a verified Expert Bundle asset. */
export function checksumForTorArchive(manifest: string, archiveName: string): string | null {
  const matches: string[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2] === archiveName) matches.push(match[1].toLowerCase());
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Keep archive extraction intentionally narrow: no absolute paths, traversal,
 * Windows drive paths, alternate streams, or ambiguous duplicate separators.
 */
export function isSafeTorBundleArchivePath(value: string): boolean {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f\\:]/.test(value)) return false;
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!normalized || normalized.startsWith('/') || normalized.includes('//')) return false;
  const parts = normalized.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function isTorOnionAddress(value: string): boolean {
  return ONION_ADDRESS_PATTERN.test(value.trim().toLowerCase());
}

function torPath(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/.test(value)) {
    throw new Error('Tor runtime paths must be absolute paths without control characters.');
  }
  return value.replace(/\\/g, '/');
}

/** Build the narrowly scoped Tor configuration used by NodePilot's Onion service. */
export function createTorConfiguration(
  dataDirectory: string,
  hiddenServiceDirectory: string,
  panelPort: number,
): string {
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65_535) {
    throw new Error('NodePilot panel port must be a valid TCP port.');
  }

  return [
    `DataDirectory "${torPath(dataDirectory)}"`,
    // NodePilot does not expose Tor's SOCKS proxy. This process exists only for the
    // private Onion service below.
    'SocksPort 0',
    // Explicitly keep this process client-only; NodePilot never turns the host into
    // a Tor relay.
    'ClientOnly 1',
    `HiddenServiceDir "${torPath(hiddenServiceDirectory)}"`,
    `HiddenServicePort 80 127.0.0.1:${panelPort}`,
    'Log notice stdout',
    '',
  ].join('\n');
}

interface TorBinary {
  path: string;
  version: string | null;
}

export class TorService {
  private childProcess: ChildProcess | null = null;
  private cachedBinaryPath: string | null = null;
  private lastError: string | null = null;
  private bootstrapped = false;
  private stopping = false;
  private onionAddress: string | null = null;
  private outputTail = '';
  private installPromise: Promise<void> | null = null;
  private installStage: TorInstallStage = 'idle';

  private readonly rootDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly hiddenServiceDirectory: string;
  private readonly configurationPath: string;
  private readonly managedBundleDirectory: string;
  private readonly managedBinaryPath: string;
  private readonly downloadDirectory: string;

  constructor(private readonly nodePilotDataDirectory: string) {
    this.rootDirectory = path.join(nodePilotDataDirectory, 'tor');
    this.runtimeDirectory = path.join(this.rootDirectory, 'runtime');
    this.hiddenServiceDirectory = path.join(this.rootDirectory, 'onion-service');
    this.configurationPath = path.join(this.rootDirectory, 'torrc');
    this.managedBundleDirectory = path.join(this.rootDirectory, 'bundle');
    this.managedBinaryPath = path.join(this.managedBundleDirectory, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');
    this.downloadDirectory = path.join(this.rootDirectory, 'downloads');
    this.onionAddress = this.readOnionAddressSync();
  }

  private isSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'linux';
  }

  private canAutoInstall(): boolean {
    return this.isSupported() && process.arch === 'x64';
  }

  private isRunning(): boolean {
    return Boolean(this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed);
  }

  private async readOnionAddress(): Promise<string | null> {
    try {
      const hostname = (await readFile(path.join(this.hiddenServiceDirectory, 'hostname'), 'utf8')).trim().toLowerCase();
      this.onionAddress = isTorOnionAddress(hostname) ? hostname : null;
      return this.onionAddress;
    } catch {
      this.onionAddress = null;
      return null;
    }
  }

  private readOnionAddressSync(): string | null {
    try {
      const hostname = readFileSync(path.join(this.hiddenServiceDirectory, 'hostname'), 'utf8').trim().toLowerCase();
      return isTorOnionAddress(hostname) ? hostname : null;
    } catch {
      return null;
    }
  }

  /** Returns the current persistent Onion hostname, if Tor has generated one. */
  async getOnionAddress(): Promise<string | null> {
    return this.readOnionAddress();
  }

  /** Used synchronously by Fastify's CORS/WebSocket origin checks. */
  getAllowedOriginHostname(): string | null {
    if (!this.isRunning()) return null;
    if (!this.onionAddress) this.onionAddress = this.readOnionAddressSync();
    return this.onionAddress;
  }

  private async probeBinary(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let child: ChildProcess;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      try {
        child = spawn(command, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }

      const append = (chunk: Buffer) => {
        if (output.length < 4_096) output += chunk.toString('utf8').slice(0, 4_096 - output.length);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* process already exited */ }
        finish(null);
      }, 5_000);
      timeout.unref();
      child.once('error', () => finish(null));
      child.once('close', (code) => {
        if (code !== 0) return finish(null);
        const match = output.match(/Tor version\s+([^\s]+)/i);
        finish(match?.[1] ?? 'installed');
      });
    });
  }

  private candidatePaths(): string[] {
    const configured = process.env.NODEPILOT_TOR_PATH?.trim();
    const candidates = configured && path.isAbsolute(configured) ? [configured] : [];
    if (this.canAutoInstall()) candidates.push(this.managedBinaryPath);

    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Tor\\tor.exe',
        'C:\\Program Files (x86)\\Tor\\tor.exe',
        path.join(os.homedir(), 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
      );
    } else if (process.platform === 'linux') {
      candidates.push(
        '/usr/bin/tor',
        '/usr/local/bin/tor',
        path.join(os.homedir(), '.local', 'bin', 'tor'),
        path.join(os.homedir(), 'tor-browser', 'Browser', 'TorBrowser', 'Tor', 'tor'),
        path.join(os.homedir(), 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor'),
      );
    }
    return candidates;
  }

  private async findBinary(): Promise<TorBinary | null> {
    if (!this.isSupported()) return null;

    if (this.cachedBinaryPath && existsSync(this.cachedBinaryPath)) {
      const version = await this.probeBinary(this.cachedBinaryPath);
      if (version) return { path: this.cachedBinaryPath, version };
    }

    for (const candidate of this.candidatePaths()) {
      if (!existsSync(candidate)) continue;
      const version = await this.probeBinary(candidate);
      if (version) {
        this.cachedBinaryPath = candidate;
        return { path: candidate, version };
      }
    }

    // `spawn` resolves PATH itself, avoiding a shell invocation of `where` / `which`.
    const pathCommand = process.platform === 'win32' ? 'tor.exe' : 'tor';
    const version = await this.probeBinary(pathCommand);
    if (version) {
      this.cachedBinaryPath = pathCommand;
      return { path: pathCommand, version };
    }
    return null;
  }

  private async fetchWithTimeout(url: URL, timeoutMs: number): Promise<TimedFetchResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: controller.signal,
        headers: { 'User-Agent': 'NodePilot-TorInstaller/1.0' },
      });
      // fetch() resolves after headers, so retain the deadline until the caller
      // has finished consuming the response stream.
      return {
        response,
        finish: () => clearTimeout(timeout),
        didTimeout: () => timedOut,
      };
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new AppError(504, 'tor_download_timeout', 'Tor Project did not respond before NodePilot timed out.');
      }
      throw error;
    }
  }

  private async fetchTrustedResponse(urlValue: string, expectedHostname: string, timeoutMs: number, purpose: string): Promise<TimedFetchResponse> {
    const url = trustedHttpsUrl(urlValue, expectedHostname);
    if (!url) {
      throw new AppError(502, 'untrusted_tor_download_url', 'Tor Project supplied an unexpected download address. Nothing was installed.');
    }
    const timedResponse = await this.fetchWithTimeout(url, timeoutMs);
    const { response } = timedResponse;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      timedResponse.finish();
      throw new AppError(502, 'tor_download_unavailable', 'Tor Project could not provide ' + purpose + ' (HTTP ' + response.status + ').');
    }
    const finalUrl = trustedHttpsUrl(response.url, expectedHostname);
    if (!finalUrl) {
      await response.body?.cancel().catch(() => undefined);
      timedResponse.finish();
      throw new AppError(502, 'untrusted_tor_download_url', 'Tor Project redirected to an unexpected download address. Nothing was installed.');
    }
    return timedResponse;
  }

  private async readTrustedBytes(url: string, expectedHostname: string, maxBytes: number, purpose: string): Promise<Buffer> {
    const timedResponse = await this.fetchTrustedResponse(url, expectedHostname, TOR_METADATA_TIMEOUT_MS, purpose);
    const { response } = timedResponse;
    try {
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError(413, 'tor_metadata_too_large', 'Tor Project returned more metadata than NodePilot will accept.');
      }
      if (!response.body) return Buffer.alloc(0);

      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        received += buffer.length;
        if (received > maxBytes) {
          stream.destroy();
          throw new AppError(413, 'tor_metadata_too_large', 'Tor Project returned more metadata than NodePilot will accept.');
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (timedResponse.didTimeout()) {
        throw new AppError(504, 'tor_download_timeout', 'Tor Project did not finish responding before NodePilot timed out.');
      }
      throw error;
    } finally {
      timedResponse.finish();
    }
  }

  private async readTrustedText(url: string, expectedHostname: string, maxBytes: number, purpose: string): Promise<string> {
    return (await this.readTrustedBytes(url, expectedHostname, maxBytes, purpose)).toString('utf8');
  }

  private async downloadVerifiedArchive(url: string, expectedChecksum: string, destination: string): Promise<void> {
    const timedResponse = await this.fetchTrustedResponse(url, TOR_DISTRIBUTION_HOSTNAME, TOR_DOWNLOAD_TIMEOUT_MS, 'the Tor Expert Bundle');
    const { response } = timedResponse;

    try {
      if (!response.body) {
        throw new AppError(502, 'tor_download_unavailable', 'Tor Project returned an empty Tor Expert Bundle download.');
      }

      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > MAX_TOR_ARCHIVE_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new AppError(413, 'tor_download_too_large', 'The Tor Expert Bundle exceeds NodePilot’s supported download size.');
      }

      const hash = createHash('sha256');
      let downloaded = 0;
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          downloaded += chunk.length;
          if (downloaded > MAX_TOR_ARCHIVE_BYTES) {
            callback(new AppError(413, 'tor_download_too_large', 'The Tor Expert Bundle exceeds NodePilot’s supported download size.'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      await pipeline(source, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      if (downloaded === 0 || hash.digest('hex').toLowerCase() !== expectedChecksum.toLowerCase()) {
        throw new AppError(422, 'tor_checksum_mismatch', 'The downloaded Tor Expert Bundle did not match Tor Project’s signed checksum. Nothing was installed.');
      }
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      if (timedResponse.didTimeout()) {
        throw new AppError(504, 'tor_download_timeout', 'Tor Project did not finish responding before NodePilot timed out.');
      }
      throw error;
    } finally {
      timedResponse.finish();
    }
  }

  private async resolveExpertBundle(): Promise<TorExpertBundleRelease> {
    const catalog = await this.readTrustedText(
      TOR_DOWNLOAD_CATALOG_URL,
      'download.torproject.org',
      METADATA_DOWNLOAD_LIMIT,
      'the Tor Expert Bundle catalog',
    );
    const release = selectTorExpertBundle(catalog);
    if (!release) {
      throw new AppError(502, 'tor_bundle_unavailable', 'No supported stable Tor Expert Bundle is currently published for this operating system.');
    }
    return release;
  }

  private async verifySignedChecksumManifest(release: TorExpertBundleRelease): Promise<string> {
    const [manifest, signature, publicKeyBytes] = await Promise.all([
      this.readTrustedText(release.checksumsUrl, TOR_DISTRIBUTION_HOSTNAME, METADATA_DOWNLOAD_LIMIT, 'the Tor checksum manifest'),
      this.readTrustedText(release.checksumSignatureUrl, TOR_DISTRIBUTION_HOSTNAME, METADATA_DOWNLOAD_LIMIT, 'the Tor checksum signature'),
      this.readTrustedBytes(TOR_SIGNING_KEY_URL, TOR_SIGNING_KEY_HOSTNAME, METADATA_DOWNLOAD_LIMIT, 'the Tor signing key'),
    ]);

    let verificationKey: openpgp.Key;
    try {
      verificationKey = await openpgp.readKey({ binaryKey: publicKeyBytes });
    } catch {
      throw new AppError(502, 'tor_signing_key_invalid', 'NodePilot could not read the official Tor signing key. Nothing was installed.');
    }
    if (verificationKey.getFingerprint().toUpperCase() !== TOR_SIGNING_KEY_FINGERPRINT) {
      throw new AppError(502, 'tor_signing_key_invalid', 'The downloaded Tor signing key did not match the pinned Tor Project fingerprint. Nothing was installed.');
    }

    try {
      const verification = await openpgp.verify({
        message: await openpgp.createMessage({ binary: Buffer.from(manifest, 'utf8') }),
        signature: await openpgp.readSignature({ armoredSignature: signature }),
        verificationKeys: verificationKey,
        format: 'binary',
      });
      const results = await Promise.all(verification.signatures.map(async (candidate) => {
        try {
          await candidate.verified;
          return true;
        } catch {
          return false;
        }
      }));
      if (!results.some(Boolean)) {
        throw new AppError(422, 'tor_signature_invalid', 'Tor Project’s checksum manifest signature could not be verified. Nothing was installed.');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, 'tor_signature_invalid', 'Tor Project’s checksum manifest signature could not be verified. Nothing was installed.');
    }

    const expectedChecksum = checksumForTorArchive(manifest, release.archiveName);
    if (!expectedChecksum) {
      throw new AppError(422, 'tor_checksum_missing', 'Tor Project’s signed checksum manifest did not contain the selected Expert Bundle. Nothing was installed.');
    }
    return expectedChecksum;
  }

  private async inspectBundleArchive(archivePath: string): Promise<void> {
    const archive = await stat(archivePath);
    let entryCount = 0;
    let extractedBytes = 0;
    const paths = new Set<string>();

    await tar.t({
      file: archivePath,
      gzip: true,
      strict: true,
      maxDecompressionRatio: MAX_TOR_DECOMPRESSION_RATIO,
      onReadEntry: (entry) => {
        const normalizedPath = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
        const comparisonPath = normalizedPath.normalize('NFC').toLocaleLowerCase('en-US');
        if (!isSafeTorBundleArchivePath(entry.path)) {
          throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle contains an unsafe path. Nothing was installed.');
        }
        if (entry.type !== 'File' && entry.type !== 'Directory') {
          throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle contains an unsupported filesystem entry. Nothing was installed.');
        }
        if (paths.has(comparisonPath)) {
          throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle contains duplicate file paths. Nothing was installed.');
        }
        paths.add(comparisonPath);
        entryCount += 1;
        extractedBytes += entry.size;
        if (
          entryCount > MAX_TOR_ARCHIVE_ENTRIES
          || !Number.isSafeInteger(entry.size)
          || entry.size < 0
          || extractedBytes > MAX_TOR_EXTRACTED_BYTES
          || extractedBytes / Math.max(archive.size, 1) > MAX_TOR_DECOMPRESSION_RATIO
        ) {
          throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle exceeds NodePilot’s safe extraction limits. Nothing was installed.');
        }
      },
    });

    if (entryCount === 0) {
      throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle was empty. Nothing was installed.');
    }
  }

  private async validateBundleLayout(directory: string): Promise<void> {
    const requiredFiles = [
      path.join('tor', process.platform === 'win32' ? 'tor.exe' : 'tor'),
      path.join('data', 'geoip'),
      path.join('data', 'geoip6'),
    ];
    for (const relativePath of requiredFiles) {
      const file = path.join(directory, relativePath);
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
      } catch {
        throw new AppError(422, 'invalid_tor_bundle', 'The verified Tor Expert Bundle was missing a required runtime file. Nothing was installed.');
      }
    }
    if (process.platform !== 'win32') {
      await chmod(path.join(directory, 'tor', 'tor'), 0o700);
    }
  }

  private async installManagedBundleInternal(): Promise<TorStatus> {
    const identifier = Date.now().toString(36) + '-' + randomBytes(8).toString('hex');
    const archivePath = path.join(this.downloadDirectory, 'tor-expert-' + identifier + '.tar.gz');
    const stagingDirectory = path.join(this.rootDirectory, '.bundle-staging-' + identifier);
    const backupDirectory = path.join(this.rootDirectory, '.bundle-backup-' + identifier);
    let stagingCreated = false;
    let backupCreated = false;

    try {
      this.lastError = null;
      this.installStage = 'resolving';
      const release = await this.resolveExpertBundle();

      this.installStage = 'verifying';
      const expectedChecksum = await this.verifySignedChecksumManifest(release);

      this.installStage = 'downloading';
      await mkdir(this.downloadDirectory, { recursive: true, mode: 0o700 });
      await this.downloadVerifiedArchive(release.archiveUrl, expectedChecksum, archivePath);

      this.installStage = 'installing';
      await this.inspectBundleArchive(archivePath);
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      stagingCreated = true;
      await tar.x({
        file: archivePath,
        cwd: stagingDirectory,
        gzip: true,
        strict: true,
        keep: true,
        noMtime: true,
        maxDecompressionRatio: MAX_TOR_DECOMPRESSION_RATIO,
        filter: (entryPath) => {
          if (!isSafeTorBundleArchivePath(entryPath)) {
            throw new AppError(422, 'unsafe_tor_archive', 'The Tor Expert Bundle contains an unsafe path. Nothing was installed.');
          }
          return true;
        },
      });
      await this.validateBundleLayout(stagingDirectory);

      // This directory is exclusively owned by NodePilot. Keep its previous
      // verified bundle until the replacement has been promoted successfully.
      try {
        if (existsSync(this.managedBundleDirectory)) {
          await rename(this.managedBundleDirectory, backupDirectory);
          backupCreated = true;
        }

        await rename(stagingDirectory, this.managedBundleDirectory);
        stagingCreated = false;
      } catch (promotionError) {
        if (backupCreated && !existsSync(this.managedBundleDirectory)) {
          try {
            await rename(backupDirectory, this.managedBundleDirectory);
            backupCreated = false;
          } catch {
            // Preserve the backup for recovery instead of deleting a known-good
            // runtime if the filesystem cannot restore it automatically.
          }
        }
        throw promotionError;
      }

      if (backupCreated) {
        try {
          await rm(backupDirectory, { recursive: true, force: true });
        } catch {
          // A stale backup is harmless and is safer than reporting a successful
          // install as failed after the new verified bundle is already active.
        }
      }
      this.cachedBinaryPath = this.managedBinaryPath;
      this.lastError = null;
      return this.getStatus();
    } catch (error) {
      this.cachedBinaryPath = null;
      const appError = error instanceof AppError
        ? error
        : new AppError(502, 'tor_install_failed', 'NodePilot could not install the verified Tor Expert Bundle. Try again or install Tor manually.');
      this.lastError = appError.message;
      this.installStage = 'failed';
      throw appError;
    } finally {
      await unlink(archivePath).catch(() => undefined);
      if (stagingCreated) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async installManagedBundle(): Promise<TorStatus> {
    if (!this.canAutoInstall()) {
      throw new AppError(422, 'tor_auto_install_unsupported', 'One-click Tor installation is currently available on Windows and Linux x64 hosts only.');
    }

    const existing = await this.findBinary();
    if (existing) return this.getStatus();
    if (this.installPromise) {
      await this.installPromise;
      return this.getStatus();
    }

    const pending = this.installManagedBundleInternal().then(() => undefined);
    this.installPromise = pending;
    try {
      await pending;
    } finally {
      if (this.installPromise === pending) {
        this.installPromise = null;
        if (this.installStage !== 'failed') this.installStage = 'idle';
      }
    }
    return this.getStatus();
  }

  async getStatus(): Promise<TorStatus> {
    const binary = await this.findBinary();
    const onionAddress = await this.readOnionAddress();
    const isRunning = this.isRunning();
    return {
      supported: this.isSupported(),
      autoInstallSupported: this.canAutoInstall(),
      isInstalling: this.installPromise !== null,
      installStage: this.installStage,
      installed: Boolean(binary),
      binaryPath: binary?.path ?? null,
      version: binary?.version ?? null,
      isRunning,
      isReady: isRunning && this.bootstrapped && Boolean(onionAddress),
      onionAddress,
      error: this.lastError,
    };
  }

  async start(panelPort: number): Promise<TorStatus> {
    if (!this.isSupported()) {
      throw new AppError(422, 'tor_unsupported', 'Private remote access is currently supported on Windows and Linux only.');
    }
    if (this.isRunning()) return this.getStatus();

    const binary = await this.findBinary();
    if (!binary) {
      throw new AppError(
        422,
        'tor_not_installed',
        'Tor is not installed. Install Tor Browser or the Tor Expert Bundle, then return here and enable private remote access.',
      );
    }

    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.hiddenServiceDirectory, { recursive: true, mode: 0o700 });
    // Tor stores the Onion private key here. On Unix, correct pre-existing
    // directory permissions as well as newly created ones so Tor does not
    // reject the service directory or expose key material to other users.
    if (process.platform !== 'win32') {
      await chmod(this.runtimeDirectory, 0o700);
      await chmod(this.hiddenServiceDirectory, 0o700);
    }
    await writeFile(
      this.configurationPath,
      createTorConfiguration(this.runtimeDirectory, this.hiddenServiceDirectory, panelPort),
      { encoding: 'utf8', mode: 0o600 },
    );
    if (process.platform !== 'win32') await chmod(this.configurationPath, 0o600);

    this.lastError = null;
    this.bootstrapped = false;
    this.stopping = false;
    this.outputTail = '';
    // Tor Browser's bundled binary can rely on files next to the executable
    // (notably its GeoIP data), so preserve that working directory when an
    // absolute binary path was discovered. The NodePilot config itself remains
    // absolute and continues to keep all state in the data directory.
    const workingDirectory = path.isAbsolute(binary.path) ? path.dirname(binary.path) : this.rootDirectory;
    const child = spawn(binary.path, ['-f', this.configurationPath], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.childProcess = child;

    const observeOutput = (chunk: Buffer) => {
      // A log line can be split across stream chunks, so retain a bounded tail
      // before looking for Tor's bootstrap completion message.
      const message = `${this.outputTail}${chunk.toString('utf8')}`;
      this.outputTail = message.slice(-1_024);
      if (/Bootstrapped 100%/i.test(message)) this.bootstrapped = true;
      const fatal = message.match(/\[(?:err|warn)\].*(?:fatal|failed|error)/i);
      if (fatal && !this.stopping) this.lastError = message.trim().slice(-500);
    };
    child.stdout?.on('data', observeOutput);
    child.stderr?.on('data', observeOutput);
    child.once('error', (error) => {
      if (this.childProcess === child) {
        this.childProcess = null;
        this.lastError = `Tor could not start: ${error.message}`;
      }
    });
    child.once('exit', (code, signal) => {
      if (this.childProcess === child) {
        this.childProcess = null;
        this.bootstrapped = false;
        if (!this.stopping && code !== 0) {
          this.lastError = `Tor exited unexpectedly${code === null ? '' : ` (code ${code})`}${signal ? ` (${signal})` : ''}.`;
        }
      }
    });

    // Allow Tor a moment to create its persistent key material and hostname, without
    // holding an HTTP request open for a potentially slow network bootstrap.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const status = await this.getStatus();
    if (!status.isRunning) {
      throw new AppError(502, 'tor_start_failed', status.error ?? 'Tor exited before private remote access could start.');
    }
    return status;
  }

  async stop(): Promise<TorStatus> {
    const child = this.childProcess;
    if (!child) return this.getStatus();
    if (child.exitCode !== null || child.killed) {
      this.childProcess = null;
      this.bootstrapped = false;
      return this.getStatus();
    }

    this.stopping = true;
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* process already exited */ }
        finish();
      }, 8_000);
      timeout.unref();
      child.once('exit', () => {
        clearTimeout(timeout);
        finish();
      });
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
    if (this.childProcess === child) this.childProcess = null;
    this.bootstrapped = false;
    this.stopping = false;
    return this.getStatus();
  }

  async resetAddress(panelPort: number): Promise<TorStatus> {
    const wasRunning = this.isRunning();
    await this.stop();
    await rm(this.hiddenServiceDirectory, { recursive: true, force: true });
    this.lastError = null;
    if (wasRunning) return this.start(panelPort);
    return this.getStatus();
  }
}
