import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync, inflateSync, deflateSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { AppError } from './errors.js';
import { safeWorldPath } from './world-layout.js';
import type { WorldDifficulty, WorldGameRule, WorldGroup, WorldMetadata } from '../world-types.js';

const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
type Tag = { type: string; value: unknown };
type Compound = Record<string, Tag | undefined>;
type Document = { path: string; relative: string; tree: nbt.NBT; data: Compound; compression: 'gzip' | 'zlib' | 'none'; mode: number; original: Buffer };
export interface WorldMetadataChanges {
  difficulty?: WorldDifficulty;
  hardcore?: boolean;
  rules?: Record<string, boolean | number>;
  enabledPacks?: string[];
  disabledPacks?: string[];
}

const BOOL_RULES = [
  'announceAdvancements', 'blockExplosionDropDecay', 'commandBlockOutput', 'commandBlocksEnabled',
  'disableElytraMovementCheck', 'disablePlayerMovementCheck', 'disableRaids', 'doDaylightCycle', 'doEntityDrops',
  'doFireTick', 'doImmediateRespawn', 'doInsomnia', 'doLimitedCrafting', 'doMobLoot', 'doMobSpawning',
  'doPatrolSpawning', 'doTileDrops', 'doTraderSpawning', 'doVinesSpread', 'doWardenSpawning', 'doWeatherCycle',
  'drowningDamage', 'enderPearlsVanishOnDeath', 'fallDamage', 'fireDamage', 'forgiveDeadPlayers', 'freezeDamage',
  'globalSoundEvents', 'keepInventory', 'lavaSourceConversion', 'locatorBar', 'logAdminCommands', 'mobExplosionDropDecay',
  'mobGriefing', 'naturalRegeneration', 'projectilesCanBreakBlocks', 'reducedDebugInfo', 'sendCommandFeedback',
  'showDeathMessages', 'spectatorsGenerateChunks', 'spawnerBlocksEnabled', 'tntExplosionDropDecay', 'tntExplodes',
  'universalAnger', 'waterSourceConversion', 'allowFireTicksAwayFromPlayer',
];
const RENAMED: Record<string, string> = {
  announceAdvancements: 'show_advancement_messages', commandBlocksEnabled: 'command_blocks_work',
  command_modification_block_limit: 'max_block_modifications', disableElytraMovementCheck: 'elytra_movement_check',
  disablePlayerMovementCheck: 'player_movement_check', disableRaids: 'raids', doDaylightCycle: 'advance_time',
  doEntityDrops: 'entity_drops', doImmediateRespawn: 'immediate_respawn', doInsomnia: 'spawn_phantoms',
  doLimitedCrafting: 'limited_crafting', doMobLoot: 'mob_drops', doMobSpawning: 'spawn_mobs', doPatrolSpawning: 'spawn_patrols',
  doTileDrops: 'block_drops', doTraderSpawning: 'spawn_wandering_traders', doVinesSpread: 'spread_vines',
  doWardenSpawning: 'spawn_wardens', doWeatherCycle: 'advance_weather', maxCommandChainLength: 'max_command_sequence_length',
  maxCommandForkCount: 'max_command_forks', naturalRegeneration: 'natural_health_regeneration',
  snowAccumulationHeight: 'max_snow_accumulation_height', spawnRadius: 'respawn_radius', spawnerBlocksEnabled: 'spawner_blocks_work',
};
const INTEGER_RULES: Record<string, [number, number]> = {
  randomTickSpeed: [0, 2_147_483_647], maxEntityCramming: [0, 2_147_483_647], spawnRadius: [0, 2_147_483_647],
  playersSleepingPercentage: [0, 2_147_483_647], maxCommandChainLength: [0, 2_147_483_647], maxCommandForkCount: [1, 2_147_483_647],
  commandModificationBlockLimit: [1, 2_147_483_647], command_modification_block_limit: [1, 2_147_483_647],
  playersNetherPortalCreativeDelay: [0, 2_147_483_647], playersNetherPortalDefaultDelay: [0, 2_147_483_647],
  snowAccumulationHeight: [0, 8], spawnChunkRadius: [0, 32],
};
const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const booleanIds = new Set(BOOL_RULES.flatMap((id) => [id, 'minecraft:' + (RENAMED[id] ?? snake(id))]));
for (const id of ['spawn_monsters', 'spawn_animals', 'spawn_npcs', 'player_movement_check', 'elytra_movement_check', 'spawner_blocks_work', 'command_blocks_work']) booleanIds.add('minecraft:' + id);
const integerIds = new Map<string, [number, number]>();
for (const [id, range] of Object.entries(INTEGER_RULES)) { integerIds.set(id, range); integerIds.set('minecraft:' + (RENAMED[id] ?? snake(id)), range); }
integerIds.set('minecraft:fire_spread_radius_around_player', [-1, 2_147_483_647]);
integerIds.set('minecraft:max_block_modifications', [1, 2_147_483_647]);

