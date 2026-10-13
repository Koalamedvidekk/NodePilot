import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { SqliteDatabase } from '../db.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRecord, ServerSoftware } from '../types.js';
import { inspectJar, type JarMetadata } from './jar-inspection.js';

export type AddonType = 'plugin' | 'mod';
export type AddonSource = 'modrinth' | 'hangar' | 'upload' | 'import';

export type AddonRecord = {
  type: AddonType;
  fileName: string;
  size: number;
  modifiedAt: string;
  source: AddonSource;
  projectId?: string;
  versionId?: string;
  installedAt?: string;
  metadata?: Pick<JarMetadata, 'name' | 'version' | 'software' | 'apiVersion' | 'loader'>;
  compatible: boolean;
  compatibilityMessage?: string;
};

export type AddonCatalogResult = {
  source: 'modrinth' | 'hangar';
  projectId: string;
  title: string;
  author?: string;
  description?: string;
  iconUrl?: string;
  versions: string[];
  compatible: boolean;
  compatibilityMessage?: string;
  url: string;
};

export type AddonUpdate = {
  type: AddonType;
  fileName: string;
  source: 'modrinth' | 'hangar';
  projectId: string;
  installedVersionId?: string;
  available: boolean;
  versionName?: string;
  message?: string;
};

type StoredAddon = {
  file_name: string;
  addon_type: AddonType;
  source: AddonSource;
  project_id: string | null;
  version_id: string | null;
  installed_at: string;
  updated_at: string;
};

type ModrinthSearchHit = {
  project_id?: string;
  title?: string;
  author?: string;
  description?: string;
  icon_url?: string;
  versions?: string[];
  project_type?: string;
  all_project_types?: string[];
  categories?: string[];
};

type ModrinthDependency = { project_id?: string; version_id?: string; dependency_type?: string };
type ModrinthFile = { hashes?: { sha512?: string; sha1?: string }; url?: string; filename?: string; primary?: boolean; size?: number };
type ModrinthVersion = {
  id?: string;
  name?: string;
  version_number?: string;
  files?: ModrinthFile[];
  dependencies?: ModrinthDependency[];
  game_versions?: string[];
  loaders?: string[];
};

type HangarProject = {
  name?: string;
  namespace?: { owner?: string; slug?: string };
  description?: string;
  avatarUrl?: string;
  supportedPlatforms?: { PAPER?: string[] };
};
type HangarVersion = {
  name?: string;
  downloads?: { PAPER?: { downloadUrl?: string | null; externalUrl?: string | null; fileInfo?: { size?: number; hashes?: { sha256?: string; sha1?: string } } } };
  platformDependencies?: { PAPER?: string[] };
  pluginDependencies?: { PAPER?: Array<{ projectId?: number | null; name?: string; required?: boolean }> };
  channel?: { name?: string };
};

const MODRINTH_API = 'https://api.modrinth.com/v2';
const HANGAR_API = 'https://hangar.papermc.io/api/v1';
const DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;

function stableTimeKey(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isActive(server: ServerRecord): boolean {
  return ['starting', 'running', 'stopping'].includes(server.status);
}

function compareNumericVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[._-]/).map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function requiredSoftwareForType(type: AddonType, software: ServerSoftware): string | undefined {
  if (type === 'plugin') return ['paper', 'spigot', 'purpur'].includes(software)
    ? undefined
    : 'Plugins can only be managed on a Paper server, Spigot server, or Purpur server. Vanilla and mod-loader servers do not use the Bukkit plugin API.';
  return ['fabric', 'quilt', 'forge', 'neoforge'].includes(software)
    ? undefined
    : 'Mods are only managed on Fabric, Quilt, Forge, or NeoForge servers. Bukkit plugins and loader mods are not interchangeable.';
}

