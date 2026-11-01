import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { WorldRepository } from '../repositories/world-repository.js';
import { WorldService } from '../services/world-service.js';
import type { WorldOperation } from '../world-types.js';

async function saveNbt(root: string, relative: string, data: Record<string, unknown>) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, gzipSync(nbt.writeUncompressed({ name: '', type: 'compound', value: data } as nbt.NBT)));
}

async function writeLayout(root: string, modern: boolean, label: string) {
  const packs = nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } });
  const common = { LevelName: nbt.string('world'), Version: nbt.comp({ Name: nbt.string(modern ? '26.3' : '1.20.1') }), DataVersion: nbt.int(modern ? 5000 : 3465), hardcore: nbt.byte(0), DataPacks: packs, 'custom:preserve': nbt.string(label) };
  await saveNbt(root, 'world/level.dat', { Data: nbt.comp(modern ? {
    ...common, difficulty_settings: nbt.comp({ difficulty: nbt.string('normal') }),
  } : {
    ...common, Difficulty: nbt.byte(2), WorldGenSettings: nbt.comp({ seed: { type: 'long', value: [-2_147_483_648, 0] }, generate_features: nbt.byte(1) }),
    GameRules: nbt.comp({ keepInventory: nbt.string('false') }),
  }) });
  const player = modern ? 'world/players/data/owner.dat' : 'world/playerdata/owner.dat';
  await mkdir(path.dirname(path.join(root, player)), { recursive: true });
  await writeFile(path.join(root, player), label + ' inventory XP location');
  if (modern) {
    const base = 'world/dimensions/minecraft/overworld/data/minecraft';
    await saveNbt(root, base + '/world_gen_settings.dat', { DataVersion: nbt.int(5000), data: nbt.comp({ seed: { type: 'long', value: [2_147_483_647, -1] }, generate_structures: nbt.byte(1), 'custom:preserve': nbt.string(label) }) });
    await saveNbt(root, base + '/game_rules.dat', { DataVersion: nbt.int(5000), data: nbt.comp({ 'minecraft:keep_inventory': nbt.byte(1) }) });
  }
  for (const [dimension, legacy] of [['the_nether', 'world_nether/DIM-1'], ['the_end', 'world_the_end/DIM1']] as const) {
    const relative = modern ? 'world/dimensions/minecraft/' + dimension + '/region/chunks.mca' : legacy + '/region/chunks.mca';
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), label + ' ' + dimension);
  }
}

async function fileTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (relative: string) => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(next);
      else result[next] = (await readFile(path.join(root, next))).toString('hex');
    }
  };
  await walk('');
  return result;
}

async function fixture(t: TestContext, initialModern: boolean) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-world-transition-'));
  const dataDirectory = path.join(temporary, 'data');
  const serversDirectory = path.join(dataDirectory, 'servers');
  const root = path.join(serversDirectory, 'fixture');
  const backupsDirectory = path.join(dataDirectory, 'backups');
  await mkdir(root, { recursive: true });
  await writeLayout(root, initialModern, 'backup');
  await writeFile(path.join(root, 'server.properties'), '# keep comment\nlevel-name=world\nmotd=Keep me\n');
  await mkdir(path.join(root, 'plugins'));
  await writeFile(path.join(root, 'plugins/global-progress.db'), 'global unchanged');
  const database = openDatabase(path.join(dataDirectory, 'test.sqlite'));
  const servers = new ServerRepository(database);
  const id = randomUUID();
  servers.create({ id, machineId: 'local', name: 'Transition fixture', directory: 'fixture', software: 'paper', version: '26.3', port: 25565, memoryMb: 1024, eulaAccepted: true });
  servers.markReady(id);
  const service = new WorldService({ dataDirectory, serversDirectory, backupsDirectory }, servers, new WorldRepository(database), { isProcessActive: () => false });
  t.after(async () => {
    await service.stop(); database.close();
    assert.equal(path.dirname(temporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('nodepilot-world-transition-'));
    await rm(temporary, { recursive: true, force: true });
  });
  async function wait(operation: WorldOperation) {
    for (let count = 0; count < 1000; count++) {
      const current = service.operation(id, operation.id);
      if (current.state !== 'running') return current;
      await delay(5);
    }
    throw new Error('World transition operation timed out.');
  }
  const world = (await service.list(id)).worlds.find(value => value.active)!;
  assert.equal(world.readOnlyReason, null);
  const originalTree = await fileTree(root);
  const backup = await wait(await service.backup(id, world.id, world.revision));
  assert.equal(backup.state, 'succeeded', backup.error ?? undefined);
  for (const name of ['world', 'world_nether', 'world_the_end']) {
    const target = path.resolve(root, name);
    assert.equal(path.dirname(target), root);
    await rm(target, { recursive: true, force: true });
  }
  await writeLayout(root, !initialModern, 'current');
  const changed = await service.details(id, world.id);
  assert.equal(changed.world.readOnlyReason, null);
  assert.equal(changed.world.layout, initialModern ? 'legacy-paper' : 'modern-paper');
  return { root, service, id, worldId: world.id, backupId: backup.result!.backupId!, originalTree, wait };
}

for (const initialModern of [false, true]) {
  const direction = initialModern ? 'legacy siblings to modern single directory' : 'modern single directory to legacy siblings';
  test('restoration replaces the complete layout from ' + direction, async (t) => {
    const f = await fixture(t, initialModern);
    const details = await f.service.details(f.id, f.worldId);
    const result = await f.wait(await f.service.restore(f.id, f.worldId, f.backupId, { revision: details.world.revision, confirm: true }));
    assert.equal(result.state, 'succeeded', result.error ?? undefined);
    const restored = await f.service.details(f.id, f.worldId);
    assert.equal(restored.world.layout, initialModern ? 'modern-paper' : 'legacy-paper');
    assert.equal(restored.world.readOnlyReason, null);
    assert.equal(restored.backups.length, 2);
    const actual = await fileTree(f.root);
    // Selecting a restored primary world intentionally refreshes its generation
    // properties; all actual world/player/plugin bytes must match the backup.
    delete actual['server.properties']; delete f.originalTree['server.properties'];
    assert.deepEqual(actual, f.originalTree);
    assert.doesNotThrow(() => f.service.assertCanStart(f.id));
  });

  test('failure after restoration rolls back ' + direction + ' without leftover dimensions', async (t) => {
    const f = await fixture(t, initialModern);
    const before = await fileTree(f.root);
    const details = await f.service.details(f.id, f.worldId);
    const internals = f.service as unknown as { writeProperties: (...args: unknown[]) => Promise<void> };
    const write = internals.writeProperties;
    let actualRestorationObserved = false;
    internals.writeProperties = async () => {
      const player = initialModern ? 'world/players/data/owner.dat' : 'world/playerdata/owner.dat';
      assert.equal(await readFile(path.join(f.root, player), 'utf8'), 'backup inventory XP location');
      actualRestorationObserved = true;
      throw new Error('Simulated final settings write failure');
    };
    const result = await f.wait(await f.service.restore(f.id, f.worldId, f.backupId, { revision: details.world.revision, confirm: true }));
    internals.writeProperties = write;
    assert.equal(actualRestorationObserved, true);
    assert.equal(result.state, 'failed');
    assert.match(result.error!, /final settings write failure/);
    assert.deepEqual(await fileTree(f.root), before);
    assert.equal((await f.service.details(f.id, f.worldId)).world.layout, initialModern ? 'legacy-paper' : 'modern-paper');
    assert.doesNotThrow(() => f.service.assertCanStart(f.id));
  });
}
