import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import { parseJavaProperties, patchJavaProperties } from '../lib/java-properties.js';
import { activeWorldPlayerDirectories, discoverWorldGroups, resolveWorldGroup, safeWorldPath } from '../lib/world-layout.js';
import { metadataFiles, metadataRevision, patchWorldMetadata, readWorldMetadata } from '../lib/world-metadata.js';
import { FileService } from '../services/file-service.js';
import type { ServerRecord } from '../types.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-world-foundation-'));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('nodepilot-world-foundation-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function legacyTree(seed: [number, number] = [-2_147_483_648, 0]): nbt.NBT {
  return { name: '', type: 'compound', value: { Data: { type: 'compound', value: {
    LevelName: nbt.string('Existing world'), DataVersion: nbt.int(3465), Version: nbt.comp({ Name: nbt.string('1.20.1') }),
    RandomSeed: { type: 'long', value: seed }, hardcore: nbt.byte(0), Difficulty: nbt.byte(2),
    WorldGenSettings: nbt.comp({ seed: { type: 'long', value: seed }, generate_features: nbt.byte(1) }),
    GameRules: nbt.comp({ doDaylightCycle: nbt.string('true'), keepInventory: nbt.string('false'), randomTickSpeed: nbt.string('3'), 'custom:rule': nbt.string('preserve') }),
    DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }),
    'custom:metadata': nbt.comp({ exact: { type: 'long', value: [2_147_483_647, -1] }, bytes: nbt.byteArray([1, 2, 3]), nested: nbt.comp({ message: nbt.string('preserve me') }) }),
  } } } } as nbt.NBT;
}

async function saveNbt(root: string, relative: string, tree: nbt.NBT, compression: 'gzip' | 'zlib' | 'none' = 'gzip') {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const raw = nbt.writeUncompressed(tree);
  await writeFile(target, compression === 'gzip' ? gzipSync(raw) : compression === 'zlib' ? deflateSync(raw) : raw);
}

test('Java properties parse escapes, continuation, separators, duplicate values and comment backslashes', () => {
  const input = '# comment\\\r\nlevel-name : custom\\ world\r\nlevel-seed=first\r\nlevel-seed=second\r\nmotd=Hi\\nthere\\u0021\r\ngenerator-settings={\\\r\n  "biome":"minecraft:plains"}\r\npath=C\\:\\\\Java\r\n';
  const values = parseJavaProperties(input);
  assert.equal(values['level-name'], 'custom world');
  assert.equal(values['level-seed'], 'second');
  assert.equal(values.motd, 'Hi\nthere!');
  assert.equal(values['generator-settings'], '{"biome":"minecraft:plains"}');
  assert.equal(values.path, 'C:\\Java');
  const patched = patchJavaProperties(input, { 'level-name': 'new world', motd: ' hello\nnext' });
  assert.ok(patched.startsWith('# comment\\\r\n'));
  assert.ok(patched.includes('generator-settings={\\\r\n  "biome":"minecraft:plains"}\r\n'));
  assert.equal(parseJavaProperties(patched).motd, ' hello\nnext');
  assert.equal(parseJavaProperties(patched)['level-name'], 'new world');
  assert.equal(parseJavaProperties(patchJavaProperties(input, {}, ['level-seed']))['level-seed'], undefined);
});

test('property patches preserve comments while FileService retains explicit removal semantics', async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, 'server');
  await mkdir(directory);
  await writeFile(path.join(directory, 'server.properties'), '# important\nlevel-name=world\ncustom-setting=keep\\ me\nremove-me=yes\n');
  const server = { directory: 'server' } as ServerRecord;
  const files = new FileService(root);
  const values = await files.getProperties(server);
  delete values['remove-me'];
  values['level-name'] = 'new-world';
  values['generator-settings'] = JSON.stringify({ settings: 'x'.repeat(700) });
  await files.saveProperties(server, values);
  const saved = await readFile(path.join(directory, 'server.properties'), 'utf8');
  assert.ok(saved.startsWith('# important\n'));
  assert.equal(parseJavaProperties(saved)['custom-setting'], 'keep me');
  assert.equal(parseJavaProperties(saved)['remove-me'], undefined);
  assert.equal(parseJavaProperties(saved)['generator-settings'], values['generator-settings']);
});

test('legacy Paper dimensions are grouped without registering Nether/End as independent worlds', async (t) => {
  const root = await fixture(t);
  await saveNbt(root, 'world/level.dat', legacyTree());
  await saveNbt(root, 'world_nether/level.dat', legacyTree());
  await saveNbt(root, 'world_the_end/level.dat', legacyTree());
  await mkdir(path.join(root, 'world_nether/DIM-1'), { recursive: true });
  await mkdir(path.join(root, 'world_the_end/DIM1'), { recursive: true });
  const groups = await discoverWorldGroups(root, 'paper', '1.20.1', 'world');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].layout, 'legacy-paper');
  assert.deepEqual(groups[0].members, ['world', 'world_nether', 'world_the_end']);
  assert.deepEqual(groups[0].dimensions, ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']);
});