/** Exported to make addon paths independently testable. Never accept a user path here. */
export function safeAddonFileName(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value !== path.basename(value) || !/\.jar$/i.test(value)) {
    throw new AppError(400, 'invalid_addon_filename', 'Add-on files must be a single .jar filename.');
  }
  const normalized = value.normalize('NFKC');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+() -]{0,180}\.jar$/i.test(normalized) || /[. ]$/.test(normalized)) {
    throw new AppError(400, 'invalid_addon_filename', 'The add-on filename contains unsupported characters.');
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.jar$/i.test(normalized)) {
    throw new AppError(400, 'invalid_addon_filename', 'This add-on filename is reserved by Windows.');
  }
  return normalized;
}

export function addonCompatibility(type: AddonType, server: Pick<ServerRecord, 'software' | 'version'>, metadata: Pick<JarMetadata, 'software' | 'apiVersion' | 'loader'>): { compatible: boolean; message?: string } {
  const supportError = requiredSoftwareForType(type, server.software);
  if (supportError) return { compatible: false, message: supportError };
  if (type === 'plugin') {
    if (metadata.software !== 'paper') return { compatible: false, message: 'This JAR does not contain a Paper/Bukkit plugin descriptor.' };
    if (metadata.apiVersion && compareNumericVersions(metadata.apiVersion, server.version) > 0) {
      return { compatible: false, message: `This plugin declares Paper API ${metadata.apiVersion}, newer than this server’s ${server.version}.` };
    }
    return { compatible: true };
  }
  if (
    metadata.software !== server.software
    && !(server.software === 'quilt' && metadata.loader === 'fabric')
  ) {
    return { compatible: false, message: `This JAR is detected as ${metadata.loader ?? metadata.software}, but the server uses ${server.software}.` };
  }
  return { compatible: true };
}

function assertNotActive(server: ServerRecord): void {
  if (isActive(server)) throw new AppError(409, 'server_active', 'Stop the server before installing, updating, uploading, or removing add-ons.');
}

function assertTypeSupported(type: AddonType, server: ServerRecord): void {
  const message = requiredSoftwareForType(type, server.software);
  if (message) throw new AppError(422, 'addon_type_unsupported', message);
}

function assertHangarCompatible(server: ServerRecord): void {
  if (!['paper', 'purpur'].includes(server.software)) {
    throw new AppError(422, 'catalog_unsupported', 'Hangar publishes Paper plugins. Use Modrinth or upload a verified Bukkit plugin for a Spigot server.');
  }
}

function trustedUrl(value: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(502, 'addon_download_invalid', 'The add-on source returned an invalid download URL.');
  }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new AppError(502, 'addon_download_untrusted', 'NodePilot refused a download from an untrusted add-on host.');
  }
  return url;
}

