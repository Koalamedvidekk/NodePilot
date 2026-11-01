import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { isInside } from './paths.js';
import { readWorldProperties } from './java-properties.js';
import type { ServerSoftware } from '../types.js';
import type { WorldGroup } from '../world-types.js';

const SERVER_WIDE_DIRECTORIES = new Set([
  'plugins', 'mods', 'libraries', 'config', 'defaultconfigs', 'logs', 'cache', 'versions',
  'backups', 'crash-reports', 'debug', 'node_modules', '.git', '.nodepilot',
]);

export function normalizeWorldRelative(relative: string): string {
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || /[\x00-\x1f\x7f:]/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new AppError(409, 'unsafe_world_path', 'World paths must stay inside the managed server directory.');
  }
  return normalized;
}

/** Unlike resolveInside, reject links even when their target is still inside root. */
export async function safeWorldPath(root: string, relative: string, allowMissing = false): Promise<string> {
  const normalized = normalizeWorldRelative(relative);
  const base = await realpath(root);
  let candidate = base;
  for (const part of normalized.split('/')) {
    candidate = path.join(candidate, part);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new AppError(409, 'unsafe_world_path', 'World management refuses symbolic links, junctions, and special files.');
      }
      if (!isInside(base, await realpath(candidate))) throw new AppError(409, 'unsafe_world_path', 'A world path escapes its server directory.');
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!isInside(base, candidate) || candidate === base) throw new AppError(409, 'unsafe_world_path', 'The server root cannot be treated as a world.');
  return candidate;
}

async function exists(root: string, relative: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const info = await lstat(await safeWorldPath(root, relative));
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function modernVersion(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  return Boolean(match && (Number(match[1]) > 26 || (Number(match[1]) === 26 && Number(match[2]) >= 1)));
}

export async function resolveWorldGroup(root: string, folder: string, software: ServerSoftware, version: string): Promise<WorldGroup> {
  let normalized: string;
  try { normalized = normalizeWorldRelative(folder); }
  catch (error) {
    return { folder, members: [], layout: 'unknown', metadataFile: null, rulesFile: null, generationFile: null, playerDirectories: [], dimensions: [], readOnlyReason: (error as Error).message };
  }
  if (SERVER_WIDE_DIRECTORIES.has(normalized.split('/')[0].normalize('NFC').toLowerCase())) {
    return { folder: normalized, members: [], layout: 'unknown', metadataFile: null, rulesFile: null, generationFile: null,
      playerDirectories: [], dimensions: [], readOnlyReason: 'The configured world path points into a protected server-wide directory. Choose a world directory before using world management; server-wide files will not be changed.' };
  }
  const group: WorldGroup = {
    folder: normalized, members: [normalized], layout: 'unknown', metadataFile: null, rulesFile: null, generationFile: null,
    playerDirectories: [], dimensions: [], readOnlyReason: null,
  };
  try {
    const location = await safeWorldPath(root, normalized, true);
    const info = await lstat(location).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && !info.isDirectory()) throw new AppError(409, 'invalid_world_directory', 'The world location is not a directory.');
    const level = normalized + '/level.dat';
    if (await exists(root, level, 'file')) group.metadataFile = level;
    if(info&&!group.metadataFile){
      const entries=await readdir(location,{withFileTypes:true});
      if(entries.some(entry=>entry.name!=='datapacks'||!entry.isDirectory()||entry.isSymbolicLink())) {
        group.readOnlyReason='This nonempty directory has no valid level.dat. Preserve its files and restore its metadata before managing it as a world.';
      }
    }

    const modernJavaBase = normalized + '/data/minecraft';
    const modernPaperBase = normalized + '/dimensions/minecraft/overworld/data/minecraft';
    const modernJavaFiles = await exists(root, modernJavaBase + '/world_gen_settings.dat', 'file') || await exists(root, modernJavaBase + '/game_rules.dat', 'file');
    const modernPaperFiles = await exists(root, modernPaperBase + '/world_gen_settings.dat', 'file') || await exists(root, modernPaperBase + '/game_rules.dat', 'file');
    const nestedDimensions = await exists(root, normalized + '/dimensions/minecraft/overworld', 'directory');
    const legacyRegions = await exists(root, normalized + '/region', 'directory');
    const legacyNether = await exists(root, normalized + '/DIM-1', 'directory');
    const legacyEnd = await exists(root, normalized + '/DIM1', 'directory');
    const modern = modernJavaFiles || modernPaperFiles || nestedDimensions || (!group.metadataFile && modernVersion(version));
    const paper = ['paper', 'purpur', 'spigot'].includes(software);
    if (modern) {
      group.layout = modernPaperFiles || (!modernJavaFiles && paper) ? 'modern-paper' : 'modern-java';
      if (modernJavaFiles && modernPaperFiles) group.readOnlyReason = 'Both Vanilla and Paper dimension metadata are present. Resolve this mixed layout before changing world files.';
      if (legacyRegions || legacyNether || legacyEnd) group.readOnlyReason ??= 'Both legacy and modern dimension directories are present. Review this mixed layout before changing world files.';
      for (const [suffix, dimension] of [['_nether', 'DIM-1'], ['_the_end', 'DIM1']] as const) {
        if (await exists(root, normalized + suffix + '/' + dimension, 'directory')) {
          group.members.push(normalized + suffix);
          group.readOnlyReason ??= 'Legacy Paper dimension folders remain beside a modern world. Review the migration before changing world files.';
        }
      }
      const dataBase = group.layout === 'modern-paper' ? modernPaperBase : modernJavaBase;
      if (await exists(root, dataBase + '/game_rules.dat', 'file')) group.rulesFile = dataBase + '/game_rules.dat';
      if (await exists(root, dataBase + '/world_gen_settings.dat', 'file')) group.generationFile = dataBase + '/world_gen_settings.dat';
    } else {
      group.layout = paper ? 'legacy-paper' : 'legacy-java';
      group.rulesFile = group.metadataFile;
      group.generationFile = group.metadataFile;
      for (const [suffix, dimension] of [['_nether', 'DIM-1'], ['_the_end', 'DIM1']] as const) {
        const sibling = normalized + suffix;
        if (await exists(root, sibling + '/' + dimension, 'directory')) {
          group.layout = 'legacy-paper';
          group.members.push(sibling);
          if (dimension === 'DIM-1' ? legacyNether : legacyEnd) group.readOnlyReason ??= 'The same dimension exists inside the world and in a Paper sibling folder. Resolve the duplicate layout before changing world files.';
        }
      }
    }
    if (group.metadataFile) group.dimensions.push('minecraft:overworld');
    if (await exists(root, normalized + '/DIM-1', 'directory') || group.members.includes(normalized + '_nether')) group.dimensions.push('minecraft:the_nether');
    if (await exists(root, normalized + '/DIM1', 'directory') || group.members.includes(normalized + '_the_end')) group.dimensions.push('minecraft:the_end');
    if (await exists(root, normalized + '/dimensions', 'directory')) {
      const namespaces = await readdir(await safeWorldPath(root, normalized + '/dimensions'), { withFileTypes: true });
      if (namespaces.length > 256) throw new AppError(413, 'too_many_dimensions', 'The world has too many dimension namespaces to inspect safely.');
      for (const namespace of namespaces) {
        const namespacePath = normalized + '/dimensions/' + namespace.name;
        if (namespace.isSymbolicLink()) throw new AppError(409, 'unsafe_world_path', 'A custom dimension is linked; remove the link before modifying the world.');
        if (!namespace.isDirectory()) continue;
        let inspected = 0;
        const inspectDimensions = async (relative: string, key: string, depth: number): Promise<void> => {
          if (depth > 16 || ++inspected > 4096) throw new AppError(413, 'too_many_dimensions', 'The world has too many or excessively nested dimensions to inspect safely.');
          const entries = await readdir(await safeWorldPath(root, relative), { withFileTypes: true });
          if (entries.length > 256) throw new AppError(413, 'too_many_dimensions', 'The world has too many dimensions to inspect safely.');
          if (entries.some((entry) => entry.isSymbolicLink())) throw new AppError(409, 'unsafe_world_path', 'A custom dimension is linked; remove the link before modifying the world.');
          // Dimension IDs may contain a path, e.g. example:solar_system/moon.
          // Storage folders identify a dimension root; otherwise descend to its
          // leaf directory instead of inventing the parent path as a dimension.
          const children = entries.filter((entry) => entry.isDirectory());
          if (key && (!children.length || children.some((entry) => ['region', 'entities', 'poi', 'data'].includes(entry.name)))) {
            group.dimensions.push(namespace.name + ':' + key);
            return;
          }
          for (const child of children) await inspectDimensions(relative + '/' + child.name, key ? key + '/' + child.name : child.name, depth + 1);
        };
        await inspectDimensions(namespacePath, '', 0);
      }
    }
    group.dimensions = [...new Set(group.dimensions)];
    for (const candidate of [normalized + '/players/data', normalized + '/playerdata']) {
      if (await exists(root, candidate, 'directory')) group.playerDirectories.push(candidate);
    }
    if (group.playerDirectories.length > 1) group.readOnlyReason ??= 'Both legacy and modern player directories are present. Resolve the mixed player-data layout before editing this world.';
  } catch (error) {
    group.readOnlyReason = (error as Error).message;
  }
  return group;
}