test('legacy Java custom dimensions stay in their complete world group', async (t) => {
  const root = await fixture(t);
  await saveNbt(root, 'world/level.dat', legacyTree());
  await mkdir(path.join(root, 'world/DIM-1'), { recursive: true });
  await mkdir(path.join(root, 'world/DIM1'), { recursive: true });
  await mkdir(path.join(root, 'world/dimensions/example/moon'), { recursive: true });
  await mkdir(path.join(root, 'world/dimensions/example/solar_system/mars/region'), { recursive: true });
  const group = await resolveWorldGroup(root, 'world', 'forge', '1.20.1');
  assert.equal(group.layout, 'legacy-java');
  assert.deepEqual(group.members, ['world']);
  assert.ok(group.dimensions.includes('example:moon'));
  assert.ok(group.dimensions.includes('example:solar_system/mars'));
  assert.ok(!group.dimensions.includes('example:solar_system'));
});

test('nonempty directories without world metadata remain read-only while prepared datapacks are allowed', async (t) => {
  const root=await fixture(t);
  await mkdir(path.join(root,'custom-progress'),{recursive:true});
  await writeFile(path.join(root,'custom-progress','global.db'),'must remain untouched');
  const unknown=await resolveWorldGroup(root,'custom-progress','paper','26.3');
  assert.match(unknown.readOnlyReason??'',/nonempty.*level.dat/);
  await mkdir(path.join(root,'prepared','datapacks'),{recursive:true});
  const prepared=await resolveWorldGroup(root,'prepared','paper','26.3');
  assert.equal(prepared.readOnlyReason,null);
  assert.equal(await readFile(path.join(root,'custom-progress','global.db'),'utf8'),'must remain untouched');
});

test('prepared worlds have no invented seed or generated status', async (t) => {
  const root = await fixture(t);
  const group = await resolveWorldGroup(root, 'new-world', 'paper', '26.3');
  assert.equal(group.readOnlyReason, null);
  assert.equal(group.layout, 'modern-paper');
  assert.deepEqual(group.members, ['new-world']);
  const metadata = await readWorldMetadata(root, group);
  assert.equal(metadata.generated, false);
  assert.equal(metadata.seed, null);
  assert.equal(metadata.difficulty, null);
  assert.equal(metadata.readOnlyReason, null);
  assert.equal((await metadataRevision(root, group)).length, 64);
});

test('misconfigured world names never adopt protected server-wide directories or their children', async (t) => {
  const root = await fixture(t);
  for (const folder of ['plugins', 'mods', 'libraries', 'config', 'defaultconfigs', 'logs', 'cache', 'versions', 'backups', 'crash-reports', 'debug', 'node_modules', '.git', '.nodepilot']) {
    await mkdir(path.join(root, folder));
    await writeFile(path.join(root, folder, 'global.txt'), 'keep server-wide data');
    // Even misleading level.dat files must not turn protected data into a world.
    await saveNbt(root, folder + '/level.dat', legacyTree());
    for (const requested of [folder, folder + '/nested-world']) {
      const group = await resolveWorldGroup(root, requested, 'paper', '1.20.1');
      assert.deepEqual(group.members, []);
      assert.equal(group.layout, 'unknown');
      assert.match(group.readOnlyReason!, /protected server-wide directory/);
      assert.equal((await readWorldMetadata(root, group)).generated, false);
    }
    assert.equal(await readFile(path.join(root, folder, 'global.txt'), 'utf8'), 'keep server-wide data');
  }
  await writeFile(path.join(root, 'server.properties'), 'level-name=plugins\n');
  const listing = await discoverWorldGroups(root, 'paper', '1.20.1', 'plugins');
  assert.equal(listing.length, 1);
  assert.equal(listing[0].folder, 'plugins');
  assert.deepEqual(listing[0].members, []);
  assert.match(listing[0].readOnlyReason!, /protected server-wide/);
  assert.deepEqual(await activeWorldPlayerDirectories(root), []);
});

