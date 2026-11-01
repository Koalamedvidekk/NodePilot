import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import type { WorldOperation, WorldSummary } from '../world-types.js';

async function saveWorld(root: string, folder: string, inventory: string): Promise<void> {
  const tree: nbt.NBT = { name: '', type: 'compound', value: { Data: nbt.comp({
    LevelName: nbt.string(folder), Version: nbt.comp({ Name: nbt.string('1.20.1') }), DataVersion: nbt.int(3465),
    WorldGenSettings: nbt.comp({ seed: { type: 'long', value: [0, 42] }, generate_features: nbt.byte(1) }),
    Difficulty: nbt.byte(2), hardcore: nbt.byte(0), GameRules: nbt.comp({ keepInventory: nbt.string('false') }),
    DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } },
      Disabled: { type: 'list', value: { type: 'string', value: [] } } }),
  }) } };
  await mkdir(path.join(root, folder, 'playerdata'), { recursive: true });
  await writeFile(path.join(root, folder, 'level.dat'), gzipSync(nbt.writeUncompressed(tree)));
  await writeFile(path.join(root, folder, 'playerdata', 'owner.dat'), inventory);
}

async function fixture(t: TestContext, folder: string) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-world-overlap-'));
  const dataDirectory = path.join(temporary, 'data');
  const serversDirectory = path.join(dataDirectory, 'servers');
  const backupsDirectory = path.join(dataDirectory, 'backups');
  const root = path.join(serversDirectory, 'overlap-fixture');
  await mkdir(root, { recursive: true });
  await saveWorld(root, folder, 'initial inventory');
  await writeFile(path.join(root, 'server.properties'), `# preserve this\nlevel-name=${folder}\nmotd=Keep me\n`);
  const database = openDatabase(path.join(dataDirectory, 'test.sqlite'));
  const servers = new ServerRepository(database);
  const serverId = randomUUID();
  servers.create({ id: serverId, machineId: 'local', name: 'Overlap fixture', directory: 'overlap-fixture',
    software: 'vanilla', version: '1.20.1', port: 25565, memoryMb: 1024, eulaAccepted: true });
  servers.markReady(serverId);
  const service = new WorldService({ dataDirectory, serversDirectory, backupsDirectory }, servers,
    new WorldRepository(database), { isProcessActive: () => false });
  t.after(async () => {
    await service.stop();
    database.close();
    assert.equal(path.dirname(temporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('nodepilot-world-overlap-'));
    await rm(temporary, { recursive: true, force: true });
  });
  async function complete(operation: WorldOperation): Promise<WorldOperation> {
    for (let count = 0; count < 1000; count++) {
      const current = service.operation(serverId, operation.id);
      if (current.state !== 'running') {
        assert.equal(current.state, 'succeeded', current.error ?? undefined);
        return current;
      }
      await delay(5);
    }
    throw new Error('The overlap fixture operation timed out.');
  }
  const initial = (await service.list(serverId)).worlds.find(world => world.folder === folder)!;
  const backup = await complete(await service.backup(serverId, initial.id, initial.revision));
  assert.ok(backup.result?.backupId);
  return { root, service, serverId, backupId: backup.result.backupId!, complete };
}

async function rejectedChanges(f: Awaited<ReturnType<typeof fixture>>, world: WorldSummary, backupId: string): Promise<void> {
  assert.equal(world.state, 'unavailable');
  assert.match(world.readOnlyReason ?? '', /overlap|alias/i);
  await assert.rejects(f.service.update(f.serverId, world.id, { revision: world.revision, difficulty: 'hard' }), /overlap|alias/i);
  await assert.rejects(f.service.activate(f.serverId, world.id, { revision: world.revision, confirmCompatibility: true }), /overlap|alias/i);
  await assert.rejects(f.service.delete(f.serverId, world.id, { revision: world.revision, confirmName: world.name }), /overlap|alias|another world/i);
  await assert.rejects(f.service.restore(f.serverId, world.id, backupId, { revision: world.revision, confirm: true }), /overlap|alias/i);
  assert.equal(f.service.isBusy(f.serverId), false);
}

test('nested saved-world directories remain read-only and cannot delete or restore across the selected child', async t => {
  const f = await fixture(t, 'worlds');
  await saveWorld(f.root, 'worlds/child', 'child inventory and XP');
  await writeFile(path.join(f.root, 'server.properties'), '# preserve this\nlevel-name=worlds/child\nmotd=Keep me\n');
  const protectedFiles = ['server.properties', 'worlds/level.dat', 'worlds/playerdata/owner.dat', 'worlds/child/level.dat', 'worlds/child/playerdata/owner.dat'];
  const before = await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))));
  const listing = await f.service.list(f.serverId);
  assert.equal(listing.worlds.length, 2);
  const parent = listing.worlds.find(world => world.folder === 'worlds')!;
  const child = listing.worlds.find(world => world.folder === 'worlds/child')!;
  assert.equal(child.active, true);
  assert.equal(parent.active, false);
  assert.match(child.readOnlyReason ?? '', /overlap/i);
  await rejectedChanges(f, parent, f.backupId);
  await assert.rejects(f.service.update(f.serverId, child.id, { revision: child.revision, name: 'Changed' }), /overlap/i);
  const after = await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))));
  assert.deepEqual(after, before);
});

test('Windows case aliases of the primary world cannot mutate, delete or restore the same physical files', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'world');
  await writeFile(path.join(f.root, 'server.properties'), '# preserve this\nlevel-name=World\nmotd=Keep me\n');
  const protectedFiles = ['server.properties', 'world/level.dat', 'world/playerdata/owner.dat'];
  const before = await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))));
  const listing = await f.service.list(f.serverId);
  assert.equal(listing.worlds.length, 2);
  const alias = listing.worlds.find(world => world.folder === 'world')!;
  const selected = listing.worlds.find(world => world.folder === 'World')!;
  assert.equal(selected.active, true);
  assert.equal(alias.active, false);
  assert.match(selected.readOnlyReason ?? '', /overlap|alias/i);
  await rejectedChanges(f, alias, f.backupId);
  await assert.rejects(f.service.update(f.serverId, selected.id, { revision: selected.revision, hardcore: true }), /overlap|alias/i);
  const after = await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))));
  assert.deepEqual(after, before);
});
