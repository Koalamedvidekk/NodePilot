import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import nbt from 'prismarine-nbt';

import { openDatabase } from '../db.js';
import { asAppError, AppError } from '../lib/errors.js';
import { parseJavaProperties } from '../lib/java-properties.js';
import { activeWorldPlayerDirectories } from '../lib/world-layout.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { WorldRepository, type WorldOperationRecord } from '../repositories/world-repository.js';
import { registerWorldRoutes } from '../routes/world-routes.js';
import { WorldService } from '../services/world-service.js';
import { ServerRuntime } from '../services/server-runtime.js';
import type { WorldDetails, WorldList, WorldOperation } from '../world-types.js';

const serverId = '8069e508-4a80-4403-a4c0-e6a70bdf9ed9';
const base = `/api/servers/${serverId}/worlds`;
const headers = { 'x-nodepilot-pin': 'test-worlds-pin' };
const generation = { seed: '-9223372036854775808', preset: 'minecraft:normal', generatorSettings: '{}', structures: true,
  hardcore: false, difficulty: 'normal', enabledPacks: ['vanilla'], disabledPacks: [] };

async function saveWorld(root: string, folder: string, player: string, version = '1.20.1') {
  const tree: nbt.NBT = { name: '', type: 'compound', value: { Data: nbt.comp({
    LevelName: nbt.string(folder), DataVersion: nbt.int(3465), Version: nbt.comp({ Name: nbt.string(version) }),
    WorldGenSettings: nbt.comp({ seed: { type: 'long', value: [-1, -1] }, generate_features: nbt.byte(1) }),
    Difficulty: nbt.byte(2), hardcore: nbt.byte(0),
    GameRules: nbt.comp({ keepInventory: nbt.string('false'), randomTickSpeed: nbt.string('3') }),
    DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }),
  }) } };
  await mkdir(path.join(root, folder, 'playerdata'), { recursive: true });
  await writeFile(path.join(root, folder, 'level.dat'), gzipSync(nbt.writeUncompressed(tree)));
  await writeFile(path.join(root, folder, 'playerdata', 'owner.dat'), player);
}

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-world-api-'));
  const dataDirectory = path.join(temporary, 'data');
  const serversDirectory = path.join(dataDirectory, 'servers');
  const backupsDirectory = path.join(dataDirectory, 'backups');
  const directory = path.join(serversDirectory, 'test-server');
  await mkdir(directory, { recursive: true });
  await saveWorld(directory, 'world', 'inventory-A');
  await saveWorld(directory, 'second', 'inventory-B');
  await mkdir(path.join(directory, 'world_nether', 'DIM-1'), { recursive: true });
  await writeFile(path.join(directory, 'world_nether', 'DIM-1', 'region.mca'), 'nether chunks');
  await mkdir(path.join(directory, 'plugins'), { recursive: true });
  await writeFile(path.join(directory, 'plugins', 'global-player-progress.db'), 'plugin-wide state');
  await writeFile(path.join(directory, 'server.properties'), '# preserve comment\nlevel-name=world\nmotd=Keep me\nserver-port=25572\n');
  const db = openDatabase(path.join(dataDirectory, 'test.sqlite'));
  const servers = new ServerRepository(db);
  servers.create({ id: serverId, machineId: 'local', name: 'Test worlds', directory: 'test-server', software: 'paper', version: '1.20.1', port: 25572, memoryMb: 2048, eulaAccepted: true });
  servers.markReady(serverId);
  const catalogue = new WorldRepository(db);
  const state = { active: false, pause: false };
  const service = new WorldService({ serversDirectory, backupsDirectory, dataDirectory }, servers, catalogue, { isProcessActive: () => state.active }, () => state.pause);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { const problem = asAppError(error); return reply.code(problem.statusCode).send({ code: problem.code, message: problem.message }); });
  await app.register(multipart);
  app.addHook('preHandler', async (request) => { if (request.headers['x-nodepilot-pin'] !== headers['x-nodepilot-pin']) throw new AppError(401, 'pin_required', 'Unlock the panel.'); });
  await registerWorldRoutes(app, service, { dataDirectory });
  await app.ready();
  t.after(async () => {
    await service.stop();
    await app.close();
    db.close();
    assert.equal(path.dirname(temporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('nodepilot-world-api-'));
    await rm(temporary, { recursive: true, force: true });
  });
  async function request(method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', url: string, payload?: unknown) {
    return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'content-type': 'application/json' } }) });
  }
  const list = async () => (await request('GET', base)).json<WorldList>();
  const details = async (worldId: string) => (await request('GET', `${base}/${worldId}`)).json<WorldDetails>();
  async function wait(operation: WorldOperation): Promise<WorldOperation> {
    for (let i = 0; i < 1000; i += 1) {
      const result = service.operation(serverId, operation.id);
      if (result.state !== 'running') return result;
      await delay(5);
    }
    throw new Error('World operation did not finish.');
  }
  async function success(response: Awaited<ReturnType<typeof request>>) {
    assert.equal(response.statusCode, 202, response.body);
    const operation = await wait(response.json<{ operation: WorldOperation }>().operation);
    assert.equal(operation.state, 'succeeded', operation.error ?? undefined);
    return operation;
  }
  return { temporary, dataDirectory, serversDirectory, backupsDirectory, directory, servers, catalogue, service, state, app, request, list, details, wait, success };
}

