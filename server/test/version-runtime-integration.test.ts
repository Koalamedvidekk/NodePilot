import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { openDatabase } from '../db.js';
import { AppError } from '../lib/errors.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import type { JavaService } from '../services/java-service.js';
import { MinecraftService } from '../services/minecraft-service.js';
import type { PlayitService } from '../services/playit-service.js';
import { ServerRuntime } from '../services/server-runtime.js';
import { WakeProxyService } from '../services/wake-proxy-service.js';
import type { ServerRecord, ServerStartupConfig } from '../types.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-version-integration-'));
  const database = openDatabase(':memory:');
  const repository = new ServerRepository(database);
  const server = repository.create({
    id: 'version-integration', machineId: 'local', name: 'Version test',
    directory: 'version-test', software: 'vanilla', version: '1.20.4',
    port: 25565, memoryMb: 1024, requiredJavaMajor: 17, eulaAccepted: true,
  });
  repository.markReady(server.id);
  t.after(async () => {
    database.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('nodepilot-version-integration-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, database, repository, server: repository.require(server.id) };
}

test('runtime staging downloads verified files without starter configuration; creation still writes it', async (t) => {
  const { root, repository, server } = await fixture(t);
  const content = 'verified test runtime';
  const downloadUrl = 'https://piston-data.mojang.com/v1/objects/test/server.jar';
  repository.setCache('minecraft:vanilla-manifest', { versions: [{
    id: server.version, type: 'release', url: 'https://piston-meta.mojang.com/test.json',
    releaseTime: '2023-12-07T12:00:00Z',
  }] });
  repository.setCache('minecraft:vanilla:' + server.version, { downloads: { server: {
    url: downloadUrl, sha1: createHash('sha1').update(content).digest('hex'), size: Buffer.byteLength(content),
  } } });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), downloadUrl);
    return new Response(content, { headers: { 'content-length': String(Buffer.byteLength(content)) } });
  });
  const minecraft = new MinecraftService(repository, root);
  const staging = path.join(root, 'staging');
  await mkdir(staging);
  const runtime = await minecraft.stageRuntime(server, staging);
  assert.equal(runtime.software, 'vanilla');
  assert.deepEqual(await readdir(staging), ['server.jar']);
  assert.equal(await readFile(path.join(staging, 'server.jar'), 'utf8'), content);

  const managedRoot = path.join(root, server.directory);
  await minecraft.install(server);
  assert.match(await readFile(path.join(managedRoot, 'server.properties'), 'utf8'), /server-port=25565/);
  assert.match(await readFile(path.join(managedRoot, 'eula.txt'), 'utf8'), /eula=true/);
  await writeFile(path.join(managedRoot, 'server.properties'), 'motd=keep my settings\n');
  await assert.rejects(minecraft.stageRuntime(server, managedRoot), { code: 'unsafe_runtime_staging' });
  assert.equal(await readFile(path.join(managedRoot, 'server.properties'), 'utf8'), 'motd=keep my settings\n');
});

test('repository persists version, loader and Java metadata together and rejects invalid configuration', async (t) => {
  const { repository, server } = await fixture(t);
  const startupConfig: ServerStartupConfig = {
    mode: 'arg-files', windowsArgFile: 'libraries/win_args.txt', linuxArgFile: 'libraries/unix_args.txt',
    jvmArgFiles: ['user_jvm_args.txt'], gameArguments: ['nogui'],
  };
  repository.updateVersion(server.id, {
    version: '1.21.4', software: 'forge', loaderVersion: '54.1.0',
    requiredJavaMajor: 21, javaPath: 'java-21', startupConfig,
  });
  const updated = repository.require(server.id);
  assert.equal(updated.version, '1.21.4');
  assert.equal(updated.requiredJavaMajor, 21);
  assert.equal(updated.javaPath, 'java-21');
  assert.equal(updated.software, 'forge');
  assert.equal(updated.loaderVersion, '54.1.0');
  assert.deepEqual(updated.startupConfig, startupConfig);
  assert.equal(updated.status, 'offline');
  assert.equal(updated.installState, 'ready');
  assert.throws(() => repository.updateVersion(server.id, {
    version: '1.22', startupConfig: { mode: 'jar', jarPath: '../escape.jar', gameArguments: ['nogui'] },
  }), /Invalid server startup configuration/);
  assert.deepEqual(repository.require(server.id), updated);
});

test('runtime rechecks the version-change lock after asynchronous startup validation', async (t) => {
  const { root, repository, server } = await fixture(t);
  await mkdir(path.join(root, server.directory));
  await writeFile(path.join(root, server.directory, 'server.jar'), 'test jar');
  const runtime = new ServerRuntime(repository, root);
  let checks = 0;
  runtime.setStartGuard(() => {
    checks++;
    if (checks > 1) throw new AppError(409, 'version_change_in_progress', 'Version change is running.');
  });
  await assert.rejects(runtime.start(server, process.execPath), { code: 'version_change_in_progress' });
  assert.equal(checks, 2);
  assert.equal(runtime.isProcessActive(server.id), false);
  assert.equal(repository.require(server.id).status, 'offline');
});

test('runtime refuses a server record whose version changed during asynchronous startup validation', async (t) => {
  const { root, repository, server } = await fixture(t);
  await mkdir(path.join(root, server.directory));
  await writeFile(path.join(root, server.directory, 'server.jar'), 'test jar');
  const runtime = new ServerRuntime(repository, root);
  const starting = runtime.start(server, process.execPath);
  repository.updateVersion(server.id, { version: '1.21.4', startupConfig: server.startupConfig });
  await assert.rejects(starting, { code: 'server_version_changed' });
  assert.equal(runtime.isProcessActive(server.id), false);
  assert.equal(repository.require(server.id).status, 'offline');
});

test('runtime reserves a start during world validation and releases it on failure', async (t) => {
  const { root, repository, server } = await fixture(t);
  const runtime = new ServerRuntime(repository, root);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  runtime.setStartValidation(async () => {
    await pending;
    throw new AppError(409, 'world_downgrade_refused', 'Selected world is newer than this runtime.');
  });
  const starting = runtime.start(server, process.execPath);
  assert.equal(runtime.isProcessActive(server.id), true);
  await assert.rejects(runtime.start(server, process.execPath), { code: 'server_already_active' });
  release();
  await assert.rejects(starting, { code: 'world_downgrade_refused' });
  assert.equal(runtime.isProcessActive(server.id), false);
  assert.equal(repository.require(server.id).status, 'offline');
});

test('auto-wake refuses Java selected for a version replaced during discovery', async (t) => {
  const { database, repository, server } = await fixture(t);
  let resolveJava!: (value: unknown) => void;
  const discovered = new Promise((resolve) => { resolveJava = resolve; });
  const java = { findUsable: () => discovered } as unknown as JavaService;
  let starts = 0;
  const runtime = { start: async () => { starts++; return server; } } as unknown as ServerRuntime;
  const service = new WakeProxyService(repository, new ServerSettingsRepository(database),
    new ServerTunnelRepository(database), {} as PlayitService, runtime, java);
  t.after(() => service.stop());
  const wake = (service as unknown as { ensureServerStarting(value: ServerRecord): Promise<boolean> }).ensureServerStarting(server);
  repository.updateVersion(server.id, { version: '1.21.4', requiredJavaMajor: 21, startupConfig: server.startupConfig });
  resolveJava({ installation: { path: 'java-17', major: 17 } });
  assert.equal(await wake, false);
  assert.equal(starts, 0);
});