test('actual signed 64-bit seeds and unknown typed data survive metadata edits', async (t) => {
  const root = await fixture(t);
  await saveNbt(root, 'world/level.dat', legacyTree());
  const group = await resolveWorldGroup(root, 'world', 'vanilla', '1.20.1');
  const before = await readWorldMetadata(root, group);
  assert.equal(before.seed, '-9223372036854775808');
  const revision = await metadataRevision(root, group);
  const original = nbt.parseUncompressed(gunzipSync(await readFile(path.join(root, 'world/level.dat'))));
  await patchWorldMetadata(root, group, { difficulty: 'easy', rules: { keepInventory: true, randomTickSpeed: 9 } });
  const after = await readWorldMetadata(root, group);
  assert.equal(after.seed, before.seed);
  assert.equal(after.difficulty, 'easy');
  assert.equal(after.gameRules.find((rule) => rule.id === 'keepInventory')?.value, true);
  assert.equal(after.gameRules.find((rule) => rule.id === 'custom:rule')?.editable, false);
  const changed = nbt.parseUncompressed(gunzipSync(await readFile(path.join(root, 'world/level.dat'))));
  const originalData = original.value.Data as nbt.Compound;
  const changedData = changed.value.Data as nbt.Compound;
  assert.ok(nbt.equal(originalData.value['custom:metadata']!, changedData.value['custom:metadata']!));
  assert.notEqual(await metadataRevision(root, group), revision);
  assert.ok(metadataFiles(group).includes('world/level.dat_old'));
});

test('maximum seed and zlib/uncompressed metadata retain precise values and encoding', async (t) => {
  const root = await fixture(t);
  for (const encoding of ['zlib', 'none'] as const) {
    await saveNbt(root, encoding + '/level.dat', legacyTree([2_147_483_647, -1]), encoding);
    const group = await resolveWorldGroup(root, encoding, 'vanilla', '1.20.1');
    assert.equal((await readWorldMetadata(root, group)).seed, '9223372036854775807');
    const first = (await readFile(path.join(root, encoding, 'level.dat')))[0];
    await patchWorldMetadata(root, group, { hardcore: true, difficulty: 'hard' });
    assert.equal((await readFile(path.join(root, encoding, 'level.dat')))[0], first);
    assert.equal((await readWorldMetadata(root, group)).hardcore, true);
  }
});

test('modern Vanilla and Paper read and update their actual separate metadata files', async (t) => {
  const root = await fixture(t);
  for (const software of ['vanilla', 'paper'] as const) {
    const folder = software + '-world';
    const base = software === 'paper' ? folder + '/dimensions/minecraft/overworld/data/minecraft' : folder + '/data/minecraft';
    const level = { name: '', type: 'compound', value: { Data: nbt.comp({ LevelName: nbt.string(folder), Version: nbt.comp({ Name: nbt.string('26.3') }), DataVersion: nbt.int(5000), hardcore: nbt.byte(0), difficulty_settings: nbt.comp({ difficulty: nbt.string('normal'), locked: nbt.byte(0) }), DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }) }) } } as nbt.NBT;
    await saveNbt(root, folder + '/level.dat', level);
    await saveNbt(root, base + '/world_gen_settings.dat', { name: '', type: 'compound', value: { DataVersion: nbt.int(5000), data: nbt.comp({ seed: { type: 'long', value: [2_147_483_647, -1] }, generate_structures: nbt.byte(1), 'custom:tag': nbt.string('keep') }) } } as nbt.NBT);
    await saveNbt(root, base + '/game_rules.dat', { name: '', type: 'compound', value: { DataVersion: nbt.int(5000), data: nbt.comp({ 'minecraft:keep_inventory': nbt.byte(0), 'minecraft:random_tick_speed': nbt.int(3), 'minecraft:fire_spread_radius_around_player': nbt.int(128), 'custom:rule': nbt.string('unknown') }) } } as nbt.NBT);
    await mkdir(path.join(root, folder, 'dimensions/minecraft/overworld'), { recursive: true });
    const group = await resolveWorldGroup(root, folder, software, '26.3');
    assert.equal(group.layout, software === 'paper' ? 'modern-paper' : 'modern-java');
    const before = await readWorldMetadata(root, group);
    assert.equal(before.seed, '9223372036854775807');
    assert.equal(before.difficulty, 'normal');
    assert.equal(before.minecraftVersion, '26.3');
    await patchWorldMetadata(root, group, { difficulty: 'easy', rules: { 'minecraft:keep_inventory': true, 'minecraft:random_tick_speed': 5, 'minecraft:fire_spread_radius_around_player': -1 }, enabledPacks: ['vanilla', 'file/test.zip'], disabledPacks: [] });
    const after = await readWorldMetadata(root, group);
    assert.equal(after.readOnlyReason, null);
    assert.equal(after.difficulty, 'easy');
    assert.equal(after.gameRules.find((rule) => rule.id === 'minecraft:keep_inventory')?.value, true);
    assert.deepEqual(after.enabledPacks, ['vanilla', 'file/test.zip']);
    assert.equal(after.seed, before.seed);
  }
});