test('Worlds APIs inherit panel authentication, validate opaque IDs, and expose saved metadata', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ method: 'GET', url: base })).statusCode, 401);
  assert.equal((await f.request('GET', '/api/servers/not-a-uuid/worlds')).statusCode, 400);
  const listing = await f.list();
  assert.equal(listing.supported, true);
  assert.equal(listing.worlds.length, 2);
  const active = listing.worlds.find((world) => world.active)!;
  assert.equal(active.seed, '-1');
  assert.deepEqual(active.dimensions, ['minecraft:overworld', 'minecraft:the_nether']);
  const details = await f.details(active.id);
  assert.equal(details.metadataSource, 'saved');
  f.state.active = true;
  assert.equal((await f.details(active.id)).metadataSource, 'last-saved');
  assert.equal((await f.list()).capabilities.canMutate, false);
  assert.equal((await f.request('POST', `${base}/${active.id}/backups`, { revision: active.revision })).statusCode, 409);
});

test('preparing a world keeps the server stopped and switching preserves isolated player progress and settings', async (t) => {
  const f = await fixture(t);
  const before = await f.list();
  const original = before.worlds.find((world) => world.active)!;
  const prepared = await f.success(await f.request('POST', base, { ...generation, name: 'Fresh world', revision: before.revision }));
  assert.equal(f.state.active, false);
  assert.equal(await readFile(path.join(f.directory, 'world/playerdata/owner.dat'), 'utf8'), 'inventory-A');
  const fresh = (await f.list()).worlds.find((world) => world.id === prepared.result?.worldId)!;
  assert.equal(fresh.active, true);
  assert.equal(fresh.state, 'prepared');
  assert.equal(fresh.seed, null);
  assert.equal((await f.details(fresh.id)).generation.seed, generation.seed);
  assert.equal((await f.request('PUT', `${base}/${fresh.id}/gamerules`, { revision: fresh.revision, rules: { keepInventory: true } })).statusCode, 409);
  const second = (await f.list()).worlds.find((world) => world.folder === 'second')!;
  await f.success(await f.request('PATCH', `${base}/${second.id}`, { revision: second.revision, difficulty: 'easy', name: 'Second saved' }));
  const currentSecond = (await f.details(second.id)).world;
  await f.success(await f.request('POST', `${base}/${second.id}/activate`, { revision: currentSecond.revision, confirmCompatibility: true }));
  assert.deepEqual(await activeWorldPlayerDirectories(f.directory), [path.join(f.directory, 'second/playerdata')]);
  assert.equal(parseJavaProperties(await readFile(path.join(f.directory, 'server.properties'), 'utf8')).difficulty, 'easy');
  const currentOriginal = (await f.details(original.id)).world;
  await f.success(await f.request('POST', `${base}/${original.id}/activate`, { revision: currentOriginal.revision, confirmCompatibility: true }));
  assert.deepEqual(await activeWorldPlayerDirectories(f.directory), [path.join(f.directory, 'world/playerdata')]);
  assert.equal(await readFile(path.join(f.directory, 'second/playerdata/owner.dat'), 'utf8'), 'inventory-B');
  const properties = await readFile(path.join(f.directory, 'server.properties'), 'utf8');
  assert.equal(parseJavaProperties(properties).difficulty, 'normal');
  assert.ok(properties.startsWith('# preserve comment\n'));
  assert.equal(parseJavaProperties(properties).motd, 'Keep me');
});

