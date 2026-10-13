import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as yauzl from 'yauzl';

import { AppError } from '../lib/errors.js';
import { ensureDirectory, isInside, resolveInside, resolveManagedServerRoot } from '../lib/paths.js';
import { inspectJar } from './jar-inspection.js';
import {
  defaultServerStartupConfig,
  type ServerFlavor,
  type ServerSoftware,
  type ServerStartupConfig,
} from '../types.js';

const MAX_IMPORT_ENTRIES = 100_000;
const MAX_DIRECTORY_IMPORT_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 250;
const MAX_PROPERTIES_BYTES = 512 * 1024;

export type ImportSource =
  | { type: 'directory'; path: string }
  | { type: 'archive'; path: string };

export type ImportFinding = {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
};

export type ImportInspection = {
  sourceType: 'directory' | 'archive';
  sourceLabel: string;
  suggestedName: string;
  detectedSoftware: ServerSoftware;
  suggestedFlavor: ServerFlavor;
  minecraftVersion?: string;
  loaderVersion?: string;
  /**
   * Produced only by deterministic inspection of the copied source. This is never accepted
   * from the browser and is persisted with the resulting managed server record.
   */
  startupConfig: ServerStartupConfig;
  port?: number;
  eulaAccepted: boolean;
  serverJar?: string;
  worlds: string[];
  playerDataFiles: number;
  plugins: string[];
  mods: string[];
  fileCount: number;
  totalBytes: number;
  canImport: boolean;
  findings: ImportFinding[];
};

type SourceFile = {
  relativePath: string;
  size: number;
  directory: boolean;
};

type ArchiveFile = SourceFile & {
  archivePath: string;
};

type PreparedImport = {
  inspection: ImportInspection;
  root: string;
  sourceFiles: SourceFile[];
  archiveFiles?: ArchiveFile[];
  archivePrefix?: string;
};

export type ImportCopyResult = {
  inspection: ImportInspection;
  warnings: string[];
  loaderVersion: string | null;
  startupConfig: ServerStartupConfig;
};

function displayNameFromPath(value: string): string {
  const base = path.basename(value, path.extname(value)).trim();
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').slice(0, 64) || 'Imported Minecraft server';
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/');
}

/** Exported for security tests and shared reasoning around ZIP-slip protection. */
export function safeArchiveRelative(fileName: string, prefix = ''): string {
  if (typeof fileName !== 'string' || fileName.includes('\0')) {
    throw new AppError(400, 'unsafe_archive_path', 'The archive contains an invalid entry name.');
  }
  const normalized = fileName.replace(/\\/g, '/');
  if (prefix && !normalized.startsWith(prefix)) return '';
  const relative = prefix ? normalized.slice(prefix.length) : normalized;
  if (!relative || relative === '.') return '';
  if (
    relative.startsWith('/')
    || /^[A-Za-z]:/.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new AppError(400, 'unsafe_archive_path', 'The archive contains a path that would escape its destination.');
  }
  return relative;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const madeByUnix = (entry.versionMadeBy >>> 8) === 3;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return madeByUnix && (mode & 0o170000) === 0o120000;
}

function likelySoftware(fileName: string): ServerSoftware {
  const lower = fileName.toLowerCase();
  if (/purpur/.test(lower)) return 'purpur';
  if (/(spigot|craftbukkit)/.test(lower)) return 'spigot';
  if (/(paper|pufferfish|folia)/.test(lower)) return 'paper';
  if (/quilt/.test(lower)) return 'quilt';
  if (/fabric/.test(lower)) return 'fabric';
  if (/neoforge/.test(lower)) return 'neoforge';
  if (/forge/.test(lower)) return 'forge';
  if (/(minecraft_server|vanilla)/.test(lower)) return 'vanilla';
  return 'unknown';
}

function versionFromFileName(fileName: string): string | undefined {
  const match = fileName.match(/(?:mc(?:inecraft)?[-_. ]?)?(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?)/i);
  return match?.[1];
}

function readProperty(content: string, name: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=][^=]*?)\s*=\s*(.*)$/);
    if (match?.[1].trim() === name) return match[2];
  }
  return undefined;
}

function updateProperty(content: string, name: string, value: string): string {
  const lineExpression = new RegExp(`^(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=).*$`, 'm');
  const next = lineExpression.test(content)
    ? content.replace(lineExpression, `$1${value}`)
    : `${content.replace(/\s*$/, '')}\n${name}=${value}\n`;
  return next.endsWith('\n') ? next : `${next}\n`;
}

