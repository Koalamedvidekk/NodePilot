import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import * as yazl from 'yazl';
import { resolveWorldGroup } from '../lib/world-layout.js';
import { readWorldMetadata } from '../lib/world-metadata.js';
import { inspectSafeWorldZip, safeWorldArchivePath, WorldArchiveService } from '../services/world-archive-service.js';
import { WorldDatapackService } from '../services/world-datapack-service.js';
import type { ServerRecord } from '../types.js';

async function fixture(t: TestContext, modern = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-world-transfers-'));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('nodepilot-world-transfers-'));
    await rm(root, { recursive: true, force: true });
  });
  const config = { dataDirectory: path.join(root, 'data'), serversDirectory: path.join(root, 'servers'), backupsDirectory: path.join(root, 'backups') };
  const server = { id: randomUUID(), directory: 'test-server', software: 'paper', version: modern ? '26.1' : '1.20.1', startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] } } as ServerRecord;
  const directory = path.join(config.serversDirectory, server.directory);
  await mkdir(directory, { recursive: true });
  const tree = { name: '', type: 'compound', value: { Data: nbt.comp({ LevelName: nbt.string('world'), Version: nbt.comp({ Name: nbt.string(server.version) }), Difficulty: nbt.byte(2), hardcore: nbt.byte(0), RandomSeed: { type: 'long', value: [2_147_483_647, -1] }, GameRules: nbt.comp({ keepInventory: nbt.string('false') }), DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla', 'fabric'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }) }) } } as nbt.NBT;
  const level = gzipSync(nbt.writeUncompressed(tree));
  for (const member of ['world', 'world_nether', 'world_the_end']) {
    await mkdir(path.join(directory, member), { recursive: true });
    await writeFile(path.join(directory, member, 'level.dat'), level);
  }
  await mkdir(path.join(directory, 'world_nether/DIM-1/region'), { recursive: true });
  await mkdir(path.join(directory, 'world_the_end/DIM1/region'), { recursive: true });
  await mkdir(path.join(directory, 'world/playerdata'), { recursive: true });
  await mkdir(path.join(directory, 'world/advancements'), { recursive: true });
  await mkdir(path.join(directory, 'world/stats'), { recursive: true });
  await writeFile(path.join(directory, 'world/playerdata/player.dat'), Buffer.from([1, 2, 3, 255]));
  await writeFile(path.join(directory, 'world/advancements/player.json'), '{"separate":true}');
  await writeFile(path.join(directory, 'world/stats/player.json'), '{"xp":37}');
  await writeFile(path.join(directory, 'world_nether/DIM-1/region/r.0.0.mca'), 'nether chunks');
  await writeFile(path.join(directory, 'world_the_end/DIM1/region/r.0.0.mca'), 'end chunks');
  const group = await resolveWorldGroup(directory, 'world', server.software, server.version);
  return { root, config, directory, server, group, archives: new WorldArchiveService(config), packs: new WorldDatapackService(config.serversDirectory) };
}

async function zip(filename: string, entries: Array<{ name: string; contents: string | Buffer; mode?: number; compress?: boolean }>) {
  await mkdir(path.dirname(filename), { recursive: true });
  const archive = new yazl.ZipFile();
  const result = pipeline(archive.outputStream, createWriteStream(filename, { flags: 'wx' }));
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.contents), entry.name, { mode: entry.mode, compress: entry.compress });
  archive.end();
  await result;
}

async function runtime(directory: string, version: string, modern: boolean) {
  await zip(path.join(directory, 'cache', 'vanilla.jar'), [{ name: 'version.json', contents: JSON.stringify({ id: version, pack_version: modern ? { data_major: 101, data_minor: 1 } : { data: 15 } }) }]);
}

async function pack(root: string, name: string, metadata: Record<string, unknown>, extra = 'data/test/function/example.mcfunction') {
  const target = path.join(root, name);
  await zip(target, [{ name: 'pack.mcmeta', contents: JSON.stringify({ pack: { description: name, ...metadata } }) }, { name: extra, contents: 'say hello' }]);
  return target;
}

test('ZIP export/import roundtrip preserves grouped dimensions, exact metadata and world-specific player progress', async (t) => {
  const { config, directory, server, group, archives } = await fixture(t);
  const archive = path.join(config.dataDirectory, 'exports', 'world.zip');
  const progress: Array<[number, number]> = [];
  const exported = await archives.exportWorld(server, group, archive, (done, total) => progress.push([done, total]));
  assert.ok(exported.sizeBytes > 0);
  assert.equal(progress.at(-1)?.[0], progress.at(-1)?.[1]);
  const inspected = await archives.inspect(server, archive);
  assert.equal(inspected.candidates.length, 1);
  assert.equal(inspected.candidates[0].seed, '9223372036854775807');
  assert.equal(inspected.candidates[0].layout, 'legacy-paper');
  const imported = await archives.importWorld(server, inspected.id, inspected.candidates[0].id, 'imported');
  assert.deepEqual(imported.members, ['imported', 'imported_nether', 'imported_the_end']);
  for (const [original, copy] of [['world/level.dat', 'imported/level.dat'], ['world/playerdata/player.dat', 'imported/playerdata/player.dat'], ['world/advancements/player.json', 'imported/advancements/player.json'], ['world/stats/player.json', 'imported/stats/player.json'], ['world_nether/DIM-1/region/r.0.0.mca', 'imported_nether/DIM-1/region/r.0.0.mca'], ['world_the_end/DIM1/region/r.0.0.mca', 'imported_the_end/DIM1/region/r.0.0.mca']]) {
    assert.deepEqual(await readFile(path.join(directory, original)), await readFile(path.join(directory, copy)));
  }
  assert.deepEqual(await readFile(path.join(config.dataDirectory, 'worlds/imports', inspected.id, 'source.zip')), await readFile(archive));
  await assert.rejects(archives.importWorld({ ...server, id: randomUUID() }, inspected.id, inspected.candidates[0].id, 'foreign'), /does not exist for this server/);
  const original = await readFile(path.join(directory, 'imported/level.dat'));
  await assert.rejects(archives.importWorld(server, inspected.id, inspected.candidates[0].id, 'imported'), /already exists/);
  assert.deepEqual(await readFile(path.join(directory, 'imported/level.dat')), original);
});

test('ordinary world ZIPs at the root and with wrapper folders import without moving source data', async (t) => {
  const { root, directory, server, archives } = await fixture(t);
  for (const prefix of ['', 'My world/']) {
    const archive = path.join(root, 'ordinary-' + (prefix ? 'wrapped' : 'root') + '.zip');
    await zip(archive, [{ name: prefix + 'level.dat', contents: await readFile(path.join(directory, 'world/level.dat')) }, { name: prefix + 'dimensions/example/moon/region/r.0.0.mca', contents: 'custom dimension' }]);
    const inspection = await archives.inspect(server, archive);
    assert.ok(inspection.candidates[0].dimensions.includes('example:moon'));
    const imported = await archives.importWorld(server, inspection.id, inspection.candidates[0].id, prefix ? 'wrapped' : 'plain');
    assert.deepEqual(await readFile(path.join(directory, imported.folder, 'dimensions/example/moon/region/r.0.0.mca')), Buffer.from('custom dimension'));
  }
});

test('modern26 Vanilla and Paper bundles preserve separate generation/rules files and all player directories', async (t) => {
  for (const software of ['vanilla', 'paper'] as const) {
    const { config, directory, server: originalServer, archives } = await fixture(t, true);
    const server = { ...originalServer, software };
    for (const member of ['world_nether', 'world_the_end']) {
      const target = path.join(directory, member);
      assert.equal(path.dirname(target), directory);
      await rm(target, { recursive: true });
    }
    await mkdir(path.join(directory, 'world/players'));
    for (const [before, after] of [['playerdata', 'data'], ['advancements', 'advancements'], ['stats', 'stats']]) await rename(path.join(directory, 'world', before), path.join(directory, 'world/players', after));
    const save = async (relative: string, value: object) => {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, gzipSync(nbt.writeUncompressed({ name: '', type: 'compound', value } as nbt.NBT)));
    };
    await save('world/level.dat', { Data: nbt.comp({ LevelName: nbt.string('modern'), hardcore: nbt.byte(0), Version: nbt.comp({ Name: nbt.string('26.1') }), difficulty_settings: nbt.comp({ difficulty: nbt.string('normal') }), DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }) }) });
    const base = software === 'paper' ? 'world/dimensions/minecraft/overworld/data/minecraft' : 'world/data/minecraft';
    await save(base + '/world_gen_settings.dat', { DataVersion: nbt.int(5000), data: nbt.comp({ seed: { type: 'long', value: [-2_147_483_648, 0] }, generate_structures: nbt.byte(1), unknown: nbt.byteArray([7, 8, 9]) }) });
    await save(base + '/game_rules.dat', { DataVersion: nbt.int(5000), data: nbt.comp({ 'minecraft:keep_inventory': nbt.byte(1) }) });
    for (const dimension of ['overworld', 'the_nether', 'the_end']) {
      await mkdir(path.join(directory, 'world/dimensions/minecraft', dimension, 'region'), { recursive: true });
      await writeFile(path.join(directory, 'world/dimensions/minecraft', dimension, 'region/r.0.0.mca'), dimension);
    }
    const group = await resolveWorldGroup(directory, 'world', software, '26.1');
    assert.equal(group.layout, software === 'paper' ? 'modern-paper' : 'modern-java');
    assert.equal((await readWorldMetadata(directory, group)).readOnlyReason, null);
    const archive = path.join(config.dataDirectory, 'exports', software + '.zip');
    await archives.exportWorld(server, group, archive);
    const inspection = await archives.inspect(server, archive);
    assert.equal(inspection.candidates[0].seed, '-9223372036854775808');
    const imported = await archives.importWorld(server, inspection.id, inspection.candidates[0].id, 'imported');
    assert.deepEqual(imported.playerDirectories, ['imported/players/data']);
    assert.deepEqual(imported.dimensions.sort(), ['minecraft:overworld', 'minecraft:the_end', 'minecraft:the_nether']);
    const metadata = await readWorldMetadata(directory, imported);
    assert.equal(metadata.seed, '-9223372036854775808');
    assert.equal(metadata.gameRules.find((value) => value.id === 'minecraft:keep_inventory')?.value, true);
    for (const relative of ['players/data/player.dat', 'players/advancements/player.json', 'players/stats/player.json', group.generationFile!.slice('world/'.length), group.rulesFile!.slice('world/'.length)]) {
      assert.deepEqual(await readFile(path.join(directory, 'world', relative)), await readFile(path.join(directory, 'imported', relative)));
    }
  }
});