test('invalid or unknown rule edits are rejected without replacing any metadata', async (t) => {
  const root = await fixture(t);
  await saveNbt(root, 'world/level.dat', legacyTree());
  const group = await resolveWorldGroup(root, 'world', 'vanilla', '1.20.1');
  const original = await readFile(path.join(root, 'world/level.dat'));
  await assert.rejects(patchWorldMetadata(root, group, { rules: { randomTickSpeed: -1 } }), /invalid value/);
  await assert.rejects(patchWorldMetadata(root, group, { rules: { 'custom:rule': true } }), /not supported/);
  await assert.rejects(patchWorldMetadata(root, group, { hardcore: true, difficulty: 'easy' }), /Hardcore worlds/);
  assert.deepEqual(await readFile(path.join(root, 'world/level.dat')), original);
});

test('corrupt or unknown metadata is read-only instead of returning invented statistics', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken/level.dat'), Buffer.from([0x1f, 0x8b, 1, 2]));
  const broken = await readWorldMetadata(root, await resolveWorldGroup(root, 'broken', 'paper', '26.3'));
  assert.equal(broken.generated, false);
  assert.match(broken.readOnlyReason!, /corrupt/);
  assert.equal(broken.seed, null);
  await saveNbt(root, 'unknown/level.dat', { name: '', type: 'compound', value: { unrelated: nbt.string('not a world') } });
  const unknown = await readWorldMetadata(root, await resolveWorldGroup(root, 'unknown', 'vanilla', '1.20.1'));
  assert.equal(unknown.generated, false);
  assert.match(unknown.readOnlyReason!, /recognized Java/);
});

test('ambiguous mixed layouts and incomplete modern metadata remain visible but read-only', async (t) => {
  const root = await fixture(t);
  await saveNbt(root, 'world/level.dat', legacyTree());
  await mkdir(path.join(root, 'world/DIM-1'), { recursive: true });
  await mkdir(path.join(root, 'world_nether/DIM-1'), { recursive: true });
  const duplicate = await resolveWorldGroup(root, 'world', 'paper', '1.20.1');
  assert.match(duplicate.readOnlyReason!, /same dimension/);
  await mkdir(path.join(root, 'world/dimensions/minecraft/overworld'), { recursive: true });
  const mixed = await resolveWorldGroup(root, 'world', 'paper', '26.1');
  assert.match(mixed.readOnlyReason!, /legacy and modern/);
  assert.ok(mixed.members.includes('world_nether'));
  await saveNbt(root, 'modern/level.dat', legacyTree());
  await mkdir(path.join(root, 'modern/dimensions/minecraft/overworld'), { recursive: true });
  const incomplete = await readWorldMetadata(root, await resolveWorldGroup(root, 'modern', 'paper', '26.1'));
  assert.equal(incomplete.generated, true);
  assert.match(incomplete.readOnlyReason!, /metadata files are missing/);
});

test('oversized metadata has a bounded revision and read-only diagnostics instead of breaking the library', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'oversized'));
  const handle = await open(path.join(root, 'oversized/level.dat'), 'wx');
  try { await handle.truncate(17 * 1024 * 1024); } finally { await handle.close(); }
  const group = await resolveWorldGroup(root, 'oversized', 'vanilla', '1.20.1');
  assert.match((await readWorldMetadata(root, group)).readOnlyReason!, /16 MB/);
  assert.match(await metadataRevision(root, group), /^[0-9a-f]{64}$/);
});

test('active player discovery ignores inactive worlds and recognizes modern player storage', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'server.properties'), 'level-name=world-b\n');
  await mkdir(path.join(root, 'world-a/playerdata'), { recursive: true });
  await mkdir(path.join(root, 'world-b/players/data'), { recursive: true });
  await mkdir(path.join(root, 'playerdata'), { recursive: true });
  assert.deepEqual(await activeWorldPlayerDirectories(root), [path.join(root, 'world-b/players/data')]);
  await writeFile(path.join(root, 'server.properties'), 'level-name=world-a\n');
  assert.deepEqual(await activeWorldPlayerDirectories(root), [path.join(root, 'world-a/playerdata')]);
});

test('linked world/dimension paths and traversal are blocked without reading outside data', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await saveNbt(outside, 'external/level.dat', legacyTree());
  await symlink(path.join(outside, 'external'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await resolveWorldGroup(root, 'linked', 'paper', '26.3');
  assert.match(linked.readOnlyReason!, /links|junctions/);
  assert.equal((await readWorldMetadata(root, linked)).generated, false);
  await assert.rejects(safeWorldPath(root, '../external'), /inside/);
  await assert.rejects(safeWorldPath(root, '.'), /inside/);
  await saveNbt(root, 'world/level.dat', legacyTree());
  await mkdir(path.join(root, 'world/dimensions/example'), { recursive: true });
  await symlink(path.join(outside, 'external'), path.join(root, 'world/dimensions/example/moon'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await resolveWorldGroup(root, 'world', 'forge', '1.20.1')).readOnlyReason!, /linked/);
  assert.deepEqual(await readdir(path.join(outside, 'external')), ['level.dat']);
});