function inferredJavaMajor(version: string | undefined): number | null {
  if (!version) return null;
  const values = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = values[0] ?? 0;
  const minor = values[1] ?? 0;
  if (major >= 26) return 25;
  if (major !== 1) return null;
  if (minor <= 11) return 8;
  if (minor <= 16) return minor === 16 && (values[2] ?? 0) >= 5 ? 16 : 11;
  if (minor <= 19) return 17;
  return 21;
}

function primaryJar(files: SourceFile[]): string | undefined {
  const candidates = files
    .filter((file) => !file.directory && !file.relativePath.includes('/') && /\.jar$/i.test(file.relativePath))
    .map((file) => file.relativePath);
  return candidates.sort((left, right) => {
    const rank = (value: string) => {
      const lower = value.toLowerCase();
      if (lower === 'server.jar') return 0;
      if (/^(paper|purpur|pufferfish|spigot|craftbukkit|fabric|quilt|forge|neoforge|minecraft_server)/.test(lower)) return 1;
      return 2;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  })[0];
}

function softwareFromLayout(files: SourceFile[]): ServerSoftware {
  const paths = files.filter((file) => !file.directory).map((file) => file.relativePath.replace(/\\/g, '/').toLowerCase());
  if (paths.some((entry) => entry.startsWith('libraries/net/neoforged/neoforge/'))) return 'neoforge';
  if (paths.some((entry) => entry.startsWith('libraries/net/minecraftforge/forge/'))) return 'forge';
  if (paths.some((entry) => path.posix.basename(entry) === 'quilt-server-launch.jar')) return 'quilt';
  if (paths.some((entry) => path.posix.basename(entry) === 'fabric-server-launch.jar')) return 'fabric';
  return 'unknown';
}

function loaderVersionFromFiles(files: SourceFile[], software: ServerSoftware, serverJar: string | undefined): string | undefined {
  const normalized = files.map((file) => file.relativePath.replace(/\\/g, '/'));
  const mavenSegment = software === 'forge'
    ? 'net/minecraftforge/forge'
    : software === 'neoforge'
      ? 'net/neoforged/neoforge'
      : undefined;
  if (mavenSegment) {
    const candidate = normalized.find((entry) => entry.startsWith('libraries/' + mavenSegment + '/'));
    const full = candidate?.split('/')[4];
    if (full) {
      if (software === 'forge') {
        const match = full.match(/^\d+\.\d+(?:\.\d+)?-(.+)$/);
        return match?.[1] ?? full;
      }
      return full;
    }
  }
  if (!serverJar) return undefined;
  const fileName = serverJar.toLowerCase();
  if (software === 'fabric') return fileName.match(/(?:loader[._-])(\d+(?:\.\d+)+(?:[-+][a-z0-9._-]+)?)/i)?.[1];
  if (software === 'quilt') return fileName.match(/(?:quilt|loader)[._-](\d+(?:\.\d+)+(?:[-+][a-z0-9._-]+)?)/i)?.[1];
  if (software === 'forge') return fileName.match(/forge[-_]\d+\.\d+(?:\.\d+)?[-_](.+?)(?:\.jar)?$/i)?.[1];
  if (software === 'neoforge') return fileName.match(/neoforge[-_](.+?)(?:\.jar)?$/i)?.[1];
  return undefined;
}

function minecraftVersionFromLoaderFiles(files: SourceFile[], software: ServerSoftware): string | undefined {
  if (software !== 'forge' && software !== 'neoforge') return undefined;
  const segment = software === 'forge' ? 'libraries/net/minecraftforge/forge/' : 'libraries/net/neoforged/neoforge/';
  const candidate = files
    .map((file) => file.relativePath.replace(/\\/g, '/'))
    .find((entry) => entry.startsWith(segment));
  const artifactVersion = candidate?.slice(segment.length).split('/')[0];
  if (!artifactVersion) return undefined;
  if (software === 'forge') return artifactVersion.match(/^(1\.\d+(?:\.\d+)?)-/)?.[1];
  const modern = artifactVersion.match(/^(\d+)\.(\d+)\./);
  return modern && Number(modern[1]) >= 20 ? `1.${modern[1]}.${modern[2]}` : undefined;
}

function loaderStartupConfig(files: SourceFile[], software: ServerSoftware): ServerStartupConfig {
  if (software !== 'forge' && software !== 'neoforge') {
    return { ...defaultServerStartupConfig, gameArguments: [...defaultServerStartupConfig.gameArguments] };
  }
  const paths = files
    .filter((file) => !file.directory)
    .map((file) => file.relativePath.replace(/\\/g, '/'));
  const windows = paths.filter((entry) => /^libraries\/.+\/win_args\.txt$/i.test(entry));
  const linux = paths.filter((entry) => /^libraries\/.+\/unix_args\.txt$/i.test(entry));
  const windowsByParent = new Map(windows.map((entry) => [entry.slice(0, -'win_args.txt'.length), entry]));
  const pair = linux
    .map((entry) => ({ linux: entry, windows: windowsByParent.get(entry.slice(0, -'unix_args.txt'.length)) }))
    .find((entry): entry is { linux: string; windows: string } => Boolean(entry.windows));
  if (!pair) return { ...defaultServerStartupConfig, gameArguments: [...defaultServerStartupConfig.gameArguments] };
  return {
    mode: 'arg-files',
    windowsArgFile: pair.windows,
    linuxArgFile: pair.linux,
    // This installer-created file is optional for direct launches, but retaining it preserves
    // legitimate loader flags. ServerRuntime validates its managed-relative path before use.
    jvmArgFiles: paths.some((entry) => entry.toLowerCase() === 'user_jvm_args.txt') ? ['user_jvm_args.txt'] : [],
    gameArguments: ['nogui'],
  };
}

function hasPath(files: SourceFile[], relativePath: string): boolean {
  return files.some((file) => file.relativePath.toLocaleLowerCase() === relativePath.toLocaleLowerCase());
}

function valuesUnder(files: SourceFile[], root: string): string[] {
  const prefix = `${root}/`;
  return files
    .filter((file) => !file.directory && file.relativePath.toLowerCase().startsWith(prefix) && /\.jar$/i.test(file.relativePath))
    .map((file) => file.relativePath.slice(prefix.length));
}

function worldNames(files: SourceFile[]): string[] {
  const values = new Set<string>();
  for (const file of files) {
    if (!file.directory || file.relativePath.includes('/')) continue;
    const candidate = `${file.relativePath}/level.dat`;
    if (hasPath(files, candidate)) values.add(file.relativePath);
  }
  return [...values].sort();
}

function playerDataFileCount(files: SourceFile[]): number {
  return files.filter((file) => !file.directory && /(?:^|\/)playerdata\/[0-9a-f-]{32,36}\.dat$/i.test(file.relativePath)).length;
}

function inspectionFromFiles(
  sourceType: ImportInspection['sourceType'],
  sourceLabel: string,
  files: SourceFile[],
  options: { jarMetadata?: Awaited<ReturnType<typeof inspectJar>>; properties?: string; eula?: string } = {},
): ImportInspection {
  const serverJar = primaryJar(files);
  const fileNameSoftware = serverJar ? likelySoftware(serverJar) : 'unknown';
  const layoutSoftware = softwareFromLayout(files);
  const detectedSoftware = options.jarMetadata?.software && options.jarMetadata.software !== 'unknown'
    ? options.jarMetadata.software
    : fileNameSoftware !== 'unknown'
      ? fileNameSoftware
      : layoutSoftware;
  const minecraftVersion = options.jarMetadata?.minecraftVersion
    ?? (serverJar ? versionFromFileName(serverJar) : undefined)
    ?? minecraftVersionFromLoaderFiles(files, detectedSoftware);
  const loaderVersion = loaderVersionFromFiles(files, detectedSoftware, serverJar);
  const startupConfig = loaderStartupConfig(files, detectedSoftware);
  const portText = options.properties ? readProperty(options.properties, 'server-port') : undefined;
  const port = portText && /^\d+$/.test(portText) && Number(portText) >= 1 && Number(portText) <= 65_535 ? Number(portText) : undefined;
  const plugins = valuesUnder(files, 'plugins');
  const mods = valuesUnder(files, 'mods');
  const findings: ImportFinding[] = [];
  if (!serverJar && startupConfig.mode !== 'arg-files') findings.push({ level: 'error', code: 'server_launcher_missing', message: 'No runnable server JAR or verified loader launch argument files were found.' });
  if (!hasPath(files, 'server.properties')) findings.push({ level: 'warning', code: 'properties_missing', message: 'server.properties is missing; NodePilot will create a minimal configuration in the managed copy.' });
  if (detectedSoftware === 'unknown') findings.push({ level: 'warning', code: 'software_uncertain', message: 'NodePilot could not confidently identify server software. Choose the server software manually before importing.' });
  if (!minecraftVersion) findings.push({ level: 'warning', code: 'version_uncertain', message: 'Minecraft version could not be determined from the server JAR. Enter or confirm it before importing.' });
  if (['fabric', 'quilt', 'forge', 'neoforge'].includes(detectedSoftware)) {
    const label = `${detectedSoftware[0].toUpperCase()}${detectedSoftware.slice(1)}`;
    findings.push({
      level: startupConfig.mode === 'arg-files' || detectedSoftware === 'fabric' || detectedSoftware === 'quilt' ? 'info' : 'warning',
      code: 'loader_detected',
      message: startupConfig.mode === 'arg-files'
        ? `${label} launch argument files were detected and will be retained in the managed copy.`
        : `${label} files were detected, but NodePilot could not verify the loader launch files. Confirm the managed copy’s startup files before starting it.`,
    });
  }
  if (plugins.length && mods.length) findings.push({ level: 'warning', code: 'mixed_addons', message: 'Both plugins and mods were found. They remain separate; verify that this server software supports each set.' });
  if (plugins.length) findings.push({ level: 'info', code: 'plugins_found', message: `${plugins.length} plugin JAR${plugins.length === 1 ? '' : 's'} will be copied.` });
  if (mods.length) findings.push({ level: 'info', code: 'mods_found', message: `${mods.length} mod JAR${mods.length === 1 ? '' : 's'} will be copied.` });

  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  return {
    sourceType,
    sourceLabel,
    suggestedName: displayNameFromPath(sourceLabel),
    detectedSoftware,
    suggestedFlavor: detectedSoftware === 'paper' ? 'paper' : 'vanilla',
    minecraftVersion,
    loaderVersion,
    startupConfig,
    port,
    eulaAccepted: /^\s*eula\s*=\s*true\s*$/mi.test(options.eula ?? ''),
    serverJar,
    worlds: worldNames(files),
    playerDataFiles: playerDataFileCount(files),
    plugins,
    mods,
    fileCount: files.filter((file) => !file.directory).length,
    totalBytes,
    canImport: Boolean(serverJar || startupConfig.mode === 'arg-files'),
    findings,
  };
}

async function readSmallFile(filePath: string): Promise<string | undefined> {
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size > MAX_PROPERTIES_BYTES) return undefined;
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function scanDirectory(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  while (pending.length) {
    const current = pending.pop() as { absolute: string; relative: string };
    const details = await lstat(current.absolute);
    if (details.isSymbolicLink()) throw new AppError(400, 'unsafe_import_link', 'Imports containing symbolic links or junctions are not supported.');
    if (current.relative) files.push({ relativePath: current.relative, size: details.isFile() ? details.size : 0, directory: details.isDirectory() });
    if (files.length > MAX_IMPORT_ENTRIES) throw new AppError(413, 'import_too_many_entries', `Imports are limited to ${MAX_IMPORT_ENTRIES.toLocaleString()} entries.`);
    if (details.isFile()) {
      totalBytes += details.size;
      if (totalBytes > MAX_DIRECTORY_IMPORT_BYTES) throw new AppError(413, 'import_too_large', 'The selected directory is larger than NodePilot’s safe import limit.');
      continue;
    }
    if (!details.isDirectory()) continue;
    const children = await readdir(current.absolute, { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) throw new AppError(400, 'unsafe_import_link', 'Imports containing symbolic links or junctions are not supported.');
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      safeArchiveRelative(relative);
      pending.push({ absolute: path.join(current.absolute, child.name), relative });
    }
  }
  return files;
}

async function readArchiveEntries(archivePath: string): Promise<ArchiveFile[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(archivePath, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
  } catch {
    throw new AppError(400, 'invalid_archive', 'The uploaded file is not a valid ZIP archive.');
  }
  try {
    const raw: Array<ArchiveFile & { rawPath: string }> = [];
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      if (raw.length >= MAX_IMPORT_ENTRIES) throw new AppError(413, 'import_too_many_entries', `ZIP imports are limited to ${MAX_IMPORT_ENTRIES.toLocaleString()} entries.`);
      if (isSymlinkEntry(entry) || entry.isEncrypted()) throw new AppError(400, 'unsafe_archive_entry', 'Encrypted or linked ZIP entries cannot be imported.');
      const rawPath = entry.fileName.replace(/\\/g, '/');
      safeArchiveRelative(rawPath);
      const directory = rawPath.endsWith('/');
      if (!directory) {
        if (entry.uncompressedSize > 0 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_ARCHIVE_RATIO) {
          throw new AppError(413, 'archive_compression_ratio', 'The ZIP contains a suspiciously compressed entry.');
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new AppError(413, 'import_too_large', 'The ZIP expands beyond NodePilot’s safe import limit.');
      }
      raw.push({ rawPath, archivePath: rawPath, relativePath: rawPath.replace(/\/$/, ''), size: directory ? 0 : entry.uncompressedSize, directory });
    }
    const nonRoot = raw.filter((file) => file.rawPath && file.rawPath.includes('/'));
    const roots = new Set(raw.filter((file) => file.rawPath).map((file) => file.rawPath.split('/')[0]));
    const prefix = raw.length && nonRoot.length === raw.length && roots.size === 1 ? `${[...roots][0]}/` : '';
    const names = new Set<string>();
    const files = raw.map((entry): ArchiveFile => {
      const relativePath = safeArchiveRelative(entry.rawPath.replace(/\/$/, ''), prefix);
      if (!relativePath) return { ...entry, relativePath: '', archivePath: entry.rawPath };
      const key = relativePath.toLocaleLowerCase();
      if (names.has(key)) throw new AppError(400, 'duplicate_archive_entry', 'The ZIP contains duplicate paths after normalization.');
      names.add(key);
      return { relativePath, archivePath: entry.rawPath, size: entry.size, directory: entry.directory };
    }).filter((entry) => Boolean(entry.relativePath));
    return files;
  } finally {
    zip.close();
  }
}

async function readArchiveText(archivePath: string, wantedPath: string): Promise<string | undefined> {
  const zip = await yauzl.openPromise(archivePath, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.replace(/\\/g, '/').replace(/\/$/, '') !== wantedPath) continue;
      if (entry.uncompressedSize > MAX_PROPERTIES_BYTES) return undefined;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += (chunk as Buffer).length;
        if (bytes > MAX_PROPERTIES_BYTES) return undefined;
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    return undefined;
  } finally {
    zip.close();
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new AppError(400, 'unsafe_import_link', 'Imports containing symbolic links or junctions are not supported.');
    const sourcePath = path.join(source, entry.name);
    const destinationPath = await resolveInside(destination, entry.name, false);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new AppError(400, 'unsafe_import_link', 'Imports containing symbolic links or junctions are not supported.');
    if (metadata.isDirectory()) {
      await mkdir(destinationPath, { recursive: false });
      await copyDirectory(sourcePath, destinationPath);
    } else if (metadata.isFile()) {
      await copyFile(sourcePath, destinationPath, 0);
    }
  }
}

