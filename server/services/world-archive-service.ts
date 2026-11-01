import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';

import { AppError } from '../lib/errors.js';
import { isInside, resolveManagedServerRoot } from '../lib/paths.js';
import { resolveWorldGroup, safeWorldPath } from '../lib/world-layout.js';
import { readWorldMetadata } from '../lib/world-metadata.js';
import type { ServerRecord, ServerSoftware } from '../types.js';
import type { WorldGroup, WorldImportCandidate, WorldImportInspection, WorldLayout } from '../world-types.js';

export const WORLD_ARCHIVE_LIMITS = { compressedBytes: 4 * 1024 ** 3, expandedBytes: 32 * 1024 ** 3, entries: 100_000, ratio: 250 };
const TREE_BYTES = 64 * 1024 ** 3;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const LAYOUTS = new Set<WorldLayout>(['legacy-java', 'legacy-paper', 'modern-java', 'modern-paper', 'unknown']);
type ZipLimits = typeof WORLD_ARCHIVE_LIMITS;
export interface SafeWorldZipEntry { name: string; directory: boolean; size: number; compressedSize: number }
type TreeEntry = { relative: string; absolute: string; directory: boolean; size: number; mode: number };
type Progress = (processed: number, total: number) => void;
const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function updateCrc(crc: number, chunk: Buffer): number {
  for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return crc >>> 0;
}
async function ensureAvailableSpace(directory: string, bytes: number): Promise<void> {
  try {
    const info = await statfs(directory);
    if (info.bavail * info.bsize < bytes + 64 * 1024 ** 2) throw new AppError(507, 'world_insufficient_space', 'There is not enough free disk space for this world operation and its safety margin.');
  } catch (error) {
    if (error instanceof AppError || !['ENOSYS', 'ENOTSUP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}
interface BundleManifest {
  schemaVersion: 1;
  format: 'nodepilot-world';
  folder: string;
  members: string[];
  layout: WorldLayout;
  software: ServerSoftware;
  minecraftVersion: string;
}
interface StoredCandidate { id: string; base: string; group: WorldGroup }
interface StoredInspection { serverId: string; inspection: WorldImportInspection; candidates: StoredCandidate[]; archivePath: string }

/** ZIP names must be portable on Windows and Linux; aliases cannot overwrite another entry. */
export function safeWorldArchivePath(input: string): string {
  const value = input.endsWith('/') ? input.slice(0, -1) : input;
  if (!value || value.length > 2048 || value.includes('\\') || value.startsWith('/') || /[<>:"|?*\x00-\x1f\x7f]/.test(value)) {
    throw new AppError(400, 'unsafe_world_archive', 'The ZIP contains an unsafe or nonportable path.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || RESERVED.test(part) || ['.git', '.nodepilot', 'node_modules', '.env'].includes(part.toLowerCase()))) {
    throw new AppError(400, 'unsafe_world_archive', 'The ZIP contains an unsafe or protected path.');
  }
  return value;
}

function canonical(value: string): string { return value.normalize('NFC').toLowerCase(); }

function openZip(filename: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error || !zip ? reject(error ?? new Error('Cannot open ZIP.')) : resolve(zip)));
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<import('node:stream').Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('Cannot read ZIP entry.')) : resolve(stream)));
}

async function eachZipEntry(filename: string, action: (zip: yauzl.ZipFile, entry: yauzl.Entry) => Promise<void>): Promise<void> {
  const zip = await openZip(filename);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.on('entry', (entry: yauzl.Entry) => {
      void action(zip, entry).then(() => { if (!settled) zip.readEntry(); }, fail);
    });
    zip.readEntry();
  });
}

