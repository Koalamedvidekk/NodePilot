import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

import { bridgeTokenHash, type PlayerBridgeManager } from '../services/player-bridge.js';
import { canonicalUuid, PlayerService } from '../services/player-service.js';
import type { ServerRuntime } from '../services/server-runtime.js';
import type { ServerRecord } from '../types.js';

test('canonicalUuid normalizes Minecraft UUID formats and refuses arbitrary player input', () => {
  assert.equal(canonicalUuid('069a79f4-44e9-4726-a5be-fca90e38aaf5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(canonicalUuid('069A79F444E94726A5BEFCA90E38AAF5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(canonicalUuid('../../not-a-player'), undefined);
  assert.equal(canonicalUuid(undefined), undefined);
});

test('bridge credentials are represented by deterministic non-plaintext hashes', () => {
  const token = 'example-local-bridge-token';
  assert.equal(bridgeTokenHash(token), bridgeTokenHash(token));
  assert.notEqual(bridgeTokenHash(token), token);
  assert.notEqual(bridgeTokenHash(token), bridgeTokenHash(`${token}-other`));
});

test('live Paper detail requests resolve the player and replace stale disk inventory, with offline fallback after disconnect', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-player-detail-'));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('nodepilot-player-detail-'));
    await rm(root, { recursive: true, force: true });
  });
  const uuid = '199f2445-7f42-3492-b97b-f1a69c57ee90';
  const server = { id: 'player-test', directory: 'test-server', software: 'paper', version: '1.21.4', status: 'running' } as ServerRecord;
  const directory = path.join(root, server.directory);
  await mkdir(path.join(directory, 'world/playerdata'), { recursive: true });
  await writeFile(path.join(directory, 'server.properties'), 'level-name=world\n');
  await writeFile(path.join(directory, 'usercache.json'), JSON.stringify([{ name: 'QAPlayer', uuid }]));
  const savedPlayer = gzipSync(nbt.writeUncompressed({ name: '', type: 'compound', value: {
    Health: nbt.float(20), foodLevel: nbt.int(20), XpLevel: nbt.int(1),
    Inventory: { type: 'list', value: { type: 'compound', value: [{ Slot: nbt.byte(0), id: nbt.string('minecraft:stone'), Count: nbt.byte(1) }] } },
  } } as nbt.NBT));
  const playerPath = path.join(directory, 'world/playerdata', uuid + '.dat');
  await writeFile(playerPath, savedPlayer);
  let online = true;
  const live = { uuid, name: 'QAPlayer', online: true, health: 6, hunger: 9, xpLevel: 11, gameMode: 'creative', location: { world: 'world', x: 12, y: 70, z: -9 }, inventory: [{ slot: 0, itemId: 'minecraft:diamond', count: 7 }] };
  const bridge = {
    status() { return { configured: true, connected: true, capabilities: ['players.list', 'players.get'] }; },
    async request(_serverId: string, method: string, body: { player?: { uuid?: string; name?: string } }) {
      if (method === 'players.list') return { players: online ? [{ name: live.name, uuid, online: true }] : [] };
      // Match the shipped plugin's playerObject/getPlayer contract.
      if (method === 'players.get' && online && body.player?.uuid === uuid && body.player.name === live.name) return { player: live };
      throw new Error('That player is not online; live details require an online player.');
    },
  } as unknown as PlayerBridgeManager;
  const service = new PlayerService(root, new EventEmitter() as ServerRuntime, bridge);
  const details = await service.details(server, uuid);
  assert.equal(details.dataSource, 'bridge');
  assert.equal(details.inventorySource, 'bridge');
  assert.equal(details.inventoryMessage, undefined);
  assert.equal(details.health, 6);
  assert.equal(details.hunger, 9);
  assert.equal(details.xpLevel, 11);
  assert.deepEqual(details.location, { ...live.location, yaw: undefined, pitch: undefined });
  assert.deepEqual(details.inventory?.map(({ slot, itemId, count }) => ({ slot, itemId, count })), live.inventory);
  online = false;
  const offline = await service.details(server, uuid);
  assert.equal(offline.dataSource, 'offline');
  assert.equal(offline.inventorySource, 'offline');
  assert.equal(offline.xpLevel, 1);
  assert.equal(offline.inventory?.[0]?.itemId, 'minecraft:stone');
  assert.deepEqual(await readFile(playerPath), savedPlayer);
});