async function extractArchive(archivePath: string, destination: string, files: ArchiveFile[]): Promise<void> {
  const byArchivePath = new Map(files.map((file) => [file.archivePath.replace(/\/$/, ''), file]));
  const zip = await yauzl.openPromise(archivePath, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
  try {
    for await (const entry of zip.eachEntry()) {
      const sourceName = entry.fileName.replace(/\\/g, '/').replace(/\/$/, '');
      const planned = byArchivePath.get(sourceName);
      if (!planned) continue;
      const destinationPath = await resolveInside(destination, planned.relativePath, false);
      if (planned.directory) {
        await mkdir(destinationPath, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(destinationPath), { recursive: true });
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      const limiter = new (await import('node:stream')).Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
          bytes += chunk.length;
          if (bytes > planned.size || bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) callback(new AppError(413, 'archive_entry_too_large', 'An archive entry expanded beyond its validated size.'));
          else callback(null, chunk);
        },
      });
      const { createWriteStream } = await import('node:fs');
      await pipeline(stream, limiter, createWriteStream(destinationPath, { flags: 'wx' }));
      if (bytes !== planned.size) throw new AppError(400, 'archive_size_mismatch', 'An archive entry did not match its declared size.');
    }
  } finally {
    zip.close();
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.nodepilot-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class ImportService {
  constructor(
    private readonly serversDirectory: string,
    private readonly dataDirectory: string,
  ) {}

  private async sourceDirectory(input: string): Promise<string> {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
      throw new AppError(400, 'invalid_import_path', 'Choose an absolute local server directory.');
    }
    let root: string;
    try {
      root = await realpath(input);
    } catch {
      throw new AppError(404, 'import_source_not_found', 'The selected server directory could not be found.');
    }
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AppError(400, 'invalid_import_path', 'Choose a real local directory, not a file or symbolic link.');
    }
    if (isInside(path.resolve(this.dataDirectory), root)) {
      throw new AppError(400, 'invalid_import_path', 'NodePilot data directories cannot be imported into themselves.');
    }
    return root;
  }

  async inspectDirectory(input: string): Promise<ImportInspection> {
    const root = await this.sourceDirectory(input);
    const files = await scanDirectory(root);
    const jar = primaryJar(files);
    const metadata = jar ? await inspectJar(path.join(root, jar)).catch(() => undefined) : undefined;
    const [properties, eula] = await Promise.all([
      readSmallFile(path.join(root, 'server.properties')),
      readSmallFile(path.join(root, 'eula.txt')),
    ]);
    return inspectionFromFiles('directory', root, files, { jarMetadata: metadata, properties, eula });
  }

  async inspectArchive(archivePath: string, sourceLabel = archivePath): Promise<ImportInspection> {
    const files = await readArchiveEntries(archivePath);
    const properties = await readArchiveText(archivePath, files.find((file) => file.relativePath.toLowerCase() === 'server.properties')?.archivePath ?? '__missing__');
    const eula = await readArchiveText(archivePath, files.find((file) => file.relativePath.toLowerCase() === 'eula.txt')?.archivePath ?? '__missing__');
    return inspectionFromFiles('archive', sourceLabel, files, { properties, eula });
  }

  async prepare(source: ImportSource): Promise<PreparedImport> {
    if (source.type === 'directory') {
      const root = await this.sourceDirectory(source.path);
      const sourceFiles = await scanDirectory(root);
      const inspection = await this.inspectDirectory(root);
      return { inspection, root, sourceFiles };
    }
    const archiveStats = await stat(source.path).catch(() => undefined);
    if (!archiveStats?.isFile()) throw new AppError(404, 'import_archive_not_found', 'The uploaded ZIP archive is no longer available. Upload it again.');
    const archiveFiles = await readArchiveEntries(source.path);
    const inspection = await this.inspectArchive(source.path, source.path);
    return { inspection, root: source.path, sourceFiles: archiveFiles, archiveFiles };
  }

  async copyIntoManagedServer(source: ImportSource, managedDirectory: string, acceptedEula: boolean, port: number): Promise<ImportCopyResult> {
    if (!acceptedEula) throw new AppError(400, 'eula_not_accepted', 'You must explicitly accept the Minecraft EULA before importing a server.');
    const prepared = await this.prepare(source);
    if (!prepared.inspection.canImport) {
      throw new AppError(422, 'server_launcher_missing', 'NodePilot could not find a runnable server JAR or verified loader launch files to import.');
    }
    const destination = await resolveManagedServerRoot(this.serversDirectory, managedDirectory, true);
    try {
      if (source.type === 'directory') {
        await copyDirectory(prepared.root, destination);
      } else {
        await extractArchive(prepared.root, destination, prepared.archiveFiles ?? []);
      }
      if (prepared.inspection.serverJar) {
        const originalJar = await resolveInside(destination, prepared.inspection.serverJar);
        const managedJar = path.join(destination, 'server.jar');
        if (path.basename(originalJar).toLocaleLowerCase() !== 'server.jar') await copyFile(originalJar, managedJar, 0);
      }

      const propertiesPath = path.join(destination, 'server.properties');
      const currentProperties = await readSmallFile(propertiesPath);
      await atomicWrite(propertiesPath, updateProperty(currentProperties ?? '# Managed by NodePilot after import\n', 'server-port', String(port)));
      await atomicWrite(path.join(destination, 'eula.txt'), 'eula=true\n');
      const warnings = prepared.inspection.findings.filter((finding) => finding.level === 'warning').map((finding) => finding.message);
      if (prepared.inspection.port !== undefined && prepared.inspection.port !== port) {
        warnings.push(`The original port ${prepared.inspection.port} was unavailable, so NodePilot updated the managed copy to use port ${port}.`);
      }
      return {
        inspection: prepared.inspection,
        warnings,
        loaderVersion: prepared.inspection.loaderVersion ?? null,
        startupConfig: prepared.inspection.startupConfig,
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
      throw error;
    }
  }

  requiredJavaMajor(version: string | undefined): number | null {
    return inferredJavaMajor(version);
  }

  async ensureStorage(directory: string): Promise<void> {
    await ensureDirectory(directory);
  }
}