function compound(tag: Tag | undefined): Compound | null {
  return tag?.type === 'compound' && tag.value !== null && typeof tag.value === 'object' && !Array.isArray(tag.value) ? tag.value as Compound : null;
}
function dataOf(tree: nbt.NBT): Compound {
  const root = tree.value as Compound;
  return compound(root.Data) ?? compound(root.data) ?? root;
}
function string(tag: Tag | undefined): string | null { return tag?.type === 'string' && typeof tag.value === 'string' ? tag.value : null; }
function number(tag: Tag | undefined): number | null { return tag && ['byte', 'short', 'int', 'float', 'double'].includes(tag.type) && typeof tag.value === 'number' && Number.isFinite(tag.value) ? tag.value : null; }
function bool(tag: Tag | undefined): boolean | null {
  const value = number(tag);
  return value === 0 ? false : value === 1 ? true : string(tag) === 'true' ? true : string(tag) === 'false' ? false : null;
}
function strings(tag: Tag | undefined): string[] {
  if (tag?.type !== 'list' || !tag.value || typeof tag.value !== 'object') return [];
  const list = tag.value as { type?: string; value?: unknown };
  return list.type === 'string' && Array.isArray(list.value) ? list.value.filter((value): value is string => typeof value === 'string') : [];
}
function longString(tag: Tag | undefined): string | null {
  if (!tag || tag.type !== 'long') return null;
  if (typeof tag.value === 'bigint') return BigInt.asIntN(64, tag.value).toString();
  if (Array.isArray(tag.value) && tag.value.length === 2 && tag.value.every((part) => typeof part === 'number' && Number.isInteger(part))) {
    return BigInt.asIntN(64, (BigInt(tag.value[0]) << 32n) | BigInt(tag.value[1] >>> 0)).toString();
  }
  return null;
}

async function loadDocument(root: string, relative: string): Promise<Document> {
  const file = await safeWorldPath(root, relative);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMPRESSED_BYTES) throw new AppError(413, 'invalid_world_metadata', 'World metadata must be a regular file no larger than 16 MB.');
  const original = await readFile(file);
  const compression = original[0] === 0x1f && original[1] === 0x8b ? 'gzip' : original[0] === 0x78 && ((original[0] << 8) + original[1]) % 31 === 0 ? 'zlib' : 'none';
  let contents: Buffer;
  try {
    contents = compression === 'gzip' ? gunzipSync(original, { maxOutputLength: MAX_INFLATED_BYTES })
      : compression === 'zlib' ? inflateSync(original, { maxOutputLength: MAX_INFLATED_BYTES }) : original;
    if (contents.length > MAX_INFLATED_BYTES) throw new Error('Metadata expands beyond the inspection limit.');
    const tree = nbt.parseUncompressed(contents, 'big');
    if (tree.type !== 'compound') throw new Error('Expected a Java world compound.');
    return { path: file, relative, tree, data: dataOf(tree), compression, mode: info.mode, original };
  } catch { throw new AppError(422, 'invalid_world_metadata', 'The world metadata is corrupt, too large, or uses an unsupported NBT format.'); }
}

export function metadataFiles(group: WorldGroup): string[] {
  if (!group.members.length) return [];
  const files = [...new Set([group.metadataFile ?? group.folder + '/level.dat', group.rulesFile, group.generationFile].filter((file): file is string => Boolean(file)))];
  return files.flatMap((file) => [file, file + '_old']);
}