export async function inspectSafeWorldZip(filename: string, limits: ZipLimits = WORLD_ARCHIVE_LIMITS): Promise<SafeWorldZipEntry[]> {
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink()) throw new AppError(400, 'unsafe_world_archive', 'Upload a regular ZIP file.');
  if (details.size > limits.compressedBytes) throw new AppError(413, 'world_archive_too_large', 'The uploaded ZIP exceeds the supported compressed size.');
  const entries: SafeWorldZipEntry[] = [];
  const names = new Map<string, boolean>();
  const parents = new Set<string>();
  let expanded = 0;
  let compressed = 0;
  await eachZipEntry(filename, async (_zip, entry) => {
    const name = safeWorldArchivePath(entry.fileName);
    const key = canonical(name);
    const directory = entry.fileName.endsWith('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if ((entry.generalPurposeBitFlag & 1) !== 0 || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) || (directory && mode === 0o100000) || (!directory && mode === 0o040000)) {
      throw new AppError(400, 'unsafe_world_archive', 'Encrypted ZIP entries, links and special files are not supported.');
    }
    if (names.has(key)) throw new AppError(400, 'duplicate_world_archive_path', 'The ZIP contains duplicate paths or names that collide on Windows.');
    for (let parent = path.posix.dirname(key); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (names.get(parent) === false) throw new AppError(400, 'duplicate_world_archive_path', 'A ZIP file conflicts with a directory path.');
      parents.add(parent);
    }
    if (!directory && parents.has(key)) throw new AppError(400, 'duplicate_world_archive_path', 'A ZIP file conflicts with a directory path.');
    names.set(key, directory);
    expanded += entry.uncompressedSize;
    compressed += entry.compressedSize;
    if (entries.length >= limits.entries || expanded > limits.expandedBytes || expanded > Math.max(1, compressed) * limits.ratio) {
      throw new AppError(413, 'world_archive_expansion_limit', 'The ZIP exceeds the file-count, expanded-size or compression-ratio limit.');
    }
    entries.push({ name, directory, size: entry.uncompressedSize, compressedSize: entry.compressedSize });
  });
  if (entries.length === 0) throw new AppError(400, 'empty_world_archive', 'The ZIP archive is empty.');
  return entries;
}

export async function readSafeWorldZipFile(filename: string, entryName: string, maxBytes = 1024 * 1024): Promise<Buffer> {
  let result: Buffer | undefined;
  await eachZipEntry(filename, async (zip, entry) => {
    if (safeWorldArchivePath(entry.fileName) !== entryName || entry.fileName.endsWith('/')) return;
    if (entry.uncompressedSize > maxBytes) throw new AppError(413, 'world_metadata_too_large', 'The ZIP metadata file is too large.');
    const source = await entryStream(zip, entry);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let crc = 0xffffffff;
    for await (const value of source as AsyncIterable<Buffer>) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      crc = updateCrc(crc, chunk);
      if (bytes > maxBytes) throw new AppError(413, 'world_metadata_too_large', 'The ZIP metadata file is too large.');
      chunks.push(chunk);
    }
    if (bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) throw new AppError(400, 'world_archive_checksum_failed', 'The ZIP contains corrupt file data. Upload a complete archive again.');
    result = Buffer.concat(chunks);
  });
  if (!result) throw new AppError(400, 'world_metadata_missing', 'The required metadata file is missing from the ZIP.');
  return result;
}

async function extractZip(filename: string, destination: string, expected: SafeWorldZipEntry[], progress?: Progress): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const expectedEntries = new Map(expected.map((entry) => [entry.name, entry]));
  let expanded = 0;
  const total = expected.reduce((sum, entry) => sum + entry.size, 0);
  progress?.(0, total);
  await eachZipEntry(filename, async (zip, entry) => {
    const relative = safeWorldArchivePath(entry.fileName);
    const checked = expectedEntries.get(relative);
    if (!checked || checked.size !== entry.uncompressedSize || checked.directory !== entry.fileName.endsWith('/')) throw new AppError(409, 'world_archive_changed', 'The ZIP changed after inspection. Upload it again.');
    expectedEntries.delete(relative);
    const target = path.join(destination, ...relative.split('/'));
    if (!isInside(destination, target)) throw new AppError(400, 'unsafe_world_archive', 'The ZIP would escape its staging directory.');
    if (checked.directory) { await mkdir(target, { recursive: true }); return; }
    await mkdir(path.dirname(target), { recursive: true });
    let bytes = 0;
    let crc = 0xffffffff;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      expanded += chunk.length;
      crc = updateCrc(crc, chunk);
      progress?.(expanded, total);
      callback(bytes > checked.size || expanded > WORLD_ARCHIVE_LIMITS.expandedBytes ? new AppError(413, 'world_archive_expansion_limit', 'The expanded ZIP exceeds its declared size.') : null, chunk);
    } });
    await pipeline(await entryStream(zip, entry), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if (bytes !== checked.size) throw new AppError(400, 'world_archive_changed', 'The ZIP contains a truncated entry.');
    if (((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) throw new AppError(400, 'world_archive_checksum_failed', 'The ZIP contains corrupt file data. Upload a complete archive again.');
  });
  if (expectedEntries.size) throw new AppError(409, 'world_archive_changed', 'The ZIP changed after inspection. Upload it again.');
}