test('full backup restore replaces every member and refuses backups from a different world group', async (t) => {
  const { config, directory, server, group, archives } = await fixture(t);
  const backup = path.join(config.backupsDirectory, 'backup');
  await archives.copyWorld(server, group, backup);
  await writeFile(path.join(directory, 'world/playerdata/player.dat'), 'changed inventory');
  await writeFile(path.join(directory, 'world_nether/DIM-1/region/r.0.0.mca'), 'changed nether');
  await archives.restoreWorld(server, group, backup);
  assert.deepEqual(await readFile(path.join(directory, 'world/playerdata/player.dat')), Buffer.from([1, 2, 3, 255]));
  assert.equal(await readFile(path.join(directory, 'world_nether/DIM-1/region/r.0.0.mca'), 'utf8'), 'nether chunks');
  await assert.rejects(archives.restoreWorld(server, { ...group, folder: 'other', members: ['other'] }, backup), /different world group/);
  assert.equal((await readdir(directory)).some((name) => name.startsWith('.nodepilot-world-restore-')), false);
});

test('unsafe ZIP paths, links, duplicate aliases, expansion and corrupt contents are rejected', async (t) => {
  const { root, server, archives } = await fixture(t);
  for (const value of ['../outside', 'world/../../outside', 'C:/outside', 'world\\file', 'world/NUL.dat', 'world/file.', 'world/.env', 'world/.git/config']) assert.throws(() => safeWorldArchivePath(value));
  const duplicate = path.join(root, 'duplicate.zip');
  await zip(duplicate, [{ name: 'world/level.dat', contents: 'a' }, { name: 'World/level.dat', contents: 'b' }]);
  await assert.rejects(inspectSafeWorldZip(duplicate), /duplicate paths/);
  const traversal = path.join(root, 'traversal.zip');
  await zip(traversal, [{ name: 'worldx/evil.dat', contents: 'outside' }]);
  const traversalBuffer = await readFile(traversal);
  for (let index = traversalBuffer.indexOf(Buffer.from('worldx/evil.dat')); index >= 0; index = traversalBuffer.indexOf(Buffer.from('worldx/evil.dat'))) traversalBuffer.set(Buffer.from('../out/evil.dat'), index);
  await writeFile(traversal, traversalBuffer);
  await assert.rejects(archives.inspect(server, traversal), /invalid relative path|unsafe/);
  const linked = path.join(root, 'linked.zip');
  await zip(linked, [{ name: 'world/link', contents: '../external', mode: 0o120777 }]);
  await assert.rejects(inspectSafeWorldZip(linked), /links and special files/);
  const bomb = path.join(root, 'bomb.zip');
  await zip(bomb, [{ name: 'world/bomb', contents: Buffer.alloc(100_000) }]);
  await assert.rejects(inspectSafeWorldZip(bomb), /compression-ratio/);
  const corrupt = path.join(root, 'corrupt.zip');
  await zip(corrupt, [{ name: 'world/level.dat', contents: 'NBT PLACEHOLDER', compress: false }]);
  const buffer = await readFile(corrupt);
  buffer[buffer.indexOf(Buffer.from('NBT PLACEHOLDER'))] ^= 1;
  await writeFile(corrupt, buffer);
  await assert.rejects(archives.inspect(server, corrupt), /corrupt file data/);
});