test('stale edits, invalid rules, invalid generator JSON, and known world downgrades are refused', async (t) => {
  const f = await fixture(t);
  const listing = await f.list();
  const active = listing.worlds.find((world) => world.active)!;
  assert.equal((await f.request('POST', base, { ...generation, generatorSettings: '[]', name: 'Invalid', revision: listing.revision })).statusCode, 400);
  assert.equal((await f.request('PUT', `${base}/${active.id}/gamerules`, { revision: active.revision, rules: { randomTickSpeed: -1 } })).statusCode, 400);
  assert.equal((await f.request('PUT', `${base}/${active.id}/gamerules`, { revision: active.revision, rules: { notARealRule: true } })).statusCode, 422);
  await writeFile(path.join(f.directory, 'server.properties'), 'level-name=world\nmotd=External edit\n');
  assert.equal((await f.request('PATCH', `${base}/${active.id}`, { revision: active.revision, name: 'Stale' })).statusCode, 409);
  await saveWorld(f.directory, 'newer', 'new progress', '1.21.4');
  const newer = (await f.list()).worlds.find((world) => world.folder === 'newer')!;
  const response = await f.request('POST', `${base}/${newer.id}/activate`, { revision: newer.revision, confirmCompatibility: true });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().message, /compatible server version/);
});

test('backup, inactive-world deletion and restoration preserve grouped dimensions and global plugin data', async (t) => {
  const f = await fixture(t);
  let listing = await f.list();
  const old = listing.worlds.find((world) => world.active)!;
  const second = listing.worlds.find((world) => world.folder === 'second')!;
  assert.equal((await f.request('DELETE', `${base}/${old.id}`, { revision: old.revision, confirmName: old.name })).statusCode, 409);
  await f.success(await f.request('POST', `${base}/${second.id}/activate`, { revision: second.revision, confirmCompatibility: true }));
  let detail = await f.details(old.id);
  assert.equal((await f.request('DELETE', `${base}/${old.id}`, { revision: detail.world.revision, confirmName: 'wrong name' })).statusCode, 400);
  const deleted = await f.success(await f.request('DELETE', `${base}/${old.id}`, { revision: detail.world.revision, confirmName: old.name }));
  assert.equal((await f.details(old.id)).world.deleted, true);
  assert.equal((await readdir(f.directory)).includes('world_nether'), false);
  detail = await f.details(old.id);
  await f.success(await f.request('POST', `${base}/${old.id}/backups/${deleted.result?.backupId}/restore`, { revision: detail.world.revision, confirm: true }));
  assert.equal((await f.details(old.id)).world.deleted, false);
  assert.equal(await readFile(path.join(f.directory, 'world/playerdata/owner.dat'), 'utf8'), 'inventory-A');
  assert.equal(await readFile(path.join(f.directory, 'world_nether/DIM-1/region.mca'), 'utf8'), 'nether chunks');
  assert.equal(await readFile(path.join(f.directory, 'plugins/global-player-progress.db'), 'utf8'), 'plugin-wide state');
  listing = await f.list();
  assert.equal(listing.activeWorldId, second.id);
});

test('failed preparation rolls back created directories, catalogue and settings', async (t) => {
  const f = await fixture(t);
  const before = await f.list();
  const properties = await readFile(path.join(f.directory, 'server.properties'));
  const internals = f.service as unknown as { writeProperties: (...args: unknown[]) => Promise<void> };
  const original = internals.writeProperties;
  internals.writeProperties = async () => { throw new Error('Simulated disk-full write'); };
  const response = await f.request('POST', base, { ...generation, name: 'Disk full', revision: before.revision });
  assert.equal(response.statusCode, 202, response.body);
  const result = await f.wait(response.json<{ operation: WorldOperation }>().operation);
  internals.writeProperties = original;
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /disk-full/);
  assert.deepEqual(await readFile(path.join(f.directory, 'server.properties')), properties);
  assert.equal((await f.list()).worlds.length, before.worlds.length);
  assert.equal((await readdir(f.directory)).some((name) => name.startsWith('world-disk-full-')), false);
  assert.doesNotThrow(() => f.service.assertCanStart(serverId));
});