async function exists(filename: string): Promise<boolean> {
  return lstat(filename).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
}

async function scanTree(root: string, members: string[]): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  const walk = async (relative: string) => {
    safeWorldArchivePath(relative);
    const absolute = await safeWorldPath(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new AppError(409, 'unsafe_world_file', 'World operations refuse linked and special files.');
    const key = canonical(relative);
    if (seen.has(key)) throw new AppError(409, 'overlapping_world_members', 'World directories overlap or collide.');
    seen.add(key);
    bytes += info.isFile() ? info.size : 0;
    if (entries.length >= WORLD_ARCHIVE_LIMITS.entries || bytes > TREE_BYTES) throw new AppError(413, 'world_too_large', 'This world exceeds the supported 100,000-entry or 64 GB limit.');
    entries.push({ relative, absolute, directory: info.isDirectory(), size: info.isFile() ? info.size : 0, mode: info.mode });
    if (info.isDirectory()) for (const entry of await readdir(absolute)) await walk(relative + '/' + entry);
  };
  for (const member of members) { safeWorldArchivePath(member); await walk(member); }
  return entries;
}

function bundle(server: ServerRecord, group: WorldGroup): BundleManifest {
  return { schemaVersion: 1, format: 'nodepilot-world', folder: group.folder, members: [...group.members], layout: group.layout, software: server.software, minecraftVersion: server.version };
}

async function readManifest(directory: string): Promise<BundleManifest> {
  const file = await safeWorldPath(directory, 'nodepilot-world.json');
  const info = await lstat(file);
  if (!info.isFile() || info.size > 128 * 1024) throw new AppError(400, 'invalid_world_bundle', 'The world bundle manifest is invalid.');
  let value: Partial<BundleManifest>;
  try { value = JSON.parse(await readFile(file, 'utf8')) as Partial<BundleManifest>; }
  catch { throw new AppError(400, 'invalid_world_bundle', 'The world bundle manifest is not valid JSON.'); }
  if (value.schemaVersion !== 1 || value.format !== 'nodepilot-world' || typeof value.folder !== 'string' || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 64 || !value.members.every((member) => typeof member === 'string') || !LAYOUTS.has(value.layout as WorldLayout) || typeof value.minecraftVersion !== 'string' || typeof value.software !== 'string') {
    throw new AppError(400, 'invalid_world_bundle', 'The world bundle manifest has unsupported fields.');
  }
  safeWorldArchivePath(value.folder);
  for (const member of value.members) safeWorldArchivePath(member);
  if (!value.members.includes(value.folder) || new Set(value.members.map(canonical)).size !== value.members.length) throw new AppError(400, 'invalid_world_bundle', 'The world bundle has invalid member directories.');
  return value as BundleManifest;
}

async function copyEntries(entries: TreeEntry[], destination: string, progress?: Progress): Promise<{ sizeBytes: number }> {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let copied = 0;
  progress?.(0, total);
  for (const entry of entries) {
    const target = path.join(destination, ...entry.relative.split('/'));
    if (!isInside(destination, target)) throw new AppError(409, 'unsafe_world_file', 'A world path escapes its destination.');
    if (entry.directory) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(entry.absolute, target, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') await chmod(target, entry.mode & 0o777);
      copied += entry.size;
      progress?.(copied, total);
    }
  }
  return { sizeBytes: total };
}

