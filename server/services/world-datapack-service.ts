import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../lib/errors.js';
import { resolveManagedServerRoot } from '../lib/paths.js';
import { safeWorldPath } from '../lib/world-layout.js';
import { readWorldMetadata } from '../lib/world-metadata.js';
import type { ServerRecord } from '../types.js';
import type { WorldDatapack, WorldGroup, WorldMetadata } from '../world-types.js';
import { inspectSafeWorldZip, readSafeWorldZipFile, safeWorldArchivePath } from './world-archive-service.js';

const PACK_LIMITS = { compressedBytes: 256 * 1024 ** 2, expandedBytes: 512 * 1024 ** 2, entries: 20_000, ratio: 250 };
type Format = [number, number];
type PackInfo = { description: string; minimum: Format | null; maximum: Format | null; generation: boolean; experimental: boolean };
type PackLocation = { id: string; name: string; relative: string; directory: boolean };
type RuntimeInfo = { format: Format | null; builtins: Map<string, PackInfo> };

function format(value: unknown): Format | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return [value, 0];
  if (Array.isArray(value) && value.length === 1 && Number.isSafeInteger(value[0]) && value[0] >= 0) return [value[0] as number, 0];
  if (Array.isArray(value) && value.length === 2 && value.every((part) => Number.isSafeInteger(part) && part >= 0)) return [value[0] as number, value[1] as number];
  if (value && typeof value === 'object') {
    const pair = value as { major?: unknown; minor?: unknown };
    if (typeof pair.major === 'number' && Number.isSafeInteger(pair.major) && pair.major >= 0 && (pair.minor === undefined || typeof pair.minor === 'number' && Number.isSafeInteger(pair.minor) && pair.minor >= 0)) return [pair.major, Number(pair.minor ?? 0)];
  }
  return null;
}

// Since 25w31a, an integer max_format means every minor release of that
// major format. The equivalent minimum still means minor zero.
function maximumFormat(value: unknown): Format | null {
  const parsed = format(value);
  if (parsed && (typeof value === 'number' || Array.isArray(value) && value.length === 1)) parsed[1] = 2_147_483_647;
  return parsed;
}

function compare(left: Format, right: Format): number { return left[0] - right[0] || left[1] - right[1]; }
function canonical(value: string): string { return value.normalize('NFC').toLowerCase(); }
function generationFile(filename: string): boolean { return /(?:^|\/)data\/[^/]+\/(?:dimension(?:_type)?|worldgen)(?:\/|$)/i.test(filename); }
function description(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text.slice(0, 2_000);
  return value === undefined ? '' : JSON.stringify(value).slice(0, 2_000);
}

function parsePack(buffer: Buffer, filenames: string[]): PackInfo {
  if (buffer.length > 1024 * 1024) throw new AppError(413, 'datapack_metadata_too_large', 'Datapack metadata exceeds the supported limit.');
  let document: Record<string, unknown>;
  try { document = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>; }
  catch { throw new AppError(400, 'invalid_datapack', 'pack.mcmeta must contain valid JSON.'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) || !document.pack || typeof document.pack !== 'object' || Array.isArray(document.pack)) throw new AppError(400, 'invalid_datapack', 'The ZIP must contain a valid pack.mcmeta at its root.');
  const pack = document.pack as Record<string, unknown>;
  let minimum: Format | null;
  let maximum: Format | null;
  if (pack.min_format !== undefined || pack.max_format !== undefined) {
    minimum = format(pack.min_format);
    maximum = maximumFormat(pack.max_format);
  } else if (pack.supported_formats !== undefined) {
    const supported = pack.supported_formats;
    if (typeof supported === 'number') minimum = maximum = format(supported);
    else if (Array.isArray(supported) && supported.length === 2) { minimum = format(supported[0]); maximum = format(supported[1]); }
    else if (supported && typeof supported === 'object') {
      const range = supported as Record<string, unknown>;
      minimum = format(range.min_inclusive); maximum = format(range.max_inclusive);
    } else minimum = maximum = null;
  } else minimum = maximum = format(pack.pack_format);
  if (!minimum || !maximum || compare(minimum, maximum) > 0) throw new AppError(400, 'invalid_datapack_format', 'The datapack must declare a supported pack format or valid minimum/maximum formats.');
  let experimental = false;
  if (document.features !== undefined) {
    const features = document.features as { enabled?: unknown } | null;
    if (!features || typeof features !== 'object' || Array.isArray(features) || !Array.isArray(features.enabled)
      || features.enabled.length > 128 || features.enabled.some((flag) => typeof flag !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(flag))) throw new AppError(400, 'invalid_datapack_features', 'Experimental datapack feature flags must be a bounded list of namespaced identifiers.');
    experimental = features.enabled.length > 0;
  }
  return { description: description(pack.description), minimum, maximum, generation: filenames.some(generationFile) || document.features !== undefined || document.filter !== undefined, experimental };
}