export async function discoverWorldGroups(root: string, software: ServerSoftware, version: string, activeFolder: string): Promise<WorldGroup[]> {
  const candidates = new Set<string>([activeFolder]);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 2_000) throw new AppError(413, 'too_many_world_candidates', 'The server directory has too many entries to discover worlds safely.');
  const parents = new Set<string>();
  if (activeFolder.includes('/')) parents.add(activeFolder.slice(0, activeFolder.lastIndexOf('/')));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || SERVER_WIDE_DIRECTORIES.has(entry.name.normalize('NFC').toLowerCase())) continue;
    if (await exists(root, entry.name + '/level.dat', 'file')) candidates.add(entry.name);
    if (entry.name === 'worlds') parents.add(entry.name);
  }
  for (const parent of parents) {
    try {
      const children = await readdir(await safeWorldPath(root, parent), { withFileTypes: true });
      if (children.length > 2_000) continue;
      for (const child of children) if (child.isDirectory() && !child.isSymbolicLink() && await exists(root, parent + '/' + child.name + '/level.dat', 'file')) candidates.add(parent + '/' + child.name);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const groups = await Promise.all([...candidates].map((folder) => resolveWorldGroup(root, folder, software, version)));
  const secondaries = new Set(groups.flatMap((group) => group.members.filter((member) => member !== group.folder)));
  return groups.filter((group) => group.folder === activeFolder || !secondaries.has(group.folder));
}

/** Player listings must never merge inventories from inactive saved worlds. */
export async function activeWorldPlayerDirectories(root: string): Promise<string[]> {
  try {
    const properties = await readWorldProperties(root);
    const group = await resolveWorldGroup(root, properties['level-name'] || 'world', 'unknown', '');
    // Safe offline reads remain useful when level.dat needs repair. Only one
    // unambiguous player directory is allowed, and every path is checked again.
    if (group.playerDirectories.length !== 1) return [];
    return Promise.all(group.playerDirectories.map((relative) => safeWorldPath(root, relative)));
  } catch { return []; }
}