async function safeFetch(url: string, allowedHosts: Set<string>, init: RequestInit = {}): Promise<Response> {
  let current = trustedUrl(url, allowedHosts).toString();
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json, application/java-archive;q=0.9, */*;q=0.1', 'User-Agent': 'NodePilot/0.1 (local game server manager)', ...init.headers },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new AppError(502, 'addon_download_redirect_failed', 'The add-on source returned an invalid redirect.');
        current = trustedUrl(new URL(location, current).toString(), allowedHosts).toString();
        continue;
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AppError(502, 'addon_download_redirect_failed', 'The add-on source redirected too many times.');
}

async function readJson<T>(url: string, hosts: Set<string>): Promise<T> {
  let response: Response;
  try {
    response = await safeFetch(url, hosts);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'addon_catalog_unavailable', 'Could not reach the add-on catalogue.');
  }
  if (!response.ok) throw new AppError(502, 'addon_catalog_failed', `The add-on catalogue returned HTTP ${response.status}.`);
  try {
    return await response.json() as T;
  } catch {
    throw new AppError(502, 'addon_catalog_invalid', 'The add-on catalogue returned invalid data.');
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  checksum?: { algorithm: 'sha512' | 'sha256' | 'sha1'; value?: string },
): Promise<void> {
  const hosts = new Set(['cdn.modrinth.com', 'api.modrinth.com', 'hangar.papermc.io', 'hangarcdn.papermc.io']);
  const response = await safeFetch(url, hosts, { headers: { Accept: 'application/java-archive, application/octet-stream;q=0.9' } });
  if (!response.ok || !response.body) throw new AppError(502, 'addon_download_failed', `The add-on download returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > DOWNLOAD_LIMIT) throw new AppError(413, 'addon_too_large', 'The add-on is larger than NodePilot’s 256 MB safety limit.');
  const hash = checksum?.value ? createHash(checksum.algorithm) : undefined;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > DOWNLOAD_LIMIT) callback(new AppError(413, 'addon_too_large', 'The add-on is larger than NodePilot’s 256 MB safety limit.'));
      else {
        hash?.update(chunk);
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination, { flags: 'wx' }));
    if (!bytes) throw new AppError(502, 'addon_download_empty', 'The add-on download was empty.');
    if (checksum?.value && hash?.digest('hex').toLowerCase() !== checksum.value.toLowerCase()) {
      throw new AppError(502, 'addon_checksum_failed', 'The downloaded add-on did not match the publisher checksum.');
    }
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'addon_download_failed', `The add-on could not be downloaded: ${errorMessage(error)}`);
  }
}

function modrinthLoader(type: AddonType, server: ServerRecord): string {
  if (type === 'plugin') return server.software === 'spigot' ? 'spigot' : server.software === 'purpur' ? 'purpur' : 'paper';
  return server.software;
}

function projectIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(value)) throw new AppError(400, 'invalid_project_id', 'The selected catalogue project identifier is invalid.');
  return value;
}

function hangarIdentifier(value: string): { owner: string; slug: string } {
  const match = value.match(/^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,96})$/);
  if (!match) throw new AppError(400, 'invalid_project_id', 'The selected Hangar project identifier is invalid.');
  return { owner: match[1], slug: match[2] };
}

export class AddonService {
  constructor(
    private readonly serversDirectory: string,
    private readonly backupsDirectory: string,
    private readonly database: SqliteDatabase,
  ) {}

  private rows(serverId: string): StoredAddon[] {
    return this.database.prepare('SELECT * FROM addon_installs WHERE server_id = ?').all(serverId) as StoredAddon[];
  }

  private upsert(serverId: string, type: AddonType, fileName: string, source: AddonSource, projectId?: string, versionId?: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO addon_installs (server_id, addon_type, file_name, source, project_id, version_id, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, addon_type, file_name) DO UPDATE SET
        source = excluded.source, project_id = excluded.project_id, version_id = excluded.version_id, updated_at = excluded.updated_at
    `).run(serverId, type, fileName, source, projectId ?? null, versionId ?? null, now, now);
  }

  private deleteStored(serverId: string, type: AddonType, fileName: string): void {
    this.database.prepare('DELETE FROM addon_installs WHERE server_id = ? AND addon_type = ? AND file_name = ?').run(serverId, type, fileName);
  }

  private async serverRoot(server: ServerRecord): Promise<string> {
    return resolveManagedServerRoot(this.serversDirectory, server.directory);
  }

  private async addonDirectory(server: ServerRecord, type: AddonType, create = false): Promise<string> {
    const root = await this.serverRoot(server);
    const directory = path.join(root, type === 'plugin' ? 'plugins' : 'mods');
    if (create) {
      try {
        await mkdir(directory, { recursive: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AppError(500, 'unsafe_addon_directory', 'NodePilot refused a linked or invalid add-on directory.');
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!create) return directory;
      throw error;
    }
    return directory;
  }

  private async backupExisting(server: ServerRecord, type: AddonType, target: string): Promise<string | undefined> {
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AppError(400, 'unsafe_addon_file', 'NodePilot refused to replace a linked or non-regular add-on file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const backupDirectory = path.join(this.backupsDirectory, server.id, stableTimeKey(), type);
    await mkdir(backupDirectory, { recursive: true });
    const backup = path.join(backupDirectory, path.basename(target));
    await copyFile(target, backup, 0);
    return backup;
  }

  private async deploy(server: ServerRecord, type: AddonType, stagedPath: string, source: AddonSource, projectId?: string, versionId?: string): Promise<{ addon: AddonRecord; backup?: string }> {
    assertNotActive(server);
    assertTypeSupported(type, server);
    const metadata = await inspectJar(stagedPath);
    const fileName = safeAddonFileName(path.basename(stagedPath));
    const compatibility = addonCompatibility(type, server, metadata);
    if (!compatibility.compatible) throw new AppError(422, 'addon_incompatible', compatibility.message ?? 'The add-on is incompatible with this server.');
    const directory = await this.addonDirectory(server, type, true);
    const target = path.join(directory, fileName);
    const targetMeta = await lstat(directory);
    if (!targetMeta.isDirectory() || targetMeta.isSymbolicLink()) throw new AppError(500, 'unsafe_addon_directory', 'NodePilot refused an unsafe add-on directory.');
    const backup = await this.backupExisting(server, type, target);
    const temporary = `${target}.nodepilot-${randomUUID()}.tmp`;
    try {
      await copyFile(stagedPath, temporary, 0);
      await rm(target, { force: true });
      await rename(temporary, target);
      this.upsert(server.id, type, fileName, source, projectId, versionId);
      const details = await stat(target);
      return {
        addon: {
          type,
          fileName,
          size: details.size,
          modifiedAt: details.mtime.toISOString(),
          source,
          projectId,
          versionId,
          metadata: { name: metadata.name, version: metadata.version, software: metadata.software, apiVersion: metadata.apiVersion, loader: metadata.loader },
          compatible: true,
        },
        backup,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async list(server: ServerRecord): Promise<{ plugins: AddonRecord[]; mods: AddonRecord[]; capabilities: { plugins: boolean; mods: boolean; pluginMessage?: string; modMessage?: string } }> {
    const known = new Map(this.rows(server.id).map((row) => [`${row.addon_type}:${row.file_name.toLowerCase()}`, row]));
    const scan = async (type: AddonType): Promise<AddonRecord[]> => {
      const directory = await this.addonDirectory(server, type, false);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const records = await Promise.all(entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.jar$/i.test(entry.name))
        .map(async (entry): Promise<AddonRecord> => {
          const target = path.join(directory, entry.name);
          const [details, metadata] = await Promise.all([stat(target), inspectJar(target).catch(() => undefined)]);
          const stored = known.get(`${type}:${entry.name.toLowerCase()}`);
          const compatibility = metadata ? addonCompatibility(type, server, metadata) : { compatible: false, message: 'NodePilot could not read this JAR descriptor.' };
          return {
            type,
            fileName: entry.name,
            size: details.size,
            modifiedAt: details.mtime.toISOString(),
            source: stored?.source ?? 'import',
            projectId: stored?.project_id ?? undefined,
            versionId: stored?.version_id ?? undefined,
            installedAt: stored?.installed_at,
            metadata: metadata ? { name: metadata.name, version: metadata.version, software: metadata.software, apiVersion: metadata.apiVersion, loader: metadata.loader } : undefined,
            compatible: compatibility.compatible,
            compatibilityMessage: compatibility.message,
          };
        }));
      return records.sort((left, right) => left.fileName.localeCompare(right.fileName));
    };
    const [plugins, mods] = await Promise.all([scan('plugin'), scan('mod')]);
    const pluginMessage = requiredSoftwareForType('plugin', server.software);
    const modMessage = requiredSoftwareForType('mod', server.software);
    return { plugins, mods, capabilities: { plugins: !pluginMessage, mods: !modMessage, pluginMessage, modMessage } };
  }

  async search(server: ServerRecord, type: AddonType, source: 'modrinth' | 'hangar', query: string): Promise<AddonCatalogResult[]> {
    assertTypeSupported(type, server);
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 100) throw new AppError(400, 'invalid_addon_query', 'Enter an add-on search of up to 100 characters.');
    if (source === 'hangar') {
      if (type !== 'plugin') throw new AppError(422, 'catalog_unsupported', 'Hangar is the Paper plugin catalogue; use Modrinth to search for loader mods.');
      assertHangarCompatible(server);
      const queryString = new URLSearchParams({ platform: 'PAPER', query: normalizedQuery, limit: '20' });
      const payload = await readJson<{ result?: HangarProject[] }>(`${HANGAR_API}/projects?${queryString}`, new Set(['hangar.papermc.io']));
      return (payload.result ?? []).map((project) => {
        const owner = project.namespace?.owner;
        const slug = project.namespace?.slug;
        const supported = project.supportedPlatforms?.PAPER ?? [];
        const compatible = !supported.length || supported.includes(server.version);
        return {
          source: 'hangar' as const,
          projectId: owner && slug ? `${owner}/${slug}` : '',
          title: project.name ?? slug ?? 'Unnamed Hangar project',
          description: project.description,
          iconUrl: project.avatarUrl,
          versions: supported,
          compatible,
          compatibilityMessage: compatible ? undefined : `Hangar does not list Paper ${server.version} for this plugin.`,
          url: owner && slug ? `https://hangar.papermc.io/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}` : 'https://hangar.papermc.io/paper',
        };
      }).filter((project) => Boolean(project.projectId));
    }
    const loader = modrinthLoader(type, server);
    const projectType = type === 'plugin' ? 'plugin' : 'mod';
    const facets = JSON.stringify([
      [`all_project_types:${projectType}`],
      [`versions:${server.version}`],
      [`categories:${loader}`],
    ]);
    const queryString = new URLSearchParams({ query: normalizedQuery, facets, limit: '20', index: 'relevance' });
    const payload = await readJson<{ hits?: ModrinthSearchHit[] }>(`${MODRINTH_API}/search?${queryString}`, new Set(['api.modrinth.com']));
    return (payload.hits ?? []).map((hit) => {
      const types = hit.all_project_types ?? [hit.project_type ?? ''];
      const compatible = types.includes(projectType) && (hit.versions ?? []).includes(server.version);
      return {
        source: 'modrinth' as const,
        projectId: hit.project_id ?? '',
        title: hit.title ?? 'Unnamed Modrinth project',
        author: hit.author,
        description: hit.description,
        iconUrl: hit.icon_url,
        versions: hit.versions ?? [],
        compatible,
        compatibilityMessage: compatible ? undefined : `This project does not list ${server.version} as supported.`,
        url: `https://modrinth.com/project/${encodeURIComponent(hit.project_id ?? '')}`,
      };
    }).filter((project) => Boolean(project.projectId));
  }

  private async modrinthVersion(server: ServerRecord, type: AddonType, projectId: string): Promise<{ version: ModrinthVersion; file: ModrinthFile; missingDependencies: string[] }> {
    const identifier = projectIdentifier(projectId);
    const query = new URLSearchParams({ loaders: JSON.stringify([modrinthLoader(type, server)]), game_versions: JSON.stringify([server.version]), featured: 'true', include_changelog: 'false' });
    const versions = await readJson<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(identifier)}/version?${query}`, new Set(['api.modrinth.com']));
    const version = versions.find((candidate) => candidate.files?.some((file) => file.url && file.filename && /\.jar$/i.test(file.filename)));
    const file = version?.files?.find((candidate) => candidate.primary && candidate.url && candidate.filename && /\.jar$/i.test(candidate.filename))
      ?? version?.files?.find((candidate) => candidate.url && candidate.filename && /\.jar$/i.test(candidate.filename));
    if (!version || !file?.url || !file.filename) throw new AppError(422, 'addon_version_unavailable', `Modrinth has no compatible ${type} JAR for ${server.version} and ${modrinthLoader(type, server)}.`);
    const installed = new Set(this.rows(server.id).map((row) => row.project_id).filter((value): value is string => Boolean(value)));
    const missingDependencies = (version.dependencies ?? [])
      .filter((dependency) => dependency.dependency_type === 'required' && dependency.project_id && !installed.has(dependency.project_id))
      .map((dependency) => dependency.project_id as string);
    return { version, file, missingDependencies };
  }

  async installModrinth(server: ServerRecord, type: AddonType, projectId: string, allowMissingDependencies = false): Promise<{ addon: AddonRecord; backup?: string; missingDependencies: string[] }> {
    assertNotActive(server);
    assertTypeSupported(type, server);
    const result = await this.modrinthVersion(server, type, projectId);
    if (result.missingDependencies.length && !allowMissingDependencies) {
      throw new AppError(409, 'missing_dependencies', 'This add-on declares required dependencies that are not installed.', { missingDependencies: result.missingDependencies });
    }
    const fileName = safeAddonFileName(result.file.filename ?? 'addon.jar');
    const staging = path.join(this.backupsDirectory, '.staging');
    await mkdir(staging, { recursive: true });
    const stagedPath = path.join(staging, `${randomUUID()}-${fileName}`);
    try {
      const checksum = result.file.hashes?.sha512
        ? { algorithm: 'sha512' as const, value: result.file.hashes.sha512 }
        : result.file.hashes?.sha1 ? { algorithm: 'sha1' as const, value: result.file.hashes.sha1 } : undefined;
      if (!checksum) throw new AppError(502, 'addon_checksum_missing', 'Modrinth did not provide a checksum for this add-on file.');
      await downloadToFile(result.file.url as string, stagedPath, checksum);
      const stagedName = path.join(staging, fileName);
      await rename(stagedPath, stagedName);
      const deployed = await this.deploy(server, type, stagedName, 'modrinth', projectIdentifier(projectId), result.version.id);
      return { ...deployed, missingDependencies: result.missingDependencies };
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      await rm(path.join(staging, fileName), { force: true }).catch(() => undefined);
    }
  }

  private async hangarVersion(server: ServerRecord, projectId: string): Promise<{ version: HangarVersion; downloadUrl: string; fileName: string }> {
    const { owner, slug } = hangarIdentifier(projectId);
    const response = await readJson<{ result?: HangarVersion[] }>(`${HANGAR_API}/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions`, new Set(['hangar.papermc.io']));
    const versions = response.result ?? [];
    const candidate = versions.find((version) => {
      const download = version.downloads?.PAPER?.downloadUrl;
      const supported = version.platformDependencies?.PAPER ?? [];
      return Boolean(download) && (!supported.length || supported.includes(server.version));
    });
    const downloadUrl = candidate?.downloads?.PAPER?.downloadUrl;
    if (!candidate || !downloadUrl) {
      const external = versions.find((version) => version.downloads?.PAPER?.externalUrl)?.downloads?.PAPER?.externalUrl;
      throw new AppError(422, 'hangar_download_unavailable', external
        ? `Hangar lists this plugin’s download as an external link (${external}). Download it from the publisher and use the local JAR upload workflow.`
        : `Hangar has no direct compatible Paper download for ${server.version}.`);
    }
    const fileName = safeAddonFileName(new URL(downloadUrl).pathname.split('/').pop() || `${slug}.jar`);
    return { version: candidate, downloadUrl, fileName };
  }

  async installHangar(server: ServerRecord, projectId: string): Promise<{ addon: AddonRecord; backup?: string }> {
    assertNotActive(server);
    assertTypeSupported('plugin', server);
    assertHangarCompatible(server);
    const result = await this.hangarVersion(server, projectId);
    const staging = path.join(this.backupsDirectory, '.staging');
    await mkdir(staging, { recursive: true });
    const stagedPath = path.join(staging, `${randomUUID()}-${result.fileName}`);
    try {
      const hashes = result.version.downloads?.PAPER?.fileInfo?.hashes;
      const checksum = hashes?.sha256
        ? { algorithm: 'sha256' as const, value: hashes.sha256 }
        : hashes?.sha1 ? { algorithm: 'sha1' as const, value: hashes.sha1 } : undefined;
      await downloadToFile(result.downloadUrl, stagedPath, checksum);
      const stagedName = path.join(staging, result.fileName);
      await rename(stagedPath, stagedName);
      return await this.deploy(server, 'plugin', stagedName, 'hangar', projectId, result.version.name);
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      await rm(path.join(staging, result.fileName), { force: true }).catch(() => undefined);
    }
  }

  async installUpload(server: ServerRecord, type: AddonType, uploadPath: string, sourceName: string): Promise<{ addon: AddonRecord; backup?: string }> {
    assertNotActive(server);
    assertTypeSupported(type, server);
    const fileName = safeAddonFileName(sourceName);
    const staging = path.join(this.backupsDirectory, '.staging');
    await mkdir(staging, { recursive: true });
    const stagedPath = path.join(staging, `${randomUUID()}-${fileName}`);
    try {
      const details = await stat(uploadPath);
      if (!details.isFile() || details.size === 0 || details.size > DOWNLOAD_LIMIT) throw new AppError(413, 'addon_too_large', 'Uploaded add-ons must be non-empty JAR files up to 256 MB.');
      await copyFile(uploadPath, stagedPath, 0);
      const stagedName = path.join(staging, fileName);
      await rename(stagedPath, stagedName);
      return await this.deploy(server, type, stagedName, 'upload');
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      await rm(path.join(staging, fileName), { force: true }).catch(() => undefined);
    }
  }

  async remove(server: ServerRecord, type: AddonType, fileName: string): Promise<{ backup: string }> {
    assertNotActive(server);
    assertTypeSupported(type, server);
    const safeName = safeAddonFileName(fileName);
    const directory = await this.addonDirectory(server, type, false);
    const target = path.join(directory, safeName);
    const backup = await this.backupExisting(server, type, target);
    if (!backup) throw new AppError(404, 'addon_not_found', 'That add-on file no longer exists.');
    await rm(target, { force: false });
    this.deleteStored(server.id, type, safeName);
    return { backup };
  }

  async checkUpdates(server: ServerRecord): Promise<AddonUpdate[]> {
    const rows = this.rows(server.id).filter((row): row is StoredAddon & { source: 'modrinth' | 'hangar'; project_id: string } => Boolean(row.project_id) && (row.source === 'modrinth' || row.source === 'hangar'));
    return Promise.all(rows.map(async (row): Promise<AddonUpdate> => {
      try {
        if (row.source === 'modrinth') {
          const result = await this.modrinthVersion(server, row.addon_type, row.project_id);
          const available = Boolean(result.version.id && result.version.id !== row.version_id);
          return { type: row.addon_type, fileName: row.file_name, source: row.source, projectId: row.project_id, installedVersionId: row.version_id ?? undefined, available, versionName: result.version.version_number ?? result.version.name };
        }
        if (row.addon_type !== 'plugin') return { type: row.addon_type, fileName: row.file_name, source: row.source, projectId: row.project_id, available: false, message: 'Hangar is only used for Paper plugins.' };
        const result = await this.hangarVersion(server, row.project_id);
        const available = Boolean(result.version.name && result.version.name !== row.version_id);
        return { type: row.addon_type, fileName: row.file_name, source: row.source, projectId: row.project_id, installedVersionId: row.version_id ?? undefined, available, versionName: result.version.name };
      } catch (error) {
        return { type: row.addon_type, fileName: row.file_name, source: row.source, projectId: row.project_id, installedVersionId: row.version_id ?? undefined, available: false, message: errorMessage(error) };
      }
    }));
  }

  async update(server: ServerRecord, type: AddonType, fileName: string): Promise<{ addon: AddonRecord; backup?: string }> {
    const safeName = safeAddonFileName(fileName);
    const row = this.rows(server.id).find((item) => item.addon_type === type && item.file_name.toLowerCase() === safeName.toLowerCase());
    if (!row || !row.project_id || (row.source !== 'modrinth' && row.source !== 'hangar')) {
      throw new AppError(422, 'addon_update_unavailable', 'This add-on was not installed from a supported catalogue, so NodePilot cannot safely look up an update.');
    }
    return row.source === 'modrinth'
      ? this.installModrinth(server, type, row.project_id, true)
      : this.installHangar(server, row.project_id);
  }
}