function rulesMap(document: Document, separate: boolean): Compound | null {
  const nested = compound(document.data.GameRules) ?? compound(document.data.game_rules) ?? compound(document.data.rules);
  if (nested) return nested;
  return separate ? document.data : null;
}
function generationMap(document: Document): Compound { return compound(document.data.WorldGenSettings) ?? compound(document.data.world_gen_settings) ?? document.data; }

function gameRules(map: Compound | null): WorldGameRule[] {
  if (!map) return [];
  return Object.entries(map).filter(([id, tag]) => tag && !['DataVersion', 'data_version'].includes(id)).map(([id, tag]): WorldGameRule => {
    const label = (id.includes(':') ? id.split(':').slice(1).join(':') : id).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
    const booleanValue = bool(tag);
    if (booleanIds.has(id) && booleanValue !== null) return { id, label, type: 'boolean', value: booleanValue, editable: true };
    const rawNumber = number(tag) ?? (string(tag)?.match(/^-?\d{1,10}$/) ? Number(string(tag)) : null);
    const range = integerIds.get(id);
    if (range && rawNumber !== null && Number.isSafeInteger(rawNumber) && ['string', 'byte', 'short', 'int'].includes(tag!.type)) {
      return { id, label, type: 'integer', value: rawNumber, editable: true, minimum: range[0], maximum: range[1] };
    }
    const raw = string(tag) ?? number(tag);
    return { id, label, type: 'unknown', value: raw === null ? '[' + tag!.type + ']' : String(raw), editable: false };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function difficulty(data: Compound): WorldDifficulty | null {
  const modern = string(compound(data.difficulty_settings)?.difficulty);
  if (modern && ['peaceful', 'easy', 'normal', 'hard'].includes(modern)) return modern as WorldDifficulty;
  const legacy = number(data.Difficulty);
  return legacy !== null && Number.isInteger(legacy) ? (['peaceful', 'easy', 'normal', 'hard'][legacy] as WorldDifficulty | undefined) ?? null : null;
}
function preset(data: Compound, generation: Compound): string | null {
  const old = string(data.generatorName);
  if (old) return old === 'default' || old === 'normal' ? 'minecraft:normal' : old.includes(':') ? old : 'minecraft:' + old;
  const overworld = compound(compound(generation.dimensions)?.['minecraft:overworld']);
  const generator = compound(overworld?.generator);
  const type = string(generator?.type);
  if (type === 'minecraft:flat') return 'minecraft:flat';
  const setting = string(generator?.settings);
  if (setting === 'minecraft:overworld') return 'minecraft:normal';
  if (setting === 'minecraft:large_biomes' || setting === 'minecraft:amplified') return setting;
  return string(generation.preset) ?? null;
}

export async function readWorldMetadata(root: string, group: WorldGroup): Promise<WorldMetadata> {
  const result: WorldMetadata = {
    generated: false, seed: null, minecraftVersion: null, dataVersion: null, difficulty: null, hardcore: null, preset: null,
    structures: null, lastSavedAt: null, features: [], enabledPacks: [], disabledPacks: [], gameRules: [], warnings: [], readOnlyReason: group.readOnlyReason,
  };
  if (!group.metadataFile) return result;
  try {
    const level = await loadDocument(root, group.metadataFile);
    const data = level.data;
    const knownKeys = ['LevelName', 'level_name', 'WorldGenSettings', 'RandomSeed', 'hardcore', 'Version', 'difficulty_settings', 'GameRules', 'game_rules'];
    if (!knownKeys.some((key) => data[key])) throw new AppError(422, 'unknown_world_schema', 'This level.dat does not contain recognized Java world metadata.');
    result.generated = true;
    const version = compound(data.Version) ?? compound(data.version);
    result.minecraftVersion = string(version?.Name) ?? string(version?.name);
    result.dataVersion = number(data.DataVersion) ?? number((level.tree.value as Compound).DataVersion) ?? number(data.data_version);
    result.difficulty = difficulty(data);
    result.hardcore = bool(data.hardcore);
    result.features = strings(data.enabled_features);
    const packs = compound(data.DataPacks) ?? compound(data.data_packs);
    result.enabledPacks = strings(packs?.Enabled ?? packs?.enabled);
    result.disabledPacks = strings(packs?.Disabled ?? packs?.disabled);
    let gen = level;
    if (group.generationFile && group.generationFile !== group.metadataFile) gen = await loadDocument(root, group.generationFile);
    const generation = generationMap(gen);
    result.seed = longString(generation.seed) ?? longString(data.RandomSeed);
    result.preset = preset(data, generation);
    result.structures = bool(generation.generate_structures ?? generation.generate_features ?? data.MapFeatures);
    if (group.rulesFile) {
      const rules = group.rulesFile === group.metadataFile ? level : await loadDocument(root, group.rulesFile);
      result.gameRules = gameRules(rulesMap(rules, group.rulesFile !== group.metadataFile));
    }
    const timestamps = await Promise.all([...new Set([group.metadataFile, group.rulesFile, group.generationFile].filter((file): file is string => Boolean(file)))].map(async (file) => (await lstat(await safeWorldPath(root, file))).mtimeMs));
    result.lastSavedAt = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
    if (!result.seed) result.warnings.push('The actual saved generation seed is unavailable in this world format.');
    if (group.layout.startsWith('modern') && (!group.rulesFile || !group.generationFile)) {
      result.readOnlyReason ??= 'Some modern world metadata files are missing. Finish a successful server save or restore a complete backup before editing this world.';
      result.warnings.push(result.readOnlyReason);
    }
  } catch (error) {
    result.readOnlyReason = error instanceof Error ? error.message : 'World metadata could not be read.';
    result.warnings.push(result.readOnlyReason);
  }
  return result;
}

function setNumericBoolean(map: Compound, key: string, value: boolean): void {
  const existing = map[key];
  if (!existing || !['byte', 'int', 'short', 'string'].includes(existing.type)) throw new AppError(422, 'world_setting_unsupported', 'This world does not expose a supported ' + key + ' setting.');
  existing.value = existing.type === 'string' ? String(value) : value ? 1 : 0;
}
function setDifficulty(data: Compound, value: WorldDifficulty): void {
  const modern = compound(data.difficulty_settings);
  if (modern?.difficulty?.type === 'string') modern.difficulty.value = value;
  else if (data.Difficulty && ['byte', 'short', 'int'].includes(data.Difficulty.type)) data.Difficulty.value = ['peaceful', 'easy', 'normal', 'hard'].indexOf(value);
  else throw new AppError(422, 'world_setting_unsupported', 'This world does not expose a supported difficulty setting.');
}
function setPacks(data: Compound, enabled?: string[], disabled?: string[]): void {
  const packs = compound(data.DataPacks) ?? compound(data.data_packs);
  if (!packs) throw new AppError(422, 'world_setting_unsupported', 'This world does not expose a supported datapack selection.');
  const write = (legacy: string, modern: string, values: string[]) => {
    const key = packs[legacy] ? legacy : packs[modern] ? modern : legacy;
    packs[key] = { type: 'list', value: { type: 'string', value: values } };
  };
  if (enabled) write('Enabled', 'enabled', enabled);
  if (disabled) write('Disabled', 'disabled', disabled);
}

/** Caller holds the stopped-server lock and has journalled every metadataFiles path. */
export async function patchWorldMetadata(root: string, group: WorldGroup, changes: WorldMetadataChanges): Promise<void> {
  if (group.readOnlyReason || !group.metadataFile) throw new AppError(409, 'world_read_only', group.readOnlyReason ?? 'Generate this world before editing saved metadata.');
  const documents = new Map<string, Document>();
  for (const file of [...new Set([group.metadataFile, group.rulesFile, group.generationFile].filter((file): file is string => Boolean(file)))]) documents.set(file, await loadDocument(root, file));
  const level = documents.get(group.metadataFile)!;
  const dirty = new Set<string>();
  if (changes.hardcore !== undefined) {
    if (typeof changes.hardcore !== 'boolean') throw new AppError(400, 'invalid_world_setting', 'Hardcore must be a boolean.');
    setNumericBoolean(level.data, 'hardcore', changes.hardcore);
    if (changes.hardcore) setDifficulty(level.data, 'hard');
    dirty.add(group.metadataFile);
  }
  if (changes.difficulty !== undefined) {
    if (!['peaceful', 'easy', 'normal', 'hard'].includes(changes.difficulty)) throw new AppError(400, 'invalid_world_setting', 'Choose a valid Minecraft difficulty.');
    if (bool(level.data.hardcore) === true && changes.difficulty !== 'hard') throw new AppError(422, 'hardcore_difficulty', 'Hardcore worlds require Hard difficulty.');
    setDifficulty(level.data, changes.difficulty);
    dirty.add(group.metadataFile);
  }
  if (changes.rules) {
    if (!group.rulesFile) throw new AppError(422, 'world_rules_unavailable', 'This world has no supported saved game rules.');
    const document = documents.get(group.rulesFile)!;
    const map = rulesMap(document, group.rulesFile !== group.metadataFile);
    const definitions = new Map(gameRules(map).map((rule) => [rule.id, rule]));
    for (const [id, value] of Object.entries(changes.rules)) {
      const definition = definitions.get(id);
      if (!definition?.editable || !map?.[id]) throw new AppError(422, 'unknown_game_rule', 'The saved game rule ' + id + ' is not supported for editing.');
      if (definition.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isSafeInteger(value) || value < definition.minimum! || value > definition.maximum!) {
        throw new AppError(400, 'invalid_game_rule', 'The game rule ' + id + ' has an invalid value.');
      }
      const tag = map[id]!;
      const stored = typeof value === 'boolean' ? value ? 1 : 0 : value;
      if ((tag.type === 'byte' && (stored < -128 || stored > 127)) || (tag.type === 'short' && (stored < -32_768 || stored > 32_767))) {
        throw new AppError(400, 'invalid_game_rule', 'The value does not fit this saved game rule type.');
      }
      tag.value = tag.type === 'string' ? String(value) : stored;
    }
    dirty.add(group.rulesFile);
  }
  if (changes.enabledPacks || changes.disabledPacks) {
    for (const values of [changes.enabledPacks, changes.disabledPacks]) if (values && (values.length > 256 || values.some((value) => typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)))) {
      throw new AppError(400, 'invalid_datapack_selection', 'Datapack identifiers are invalid or too numerous.');
    }
    setPacks(level.data, changes.enabledPacks, changes.disabledPacks);
    dirty.add(group.metadataFile);
  }
  // Prepare and validate all serialized documents before replacing any file.
  const serialized = [...dirty].map((file) => {
    const document = documents.get(file)!;
    const raw = nbt.writeUncompressed(document.tree, 'big');
    if (raw.length > MAX_INFLATED_BYTES) throw new AppError(413, 'world_metadata_too_large', 'The edited world metadata is too large.');
    const content = document.compression === 'gzip' ? gzipSync(raw) : document.compression === 'zlib' ? deflateSync(raw) : raw;
    return { document, content };
  });
  for (const { document, content } of serialized) {
    if (!(await readFile(await safeWorldPath(root, document.relative))).equals(document.original)) throw new AppError(409, 'world_metadata_changed', 'The saved world changed during editing. Refresh and try again.');
    const temporary = document.path + '.nodepilot-' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: document.mode & 0o777 });
      await rename(temporary, document.path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}

export async function metadataRevision(root: string, group: WorldGroup): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify({ folder: group.folder, members: group.members, layout: group.layout }));
  for (const file of metadataFiles(group)) {
    hash.update(file);
    try {
      const absolute = await safeWorldPath(root, file);
      const info = await lstat(absolute);
      if (!info.isFile() || info.size > MAX_COMPRESSED_BYTES) {
        hash.update('unreadable:' + info.size + ':' + info.mtimeMs + ':' + info.mode);
        continue;
      }
      hash.update(await readFile(absolute));
    } catch (error) {
      // A broken/linked metadata file must remain visible as read-only in the
      // catalogue. Fingerprinting it must not turn the entire listing into 500.
      hash.update((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable:' + String((error as {code?: unknown}).code ?? 'metadata'));
    }
  }
  return hash.digest('hex');
}