export class WorldArchiveService {
  constructor(private readonly config: { serversDirectory: string; dataDirectory: string; backupsDirectory: string }, private readonly ensureSpace = ensureAvailableSpace) {}

  private async root(server: ServerRecord): Promise<string> { return resolveManagedServerRoot(this.config.serversDirectory, server.directory); }

  private inspectionDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'world_import_not_found', 'The world inspection does not exist.');
    return path.join(this.config.dataDirectory, 'worlds', 'imports', id);
  }

  async inspect(server: ServerRecord, archivePath: string, onProgress?: Progress): Promise<WorldImportInspection> {
    const entries = await inspectSafeWorldZip(archivePath);
    const id = randomUUID();
    const directory = this.inspectionDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const payload = path.join(directory, 'archive');
    try {
      await this.ensureSpace(directory, (await lstat(archivePath)).size + entries.reduce((sum, entry) => sum + entry.size, 0));
      // Retain the source upload for preview/retry, rather than consuming it.
      await copyFile(archivePath, path.join(directory, 'source.zip'), constants.COPYFILE_EXCL);
      await extractZip(path.join(directory, 'source.zip'), payload, entries, onProgress);
      const candidates: StoredCandidate[] = [];
      const summaries: WorldImportCandidate[] = [];
      const manifestFile = path.join(payload, 'nodepilot-world.json');
      if (await exists(manifestFile)) {
        const manifest = await readManifest(payload);
        const base = await safeWorldPath(payload, 'content');
        const group = await resolveWorldGroup(base, manifest.folder, manifest.software, manifest.minecraftVersion);
        if (canonical(group.folder) !== canonical(manifest.folder) || group.members.some((member) => !manifest.members.includes(member))) throw new AppError(400, 'invalid_world_bundle', 'World bundle members do not match its layout.');
        group.members = [...manifest.members];
        await scanTree(base, group.members);
        const metadata = await readWorldMetadata(base, group);
        if (!metadata.generated || metadata.readOnlyReason || group.readOnlyReason) throw new AppError(400, 'invalid_world_metadata', metadata.readOnlyReason ?? group.readOnlyReason ?? 'This bundle does not contain a generated world.');
        const candidateId = randomUUID();
        candidates.push({ id: candidateId, base, group });
        summaries.push({ id: candidateId, name: path.posix.basename(group.folder), layout: group.layout, minecraftVersion: metadata.minecraftVersion, seed: metadata.seed, dimensions: group.dimensions, warnings: [...metadata.warnings, ...(manifest.software !== server.software ? ['This bundle was exported from ' + manifest.software + '; review software and datapack compatibility before activation.'] : [])] });
      } else {
        const worldFolders = entries.filter((entry) => !entry.directory && path.posix.basename(entry.name) === 'level.dat')
          .map((entry) => path.posix.dirname('archive/' + entry.name))
          .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
        const consumed: string[] = [];
        for (const folder of [...new Set(worldFolders)]) {
          if (consumed.some((member) => folder === member || folder.startsWith(member + '/'))) continue;
          if (/(?:_nether|_the_end)$/.test(folder) && worldFolders.includes(folder.replace(/(?:_nether|_the_end)$/, ''))) continue;
          const group = await resolveWorldGroup(directory, folder, server.software, server.version);
          const metadata = await readWorldMetadata(directory, group);
          if (!metadata.generated || metadata.readOnlyReason || group.readOnlyReason) continue;
          consumed.push(...group.members);
          const candidateId = randomUUID();
          candidates.push({ id: candidateId, base: directory, group });
          summaries.push({ id: candidateId, name: folder === 'archive' ? 'Imported world' : path.posix.basename(folder), layout: group.layout, minecraftVersion: metadata.minecraftVersion, seed: metadata.seed, dimensions: group.dimensions, warnings: metadata.warnings });
        }
      }
      if (!candidates.length) throw new AppError(400, 'world_not_found_in_archive', 'No supported world with valid level.dat metadata was found in this ZIP.');
      const inspection: WorldImportInspection = { id, candidates: summaries, fileCount: entries.filter((entry) => !entry.directory).length, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0), warnings: candidates.length > 1 ? ['This ZIP contains multiple world groups. Select one to import.'] : [] };
      const stored: StoredInspection = { serverId: server.id, inspection, candidates, archivePath: path.join(directory, 'source.zip') };
      await writeFile(path.join(directory, 'inspection.json'), JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
      return inspection;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async importWorld(server: ServerRecord, inspectionId: string, candidateId: string, newFolder: string, onProgress?: Progress): Promise<WorldGroup> {
    const directory = this.inspectionDirectory(inspectionId);
    const storedFile = await safeWorldPath(directory, 'inspection.json');
    const stored = JSON.parse(await readFile(storedFile, 'utf8')) as StoredInspection;
    if (stored.serverId !== server.id) throw new AppError(404, 'world_import_not_found', 'The world inspection does not exist for this server.');
    const candidate = stored.candidates.find((value) => value.id === candidateId);
    if (!candidate || !isInside(await realpath(directory), await realpath(candidate.base))) throw new AppError(404, 'world_import_candidate_not_found', 'Choose a world from this inspection.');
    safeWorldArchivePath(newFolder);
    const root = await this.root(server);
    const mapMember = (member: string): string => {
      if (member === candidate.group.folder) return newFolder;
      for (const suffix of ['_nether', '_the_end']) if (member === candidate.group.folder + suffix) return newFolder + suffix;
      throw new AppError(409, 'unsupported_world_group', 'This world has unrecognized external dimension directories and cannot be imported automatically.');
    };
    const mapping = candidate.group.members.map((member) => ({ member, target: mapMember(member) }));
    for (const item of mapping) if (await exists(await safeWorldPath(root, item.target, true))) throw new AppError(409, 'world_target_exists', 'The target world directory already exists. Nothing was overwritten.');
    const copied: string[] = [];
    try {
      const entries = await scanTree(candidate.base, candidate.group.members);
      const total = entries.reduce((sum, entry) => sum + entry.size, 0);
      await this.ensureSpace(root, total);
      let copiedBytes = 0;
      onProgress?.(0, total);
      for (const item of mapping) {
        const destination = await safeWorldPath(root, item.target, true);
        await mkdir(destination, { recursive: false, mode: 0o700 });
        copied.push(destination);
        const subset = entries.filter((entry) => entry.relative.startsWith(item.member + '/')).map((entry) => ({ ...entry, relative: entry.relative.slice(item.member.length + 1) }));
        const result = await copyEntries(subset, destination, (processed) => onProgress?.(copiedBytes + processed, total));
        copiedBytes += result.sizeBytes;
      }
      return await resolveWorldGroup(root, newFolder, server.software, server.version);
    } catch (error) {
      for (const target of copied) await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async measureWorld(server: ServerRecord, group: WorldGroup): Promise<{ sizeBytes: number }> {
    const entries = await scanTree(await this.root(server), group.members);
    return { sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
  }

  private async safeDestination(destination: string): Promise<string> {
    const resolved = path.resolve(destination);
    const allowed = [path.resolve(this.config.dataDirectory), path.resolve(this.config.backupsDirectory)];
    const base = allowed.find((candidate) => isInside(candidate, resolved) && candidate !== resolved);
    if (!base) throw new AppError(500, 'unsafe_world_destination', 'The world operation destination is outside NodePilot data.');
    await mkdir(base, { recursive: true });
    await safeWorldPath(base, path.relative(base, resolved).split(path.sep).join('/'), true);
    return resolved;
  }

  async copyWorld(server: ServerRecord, group: WorldGroup, destination: string, onProgress?: Progress): Promise<{ sizeBytes: number }> {
    const root = await this.root(server);
    const entries = await scanTree(root, group.members);
    const target = await this.safeDestination(destination);
    await this.ensureSpace(path.dirname(target), entries.reduce((sum, entry) => sum + entry.size, 0));
    await mkdir(target, { recursive: false, mode: 0o700 });
    try {
      await mkdir(path.join(target, 'content'), { recursive: false });
      const result = await copyEntries(entries, path.join(target, 'content'), onProgress);
      await writeFile(path.join(target, 'nodepilot-world.json'), JSON.stringify(bundle(server, group)), { flag: 'wx', mode: 0o600 });
      return result;
    } catch (error) { await rm(target, { recursive: true, force: true }).catch(() => undefined); throw error; }
  }

  async exportWorld(server: ServerRecord, group: WorldGroup, destination: string, onProgress?: Progress): Promise<{ sizeBytes: number }> {
    const entries = await scanTree(await this.root(server), group.members);
    const target = await this.safeDestination(destination);
    await mkdir(path.dirname(target), { recursive: true });
    const output = await open(target, 'wx', 0o600);
    const zip = new yazl.ZipFile();
    zip.on('error', (error: Error) => (zip.outputStream as Readable).destroy(error));
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let processed = 0;
    onProgress?.(0, total);
    try {
      zip.addBuffer(Buffer.from(JSON.stringify(bundle(server, group))), 'nodepilot-world.json');
      for (const entry of entries) {
        const name = 'content/' + entry.relative;
        if (entry.directory) zip.addEmptyDirectory(name);
        else zip.addReadStreamLazy(name, { size: entry.size, mode: entry.mode }, (callback) => {
          const source = createReadStream(entry.absolute);
          const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { processed += chunk.length; onProgress?.(processed, total); done(null, chunk); } });
          source.once('error', (error) => meter.destroy(error));
          callback(null, source.pipe(meter));
        });
      }
      zip.end();
      await pipeline(zip.outputStream, createWriteStream(target, { fd: output.fd, autoClose: false }));
      await output.close();
      return { sizeBytes: (await stat(target)).size };
    } catch (error) {
      await output.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async restoreWorld(server: ServerRecord, group: WorldGroup, backupDirectory: string, onProgress?: Progress): Promise<void> {
    const backup = await this.safeDestination(backupDirectory);
    const manifest = await readManifest(backup);
    if (manifest.folder !== group.folder || [...manifest.members].sort().join('\0') !== [...group.members].sort().join('\0')) throw new AppError(409, 'world_backup_mismatch', 'This backup belongs to a different world group.');
    const content = await safeWorldPath(backup, 'content');
    const entries = await scanTree(content, manifest.members);
    const root = await this.root(server);
    const work = path.join(root, '.nodepilot-world-restore-' + randomUUID());
    const moved: Array<{ original: string; previous: string }> = [];
    const installed: string[] = [];
    let keepWork = false;
    await mkdir(path.join(work, 'candidate'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(work, 'previous'), { recursive: false });
    try {
      await copyEntries(entries, path.join(work, 'candidate'), onProgress);
      await writeFile(path.join(work, 'restore-journal.json'), JSON.stringify({ members: manifest.members, backup }), { flag: 'wx', mode: 0o600 });
      for (const member of manifest.members) {
        const original = await safeWorldPath(root, member, true);
        const previous = path.join(work, 'previous', ...member.split('/'));
        await mkdir(path.dirname(previous), { recursive: true });
        if (await exists(original)) { await rename(original, previous); moved.push({ original, previous }); }
        await mkdir(path.dirname(original), { recursive: true });
        await rename(path.join(work, 'candidate', ...member.split('/')), original);
        installed.push(original);
      }
    } catch (error) {
      try {
        for (const installedPath of installed.reverse()) await rm(installedPath, { recursive: true, force: true });
        for (const item of moved.reverse()) await rename(item.previous, item.original);
      } catch {
        keepWork = true;
        throw new AppError(500, 'world_restore_rollback_failed', 'World restoration could not roll back. The original directories remain in ' + work + ' and the full backup was retained.');
      }
      throw error;
    } finally { if (!keepWork) await rm(work, { recursive: true, force: true }).catch(() => undefined); }
  }
}