test('restart recovery restores a durable property snapshot and blocks starts when recovery is incomplete', async (t) => {
  const f = await fixture(t);
  const listing = await f.list();
  const active = listing.worlds.find((world) => world.active)!;
  const operationId = randomUUID();
  const journalDirectory = path.join(f.dataDirectory, 'worlds/journals', operationId);
  await mkdir(path.join(journalDirectory, 'files'), { recursive: true });
  const properties = await readFile(path.join(f.directory, 'server.properties'));
  await writeFile(path.join(journalDirectory, 'files/server.properties'), properties);
  await mkdir(path.join(f.directory, 'incomplete-world'));
  await writeFile(path.join(f.directory, 'server.properties'), 'level-name=incomplete-world\n');
  const now = new Date().toISOString();
  const operation: WorldOperationRecord = { id: operationId, serverId, worldId: null, kind: 'prepare', state: 'running', phase: 'preparing', processedBytes: 0, totalBytes: null,
    error: null, result: null, artifact: null, createdAt: now, updatedAt: now,
    recovery: JSON.stringify({ serverId, worldId: null, files: [{ relative: 'server.properties', exists: true }], directory: journalDirectory, before: null, created: ['incomplete-world'], fullBackup: null, group: null }) };
  f.catalogue.saveOperation(operation);
  await f.service.recover();
  assert.deepEqual(await readFile(path.join(f.directory, 'server.properties')), properties);
  assert.equal((await readdir(f.directory)).includes('incomplete-world'), false);
  assert.equal(f.service.operation(serverId, operationId).phase, 'recovered');
  f.catalogue.saveOperation({ ...operation, id: randomUUID(), worldId: active.id, state: 'running', recovery: '{broken' });
  await f.service.recover();
  assert.equal(f.service.hasRecoveryBlock(serverId), true);
  assert.throws(() => f.service.assertCanStart(serverId), /recovery/);
});

test('an external edit during asynchronous preflight is rejected after maintenance ownership is acquired', async (t) => {
  const f = await fixture(t);
  const listing = await f.list();
  const active = listing.worlds.find((world) => world.active)!;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const internals = f.service as unknown as { editable: (...args: unknown[]) => Promise<unknown> };
  const editable = internals.editable;
  internals.editable = async function (...args) { const value = await editable.apply(this, args); entered(); await gate; return value; };
  const pending = f.service.update(serverId, active.id, { revision: active.revision, name: 'Must not overwrite' });
  await ready;
  const external = 'level-name=world\nmotd=External writer won\n';
  await writeFile(path.join(f.directory, 'server.properties'), external);
  release();
  const operation = await pending;
  const result = await f.wait(operation);
  internals.editable = editable;
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /changed|Refresh/);
  assert.equal(await readFile(path.join(f.directory, 'server.properties'), 'utf8'), external);
  assert.equal((await f.details(active.id)).world.name, active.name);
});

test('runtime reserves a pending start before validation so world changes and duplicate starts are rejected', async (t) => {
  const f = await fixture(t);
  const listing = await f.list();
  const runtime = new ServerRuntime(f.servers, f.serversDirectory);
  const service = new WorldService({ dataDirectory: f.dataDirectory, serversDirectory: f.serversDirectory, backupsDirectory: f.backupsDirectory }, f.servers, f.catalogue, runtime);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  runtime.setStartValidation(async () => { entered(); await gate; throw new Error('Validation refused fixture launch'); });
  const server = f.servers.find(serverId)!;
  const pending = runtime.start(server, 'must-never-be-spawned').then(() => { throw new Error('Unexpected launch'); }, error => error as Error);
  await ready;
  assert.equal(runtime.isProcessActive(serverId), true);
  await assert.rejects(runtime.start(server, 'must-never-be-spawned'), /already starting/);
  await assert.rejects(service.prepare(serverId, { ...generation, difficulty: 'normal', name: 'Blocked', revision: listing.revision }), /Stop the server/);
  release();
  assert.match((await pending).message, /Validation refused/);
  assert.equal(runtime.isProcessActive(serverId), false);
  await service.stop();
});

test('startup validation rejects a selected world saved by a newer Minecraft version before any Java launch', async (t) => {
  const f = await fixture(t);
  await saveWorld(f.directory, 'upgraded', 'newer inventory', '26.3');
  await writeFile(path.join(f.directory, 'server.properties'), 'level-name=upgraded\n');
  const runtime = new ServerRuntime(f.servers, f.serversDirectory);
  runtime.setStartValidation((id) => f.service.validateStart(id));
  await assert.rejects(runtime.start(f.servers.find(serverId)!, 'must-never-be-spawned'), /compatible server version/);
  assert.equal(runtime.isProcessActive(serverId), false);
  assert.equal(await readFile(path.join(f.directory, 'upgraded/playerdata/owner.dat'), 'utf8'), 'newer inventory');
});