test('linked live world files never get copied or exported', async (t) => {
  const { root, directory, config, server, group, archives } = await fixture(t);
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private/file.txt'), 'outside');
  await symlink(path.join(root, 'private'), path.join(directory, 'world/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(archives.copyWorld(server, group, path.join(config.backupsDirectory, 'linked')), /links|junctions/);
  await assert.rejects(archives.exportWorld(server, group, path.join(config.dataDirectory, 'exports', 'linked.zip')), /links|junctions/);
  assert.equal(await readFile(path.join(root, 'private/file.txt'), 'utf8'), 'outside');
});

test('insufficient disk space blocks staging and copying before any original world changes', async (t) => {
  const { config, directory, server, group, archives } = await fixture(t);
  const archive = path.join(config.dataDirectory, 'exports', 'world.zip');
  await archives.exportWorld(server, group, archive);
  const inspected = await archives.inspect(server, archive);
  const original = await readFile(path.join(directory, 'world/level.dat'));
  const noSpace = new WorldArchiveService(config, async (_directory, bytes) => { assert.ok(bytes > 0); throw new Error('not enough free disk space'); });
  await assert.rejects(noSpace.inspect(server, archive), /not enough free disk space/);
  await assert.rejects(noSpace.importWorld(server, inspected.id, inspected.candidates[0].id, 'no-space'), /not enough free disk space/);
  await assert.rejects(noSpace.copyWorld(server, group, path.join(config.backupsDirectory, 'no-space')), /not enough free disk space/);
  assert.deepEqual(await readFile(path.join(directory, 'world/level.dat')), original);
  assert.equal((await readdir(directory)).includes('no-space'), false);
});

test('legacy compatible datapacks upload disabled, retain portable names and enforce builtin protections', async (t) => {
  const { root, directory, server, group, packs } = await fixture(t);
  await runtime(directory, server.version, false);
  const upload = await pack(root, 'utilities.zip', { pack_format: 15 });
  const id = await packs.upload(server, group, upload, 'Utilities.zip');
  assert.equal(id, 'file/Utilities.zip');
  const metadata = await readWorldMetadata(directory, group);
  const list = await packs.list(server, group, metadata);
  assert.equal(list.find((value) => value.id === id)?.compatible, true);
  assert.equal(list.find((value) => value.id === id)?.enabled, false);
  assert.equal(list.find((value) => value.id === 'fabric')?.managed, true);
  await packs.validateSelection(server, group, metadata, ['vanilla', 'fabric', id], []);
  await assert.rejects(packs.validateSelection(server, group, metadata, ['fabric'], ['vanilla', id]), /must remain enabled/);
  await assert.rejects(packs.validateSelection(server, group, metadata, ['vanilla'], ['fabric', id]), /Software-managed/);
  await assert.rejects(packs.remove(server, group, 'vanilla'), /cannot be removed/);
  await assert.rejects(packs.upload(server, group, upload, 'utilities.zip'), /already exists/);
  await packs.remove(server, group, id);
  assert.equal((await packs.list(server, group, metadata)).some((value) => value.id === id), false);
});

test('modern runtime major/minor formats and integer maximum compatibility are respected', async (t) => {
  const { root, directory, server, group, packs } = await fixture(t, true);
  await runtime(directory, server.version, true);
  const upload = await pack(root, 'modern.zip', { min_format: [101], max_format: 101 });
  assert.equal(await packs.upload(server, group, upload, 'modern.zip'), 'file/modern.zip');
  const incompatible = await pack(root, 'old.zip', { min_format: [101, 0], max_format: [101, 0] });
  await assert.rejects(packs.upload(server, group, incompatible, 'old.zip'), /does not declare support/);
  const invalid = await pack(root, 'invalid.zip', { min_format: 101, max_format: [100, 9] });
  await assert.rejects(packs.upload(server, group, invalid, 'invalid.zip'), /valid minimum/);
});

test('world generation packs are creation-time choices and resource packs are rejected', async (t) => {
  const { root, directory, server, group, packs } = await fixture(t);
  await runtime(directory, server.version, false);
  const generation = await pack(root, 'generation.zip', { pack_format: 15 }, 'data/test/worldgen/biome/moon.json');
  await assert.rejects(packs.upload(server, group, generation, 'generation.zip'), /chosen before generation/);
  await mkdir(path.join(directory, 'prepared'));
  const prepared = await resolveWorldGroup(directory, 'prepared', server.software, server.version);
  assert.equal(await packs.upload(server, prepared, generation, 'generation.zip'), 'file/generation.zip');
  const resource = path.join(root, 'resource.zip');
  await zip(resource, [{ name: 'pack.mcmeta', contents: '{"pack":{"pack_format":15,"description":"resource"}}' }, { name: 'assets/test/a.png', contents: 'image' }]);
  await assert.rejects(packs.upload(server, prepared, resource, 'resource.zip'), /rather than a resource pack or mod/);
  const metadata = await readWorldMetadata(directory, group);
  await packs.copySelection(server, group, prepared, ['vanilla', 'fabric']);
  await assert.rejects(packs.validateSelection(server, group, metadata, ['vanilla', 'fabric', 'missing'], []), /listed for this world/);
});

test('verified built-in experiments are selectable only before generation without copying or exposing software-managed packs', async (t) => {
  const { directory, server, group, packs } = await fixture(t);
  const builtinMetadata = (flag: string) => JSON.stringify({ pack: { pack_format: 15, description: 'Built-in experiment' }, features: { enabled: [flag] } });
  await zip(path.join(directory, 'cache/vanilla.jar'), [
    { name: 'version.json', contents: JSON.stringify({ id: server.version, pack_version: { data: 15 } }) },
    { name: 'data/minecraft/datapacks/verified_experiment/pack.mcmeta', contents: builtinMetadata('minecraft:test_feature') },
    { name: 'data/minecraft/datapacks/ordinary_managed/pack.mcmeta', contents: JSON.stringify({ pack: { pack_format: 15, description: 'Software content without experimental flags' } }) },
  ]);
  // A stale JAR for another release must not add experiments to this server.
  await zip(path.join(directory, 'versions/stale.jar'), [
    { name: 'version.json', contents: JSON.stringify({ id: '1.19.4', pack_version: { data: 12 } }) },
    { name: 'data/minecraft/datapacks/unverified_experiment/pack.mcmeta', contents: builtinMetadata('minecraft:wrong_version') },
  ]);
  const metadata = await readWorldMetadata(directory, group);
  const list = await packs.list(server, group, metadata);
  const experiment = list.find((pack) => pack.id === 'verified_experiment');
  assert.equal(experiment?.compatible, true);
  assert.equal(experiment?.managed, false);
  assert.equal(experiment?.generationPack, true);
  assert.equal(experiment?.removable, false);
  assert.equal(list.some((pack) => pack.id === 'ordinary_managed'), false);
  assert.equal(list.some((pack) => pack.id === 'unverified_experiment'), false);
  assert.equal(list.find((pack) => pack.id === 'fabric')?.managed, true);
  await assert.rejects(packs.validateSelection(server, group, metadata, ['vanilla', 'fabric', 'verified_experiment'], []), /cannot be changed after generation/);
  await assert.rejects(packs.remove(server, group, 'verified_experiment'), /cannot be removed/);
  await packs.validateSelection(server, group, { ...metadata, generated: false }, ['vanilla', 'fabric', 'verified_experiment'], []);
  await mkdir(path.join(directory, 'prepared'));
  const prepared = await resolveWorldGroup(directory, 'prepared', server.software, server.version);
  await packs.copySelection(server, group, prepared, ['vanilla', 'fabric', 'verified_experiment']);
  assert.deepEqual(await readdir(path.join(directory, 'prepared')), []);
});