export class WorldDatapackService {
  private readonly formats = new Map<string, { time: number; value: RuntimeInfo }>();
  constructor(private readonly serversDirectory: string) {}

  private async root(server: ServerRecord): Promise<string> { return resolveManagedServerRoot(this.serversDirectory, server.directory); }

  private async locations(root: string, group: WorldGroup): Promise<PackLocation[]> {
    const relative = group.folder + '/datapacks';
    let directory: string;
    try { directory = await safeWorldPath(root, relative); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT' || (error as AppError).code === 'world_path_missing') return []; throw error; }
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return [];
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError(409, 'unsafe_datapack_directory', 'The world datapacks path must be a regular directory.');
    const names = await readdir(directory);
    if (names.length > 500) throw new AppError(413, 'too_many_datapacks', 'This world contains more than 500 datapack entries.');
    const seen = new Set<string>();
    const result: PackLocation[] = [];
    for (const name of names) {
      safeWorldArchivePath(name);
      if (seen.has(canonical(name))) throw new AppError(409, 'datapack_name_collision', 'Datapack names collide on Windows. Rename the conflicting files first.');
      seen.add(canonical(name));
      const packRelative = relative + '/' + name;
      const target = await safeWorldPath(root, packRelative);
      const details = await lstat(target);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) throw new AppError(409, 'unsafe_datapack', 'Datapack links and special files are not supported.');
      if (!details.isDirectory() && !name.toLowerCase().endsWith('.zip')) continue;
      result.push({ id: 'file/' + name, name, relative: packRelative, directory: details.isDirectory() });
    }
    return result;
  }

  private async unpackedInfo(root: string, location: PackLocation): Promise<PackInfo> {
    const entries: string[] = [];
    let bytes = 0;
    const walk = async (relative: string) => {
      const absolute = await safeWorldPath(root, relative);
      const details = await lstat(absolute);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) throw new AppError(409, 'unsafe_datapack', 'Datapack links and special files are not supported.');
      if (entries.length >= PACK_LIMITS.entries) throw new AppError(413, 'datapack_too_large', 'The datapack contains too many files.');
      entries.push(relative.slice(location.relative.length + 1));
      if (details.isDirectory()) for (const name of await readdir(absolute)) { safeWorldArchivePath(name); await walk(relative + '/' + name); }
      else { bytes += details.size; if (bytes > PACK_LIMITS.expandedBytes) throw new AppError(413, 'datapack_too_large', 'The datapack exceeds the expanded size limit.'); }
    };
    await walk(location.relative);
    const metadataPath = await safeWorldPath(root, location.relative + '/pack.mcmeta');
    if ((await lstat(metadataPath)).size > 1024 * 1024) throw new AppError(413, 'datapack_metadata_too_large', 'pack.mcmeta is too large.');
    return parsePack(await readFile(metadataPath), entries);
  }

  private async zipInfo(filename: string): Promise<PackInfo> {
    const entries = await inspectSafeWorldZip(filename, PACK_LIMITS);
    if (!entries.some((entry) => entry.name === 'pack.mcmeta' && !entry.directory)) throw new AppError(400, 'invalid_datapack', 'Upload a datapack ZIP containing pack.mcmeta at its root, without an extra wrapper folder.');
    if (!entries.some((entry) => entry.name.startsWith('data/'))) throw new AppError(400, 'invalid_datapack', 'The ZIP must contain datapack data, rather than a resource pack or mod.');
    return parsePack(await readSafeWorldZipFile(filename, 'pack.mcmeta'), entries.map((entry) => entry.name));
  }

  private async runtimeInfo(server: ServerRecord, root: string): Promise<RuntimeInfo> {
    const key = server.id + ':' + server.version;
    const previous = this.formats.get(key);
    if (previous && Date.now() - previous.time < (previous.value.format ? 5 * 60_000 : 10_000)) return previous.value;
    const candidates = new Set<string>(['server.jar']);
    if (server.startupConfig.mode === 'jar') candidates.add(server.startupConfig.jarPath);
    const roots = ['versions', 'cache', 'libraries/net/minecraft/server', '.fabric/server', '.quilt/server'];
    let scanned = 0;
    const scan = async (relative: string, depth: number) => {
      if (depth > 4 || candidates.size >= 48 || scanned >= 2_500) return;
      let absolute: string;
      try { absolute = await safeWorldPath(root, relative); } catch { return; }
      const details = await lstat(absolute);
      if (!details.isDirectory()) return;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        scanned += 1;
        if (scanned > 2_500 || candidates.size >= 48) return;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await scan(relative + '/' + entry.name, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) candidates.add(relative + '/' + entry.name);
      }
    };
    for (const relative of roots) await scan(relative, 0);
    const value: RuntimeInfo = { format: null, builtins: new Map() };
    for (const relative of candidates) {
      try {
        const filename = await safeWorldPath(root, relative);
        const details = await lstat(filename);
        if (!details.isFile() || details.isSymbolicLink() || details.size > 512 * 1024 ** 2) continue;
        const version = JSON.parse((await readSafeWorldZipFile(filename, 'version.json', 128 * 1024)).toString('utf8')) as { id?: string; name?: string; pack_version?: number | { data?: unknown; data_major?: unknown; data_minor?: unknown } };
        if (version.id !== server.version && version.name !== server.version) continue;
        const versions = version.pack_version;
        const candidateFormat = typeof versions === 'number' ? format(versions) : versions && versions.data_major !== undefined
          ? format([versions.data_major, versions.data_minor ?? 0]) : format(versions?.data);
        if (!candidateFormat) continue;
        if (value.format && compare(value.format, candidateFormat) !== 0) {
          // Conflicting runtime caches for the same version are not authoritative.
          value.format = null;
          value.builtins.clear();
          break;
        }
        value.format = candidateFormat;
        const entries = await inspectSafeWorldZip(filename, { compressedBytes: 512 * 1024 ** 2, expandedBytes: 1024 * 1024 ** 2, entries: 100_000, ratio: 250 });
        for (const entry of entries) {
          const match = /^data\/minecraft\/datapacks\/([a-z0-9_.-]+)\/pack\.mcmeta$/.exec(entry.name);
          if (!match || match[1] === 'vanilla' || entry.directory) continue;
          const prefix = entry.name.slice(0, -'pack.mcmeta'.length);
          try {
            const info = parsePack(await readSafeWorldZipFile(filename, entry.name), entries.filter((file) => file.name.startsWith(prefix)).map((file) => file.name.slice(prefix.length)));
            if (info.experimental) value.builtins.set(match[1], { ...info, generation: true });
          } catch { /* An unrecognized embedded pack is never offered for activation. */ }
        }
      } catch { /* A launcher without vanilla version.json is not authoritative. */ }
    }
    this.formats.set(key, { time: Date.now(), value });
    return value;
  }

  private async runtimeFormat(server: ServerRecord, root: string): Promise<Format | null> { return (await this.runtimeInfo(server, root)).format; }

  private async describe(server: ServerRecord, root: string, location: PackLocation, metadata: WorldMetadata, runtime: Format | null): Promise<WorldDatapack> {
    let pack: PackInfo;
    try { pack = location.directory ? await this.unpackedInfo(root, location) : await this.zipInfo(await safeWorldPath(root, location.relative)); }
    catch (error) {
      return { id: location.id, name: location.name, description: '', enabled: metadata.enabledPacks.includes(location.id), compatible: false, managed: false, generationPack: true, reason: error instanceof Error ? error.message : 'The datapack could not be inspected.', removable: false };
    }
    const compatible = runtime ? compare(runtime, pack.minimum!) >= 0 && compare(runtime, pack.maximum!) <= 0 : null;
    const reason = compatible === null ? 'The installed Minecraft runtime does not expose a verifiable datapack format. Compatibility could not be confirmed.'
      : !compatible ? 'This datapack does not declare support for the installed Minecraft data format.'
      : pack.generation && metadata.generated ? 'World-generation, dimension and experimental packs cannot be changed after this world has been generated.' : null;
    return { id: location.id, name: location.name.replace(/\.zip$/i, ''), description: pack.description, enabled: metadata.enabledPacks.includes(location.id), compatible, managed: false, generationPack: pack.generation, reason, removable: !(pack.generation && metadata.generated) };
  }

  async list(server: ServerRecord, group: WorldGroup, metadata: WorldMetadata): Promise<WorldDatapack[]> {
    const root = await this.root(server);
    const locations = await this.locations(root, group);
    const runtimeInfo = await this.runtimeInfo(server, root);
    const runtime = runtimeInfo.format;
    const packs: WorldDatapack[] = [{ id: 'vanilla', name: 'Vanilla', description: 'Required base Minecraft content.', enabled: metadata.enabledPacks.includes('vanilla') || !metadata.generated, compatible: true, managed: true, generationPack: true, reason: 'Vanilla is required and cannot be disabled or removed.', removable: false }];
    for (const [id, info] of runtimeInfo.builtins) {
      const compatible = runtime ? compare(runtime, info.minimum!) >= 0 && compare(runtime, info.maximum!) <= 0 : false;
      packs.push({ id, name: id.replace(/_/g, ' '), description: info.description, enabled: metadata.enabledPacks.includes(id), compatible, managed: false, generationPack: true, removable: false,
        reason: !compatible ? 'This built-in pack does not declare support for the installed runtime format.' : metadata.generated ? 'Built-in experimental pack. Its selection is locked after generation and it cannot be removed.' : 'Built-in experimental pack verified in the installed runtime. Choose it before generation; it cannot be removed.' });
    }
    for (const location of locations) packs.push(await this.describe(server, root, location, metadata, runtime));
    for (const id of new Set([...metadata.enabledPacks, ...metadata.disabledPacks])) {
      if (packs.some((pack) => pack.id === id)) continue;
      packs.push({ id, name: id, description: '', enabled: metadata.enabledPacks.includes(id), compatible: null, managed: !id.startsWith('file/'), generationPack: true,
        reason: id.startsWith('file/') ? 'This referenced datapack file is missing.' : 'Provided by the server software or an experimental feature; its selection is preserved.', removable: false });
    }
    return packs;
  }

  async upload(server: ServerRecord, group: WorldGroup, archivePath: string, filename: string): Promise<string> {
    safeWorldArchivePath(filename);
    if (filename.includes('/') || filename.length > 128 || !/\.zip$/i.test(filename)) throw new AppError(400, 'invalid_datapack_filename', 'Choose a portable .zip filename without a directory path.');
    const root = await this.root(server);
    const info = await this.zipInfo(archivePath);
    const runtime = await this.runtimeFormat(server, root);
    if (!runtime) throw new AppError(422, 'datapack_compatibility_unknown', 'Compatibility cannot be confirmed because the installed runtime does not expose a Minecraft datapack format. Start this server once to create its runtime cache, then stop it and retry.');
    if (compare(runtime, info.minimum!) < 0 || compare(runtime, info.maximum!) > 0) throw new AppError(422, 'datapack_incompatible', 'This datapack does not declare support for this Minecraft version.');
    const metadata = await readWorldMetadata(root, group);
    if (metadata.generated && info.generation) throw new AppError(409, 'world_generation_pack_locked', 'World-generation, dimension and experimental packs must be chosen before generation.');
    const directory = await safeWorldPath(root, group.folder + '/datapacks', true);
    await mkdir(directory, { recursive: true });
    if ((await readdir(directory)).some((name) => canonical(name) === canonical(filename))) throw new AppError(409, 'datapack_exists', 'A datapack with that filename already exists. Nothing was overwritten.');
    await copyFile(archivePath, await safeWorldPath(root, group.folder + '/datapacks/' + filename, true), constants.COPYFILE_EXCL);
    return 'file/' + filename;
  }

  async resolvePackPath(server: ServerRecord, group: WorldGroup, packId: string): Promise<string> {
    const root = await this.root(server);
    const location = (await this.locations(root, group)).find((pack) => pack.id === packId);
    if (!location) throw new AppError(404, 'datapack_not_found', 'The uploaded datapack does not exist in this world.');
    await safeWorldPath(root, location.relative);
    return location.relative;
  }

  async remove(server: ServerRecord, group: WorldGroup, packId: string): Promise<void> {
    const root = await this.root(server);
    const metadata = await readWorldMetadata(root, group);
    const pack = (await this.list(server, group, metadata)).find((value) => value.id === packId);
    if (!pack || pack.managed) throw new AppError(403, 'datapack_managed', 'Built-in and software-managed datapacks cannot be removed.');
    if (!pack.removable) throw new AppError(409, 'world_generation_pack_locked', pack.reason ?? 'This datapack cannot be removed safely.');
    const relative = await this.resolvePackPath(server, group, packId);
    await rm(await safeWorldPath(root, relative), { recursive: true, force: false });
  }

  async validateSelection(server: ServerRecord, group: WorldGroup, metadata: WorldMetadata, enabled: string[], disabled: string[]): Promise<void> {
    if (enabled.length > 500 || disabled.length > 500 || new Set(enabled).size !== enabled.length || new Set(disabled).size !== disabled.length || enabled.some((id) => disabled.includes(id))) throw new AppError(400, 'invalid_datapack_selection', 'Datapack selections contain duplicates, conflicting entries or too many packs.');
    if (!enabled.includes('vanilla') || disabled.includes('vanilla')) throw new AppError(400, 'vanilla_datapack_required', 'The Vanilla datapack must remain enabled.');
    const packs = await this.list(server, group, metadata);
    for (const id of [...enabled, ...disabled]) if (!packs.some((pack) => pack.id === id)) throw new AppError(400, 'unknown_datapack', 'Choose a datapack listed for this world.');
    for (const pack of packs) {
      const selected = enabled.includes(pack.id);
      if (pack.managed && pack.id !== 'vanilla' && selected !== pack.enabled) throw new AppError(409, 'datapack_managed', 'Software-managed datapack selections must remain unchanged.');
      if (selected !== pack.enabled && pack.generationPack && metadata.generated) throw new AppError(409, 'world_generation_pack_locked', 'World-generation, dimension and experimental packs cannot be changed after generation.');
      if (selected && !pack.managed && pack.compatible !== true && !pack.enabled) throw new AppError(422, 'datapack_incompatible', pack.reason ?? 'This datapack is not confirmed compatible.');
    }
  }

  async copySelection(server: ServerRecord, sourceGroup: WorldGroup, targetGroup: WorldGroup, packIds: string[]): Promise<void> {
    const root = await this.root(server);
    const metadata = await readWorldMetadata(root, sourceGroup);
    const packs = await this.list(server, sourceGroup, metadata);
    const builtins = (await this.runtimeInfo(server, root)).builtins;
    if (new Set(packIds).size !== packIds.length) throw new AppError(400, 'invalid_datapack_selection', 'Choose each datapack only once.');
    for (const id of packIds) {
      if (id === 'vanilla') continue;
      const pack = packs.find((value) => value.id === id);
      if (pack?.managed && pack.enabled) continue; // The same software supplies this pack on the next start.
      if (!pack || pack.managed || pack.compatible !== true) throw new AppError(422, 'datapack_incompatible', 'Only uploaded, confirmed-compatible datapacks can be copied into a new world.');
      if (builtins.has(id)) continue; // Minecraft supplies verified built-ins; no filesystem copy is needed.
      const location = (await this.locations(root, sourceGroup)).find((value) => value.id === id)!;
      if (location.directory) throw new AppError(422, 'datapack_zip_required', 'Upload a ZIP copy of this unpacked datapack before selecting it for a new world.');
      const destinationDirectory = await safeWorldPath(root, targetGroup.folder + '/datapacks', true);
      await mkdir(destinationDirectory, { recursive: true });
      if ((await readdir(destinationDirectory)).some((name) => canonical(name) === canonical(location.name))) throw new AppError(409, 'datapack_exists', 'The new world already contains this datapack filename.');
      await copyFile(await safeWorldPath(root, location.relative), await safeWorldPath(root, targetGroup.folder + '/datapacks/' + location.name, true), constants.COPYFILE_EXCL);
    }
  }
}
