import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import Fastify from 'fastify';

import { openDatabase } from '../db.js';
import { asAppError } from '../lib/errors.js';
import { parseJavaProperties } from '../lib/java-properties.js';
import { minecraftReleaseProtocol } from '../lib/minecraft-protocol-version.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { registerBrowserAccessRoutes } from '../routes/browser-access-routes.js';
import { BrowserAccessService } from '../services/browser-access-service.js';
import type { BrowserDependencyService, BrowserInstalledDependencies } from '../services/browser-dependencies.js';
import type { JavaService } from '../services/java-service.js';

const serverId = '11111111-1111-4111-8111-111111111111';
const guardBytes = Buffer.from('isolated BungeeGuard fixture');

type ProbeStep = 'dns' | 'invalid-accept' | 'valid' | 'pending';

function mockPublicGateway(t: TestContext, steps: ProbeStep[]) {
  const attempts: Array<{ signal: AbortSignal }> = [];
  const sockets: Array<{ destroyed: boolean; destroy(): void }> = [];
  const request = t.mock.method(https, 'request', (_url: string, options: { headers: Record<string, string>; signal: AbortSignal }) => {
    const emitter = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
    const step = steps.shift() ?? 'invalid-accept';
    attempts.push({ signal: options.signal });
    let completed = false;
    const finish = () => { completed = true; options.signal.removeEventListener('abort', abort); };
    const abort = () => emitter.destroy(new Error('The public gateway request was aborted.'));
    emitter.destroy = (error: Error) => {
      if (completed) return;
      finish();
      queueMicrotask(() => emitter.emit('error', error));
    };
    options.signal.addEventListener('abort', abort, { once: true });
    emitter.end = () => {
      if (step === 'pending') return;
      queueMicrotask(() => {
        if (completed) return;
        finish();
        if (step === 'dns') {
          emitter.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND newly-created.trycloudflare.com'), { code: 'ENOTFOUND' }));
          return;
        }
        const socket = { destroyed: false, destroy() { this.destroyed = true; } };
        sockets.push(socket);
        const accept = createHash('sha1').update(options.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        emitter.emit('upgrade', { statusCode: 101, headers: { 'sec-websocket-accept': step === 'valid' ? accept : 'untrusted-accept' } }, socket);
      });
    };
    return emitter as unknown as ReturnType<typeof https.request>;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  t.after(() => { t.mock.timers.reset(); request.mock.restore(); syncBuiltinESMExports(); });
  return { attempts, sockets };
}

async function flushMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration += 1) await Promise.resolve();
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function fixture(t: TestContext, options: { missingYaml?: boolean; downloadError?: boolean; noJava?: boolean; publicWakePort?: number } = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'nodepilot-browser-access-'));
  const dataDirectory = path.join(directory, 'data');
  const serversDirectory = path.join(directory, 'servers');
  const serverRoot = path.join(serversDirectory, 'browser-fixture');
  await mkdir(serverRoot, { recursive: true });
  const database = openDatabase(path.join(dataDirectory, 'nodepilot.sqlite'));
  const servers = new ServerRepository(database);
  const server = servers.create({ id: serverId, machineId: 'local', name: 'Browser fixture', directory: 'browser-fixture',
    software: 'paper', version: '1.21.4', port: await freePort(), memoryMb: 1024, eulaAccepted: true });
  servers.markReady(server.id);
  const originalProperties = `# Original server configuration\nserver-port=${server.port}\nserver-ip=\nonline-mode=true\nenforce-secure-profile=true\nmotd=Existing\\ world\ncustom-property=leave-me\n`;
  const originalSpigot = '# Spigot comment\nsettings:\n  bungeecord: false\n  custom-entry: retained\n';
  const originalPaper = '# Paper comment\nproxies:\n  velocity:\n    enabled: false\n    secret: retained-secret\n  bungee-cord:\n    online-mode: false\ncustom-entry: [keep, 3]\n';
  await writeFile(path.join(serverRoot, 'server.properties'), originalProperties);
  if (!options.missingYaml) {
    await mkdir(path.join(serverRoot, 'config'));
    await writeFile(path.join(serverRoot, 'spigot.yml'), originalSpigot);
    await writeFile(path.join(serverRoot, 'config/paper-global.yml'), originalPaper);
  }
  const dependenciesRoot = path.join(dataDirectory, 'browser-access', server.id);
  const installed: BrowserInstalledDependencies = { directory: dependenciesRoot,
    velocityJar: path.join(dependenciesRoot, 'velocity.jar'), cloudflared: path.join(dependenciesRoot, 'cloudflared'),
    bungeeGuardJar: path.join(dependenciesRoot, 'plugins/BungeeGuard.jar'),
    authPluginJar: path.join(dependenciesRoot, 'plugins/NodePilotBrowserAuth.jar'), javaMajor: 25,
    versions: { velocity: '4.3.1-45', eaglerxserver: 'fixture', cloudflared: 'fixture' } };
  let installations = 0;
  const dependencies = { refreshAuthCompanion: async () => ({ path: installed.authPluginJar, version: '0.1.1' }), install: async () => {
    installations += 1;
    if (options.downloadError) throw new Error('The official download failed its SHA-256 integrity check.');
    await mkdir(path.dirname(installed.bungeeGuardJar), { recursive: true });
    await writeFile(installed.bungeeGuardJar, guardBytes);
    return installed;
  } } as unknown as BrowserDependencyService;
  const java = { findUsable: async () => options.noJava ? undefined : { installation: { path: 'fake-java-never-launched' } } } as unknown as JavaService;
  let active = false;
  let maintenanceError: Error | undefined;
  const serviceOptions = { dataDirectory, serversDirectory, assertMaintenance: () => { if (maintenanceError) throw maintenanceError; }, isProcessActive: () => active,
    wakePort: () => options.publicWakePort ?? null };
  const createService = () => new BrowserAccessService(database, servers, java, serviceOptions, dependencies);
  const service = createService();
  const createdServices = [service];
  t.after(async () => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
    for (const instance of createdServices) await instance.stop();
    database.close();
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('nodepilot-browser-access-'));
    await rm(directory, { recursive: true, force: true });
  });
  const row = () => {
    const entry = database.prepare('SELECT payload FROM browser_access WHERE server_id = ?').get(serverId) as { payload: string };
    return JSON.parse(entry.payload);
  };
  const saveRow = (payload: unknown) => database.prepare('UPDATE browser_access SET payload = ? WHERE server_id = ?').run(JSON.stringify(payload), serverId);
  const inspect = async () => {
    await service.inspect(serverId);
    const until = Date.now() + 5_000;
    while (service.isBusy(serverId) && Date.now() < until) await delay(10);
    assert.equal(service.isBusy(serverId), false, 'Inspection must settle without launching any process');
    return service.status(serverId);
  };
  const setup = async () => {
    const status = await inspect();
    assert.equal(status.error, null);
    assert.ok(status.preview);
    return service.setup(serverId, status.preview!.revision);
  };
  return { database, servers, server, service, serverRoot, installed, originalProperties, originalSpigot, originalPaper,
    inspect, setup, row, saveRow,
    recoverService: () => { const next = createService(); createdServices.push(next); return next; },
    setActive: (value: boolean) => { active = value; },
    setMaintenanceError: (value: Error) => { maintenanceError = value; },
    get installations() { return installations; } };
}

test('browser availability uses exact stable protocol mappings including 26.x and rejects unknown releases before downloads', async (t) => {
  const state = await fixture(t);
  for (const [version, protocol] of [['1.19',759],['1.21.11',774],['26.1',775],['26.1.1',775],['26.1.2',775],['26.2',776],['26.3',777],['26.3.0',777]] as const) {
    state.database.prepare('UPDATE servers SET version=? WHERE id=?').run(version, serverId);
    const status = await state.service.status(serverId);
    assert.equal(status.capabilities.available, true, version);
    assert.equal(status.capabilities.backendProtocol, protocol);
    assert.equal(minecraftReleaseProtocol(version), protocol);
    assert.ok(status.capabilities.targetClients.some(client => client.includes('26.3')));
  }
  for (const version of ['1.19.9', '1.21.12', '26.1.3', '26.3.1', '26.4', '26.3-snapshot-1']) {
    state.database.prepare('UPDATE servers SET version=? WHERE id=?').run(version, serverId);
    assert.equal(minecraftReleaseProtocol(version), null);
    assert.equal((await state.service.status(serverId)).capabilities.available, false);
    await assert.rejects(state.service.inspect(serverId), { code: 'browser_unsupported' });
  }
  assert.equal(state.installations, 0);
});

test('26.3 setup pins the real backend protocol and enables bounded protocol-v5 negotiation', async (t) => {
  const state = await fixture(t);
  state.database.prepare('UPDATE servers SET version=? WHERE id=?').run('26.3', serverId);
  const status = await state.setup();
  assert.equal(status.capabilities.backendVersion, '26.3');
  const via = parse(await readFile(path.join(state.installed.directory, 'plugins/viaversion/config.yml'), 'utf8'));
  assert.deepEqual(via['velocity-servers'], { default: 777, nodepilot: 777 });
  const settings = await readFile(path.join(state.installed.directory, 'plugins/eaglerxserver/settings.toml'), 'utf8');
  assert.match(settings, /enable_authentication_events = true/);
  assert.match(settings, /\[protocols\]\nprotocol_v5_allowed = true\nmax_minecraft_protocol_v5 = 777/);
  await state.service.disable(serverId);
  assert.equal(parseJavaProperties(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'))['online-mode'], 'true');
});

test('previously configured gateways retain their files and explain how to upgrade for modern clients', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const record = state.row();
  record.installed.versions.velocity = '3.4.0-566';
  state.saveRow(record);
  const before = await readFile(path.join(state.installed.directory, 'velocity.toml'), 'utf8');
  let status = await state.service.status(serverId);
  assert.equal(status.capabilities.available, true);
  assert.equal(status.capabilities.gatewayUpgradeRequired, true);
  assert.ok(status.capabilities.notes.some(note => /Java 25/.test(note)));
  assert.ok(!status.capabilities.targetClients.some(client => client.includes('26.3')));
  assert.equal(await readFile(path.join(state.installed.directory, 'velocity.toml'), 'utf8'), before);
  state.database.prepare('UPDATE servers SET version=? WHERE id=?').run('26.3', serverId);
  status = await state.service.status(serverId);
  assert.equal(status.capabilities.available, false);
  assert.ok(status.capabilities.reasons.some(reason => /Set Up again/.test(reason)));
});

test('browser inspection refuses active servers and shared maintenance before downloading anything', async (t) => {
  const state = await fixture(t);
  state.setActive(true);
  await assert.rejects(state.service.inspect(serverId), { code: 'server_active' });
  state.setActive(false);
  state.servers.setStatus(serverId, 'running');
  await assert.rejects(state.service.inspect(serverId), { code: 'server_active' });
  state.servers.setStatus(serverId, 'offline');
  state.setMaintenanceError(new Error('Another maintenance operation owns this server'));
  await assert.rejects(state.service.inspect(serverId), /Another maintenance operation/);
  assert.equal(state.installations, 0);
  assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
});

test('simultaneous browser inspections acquire exclusive ownership before asynchronous preflight', async (t) => {
  const state = await fixture(t);
  const results = await Promise.allSettled([state.service.inspect(serverId), state.service.inspect(serverId)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'browser_operation_in_progress');
  const until = Date.now() + 5_000;
  while (state.service.isBusy(serverId) && Date.now() < until) await delay(10);
  assert.equal(state.service.isBusy(serverId), false);
  assert.equal(state.installations, 1);
});

test('browser account enrollment requires a stopped server and excludes starts during collision checks and hashing', async (t) => {
  const state = await fixture(t);
  const input = { name: 'Alex', password: 'correct-browser-password' };
  state.setActive(true);
  await assert.rejects(state.service.createAccount(serverId, input), { code: 'server_active' });
  state.setActive(false);
  const enrolling = state.service.createAccount(serverId, input);
  assert.equal(state.service.isBusy(serverId), true);
  assert.throws(() => state.service.assertCanStart(serverId), { code: 'browser_operation_in_progress' });
  await assert.rejects(state.service.createAccount(serverId, input), { code: 'browser_operation_in_progress' });
  const account = await enrolling;
  assert.equal(account.name, 'np_Alex');
  assert.equal(state.service.isBusy(serverId), false);
});

test('the browser enable API requires explicit JSON confirmation before starting a public tunnel', async (t) => {
  let starts = 0;
  const browser = { enable: async () => { starts += 1; return { enabled: true }; } } as unknown as BrowserAccessService;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { const handled = asAppError(error); reply.code(handled.statusCode).send({ error: handled.code }); });
  await registerBrowserAccessRoutes(app, browser, async () => {});
  t.after(() => app.close());
  const url = `/api/servers/${serverId}/browser-access/enable`;
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: 'confirm=true' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, payload: { confirm: false } })).statusCode, 400);
  assert.equal(starts, 0);
  assert.equal((await app.inject({ method: 'POST', url, payload: { confirm: true } })).statusCode, 202);
  assert.equal(starts, 1);
});

test('browser settings API validates explicit confirmation and a boolean password requirement', async (t) => {
  const changes: boolean[] = [];
  const browser = { updateSettings: async (_id: string, required: boolean) => { changes.push(required); return { requirePassword: required }; } } as unknown as BrowserAccessService;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { const handled = asAppError(error); reply.code(handled.statusCode).send({ error: handled.code }); });
  await registerBrowserAccessRoutes(app, browser, async () => {});
  t.after(() => app.close());
  const url = `/api/servers/${serverId}/browser-access/settings`;
  for (const payload of [{ requirePassword: false }, { confirm: true, requirePassword: 'false' }, { confirm: false, requirePassword: false }]) {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 400);
  }
  assert.deepEqual(changes, []);
  assert.equal((await app.inject({ method: 'POST', url, payload: { confirm: true, requirePassword: false } })).statusCode, 202);
  assert.deepEqual(changes, [false]);
});

test('failed browser dependency verification and missing Java leave the original server configuration intact', async (t) => {
  for (const options of [{ downloadError: true }, { noJava: true }]) {
    await t.test(Object.keys(options)[0], async (subtest) => {
      const state = await fixture(subtest, options);
      const status = await state.inspect();
      assert.equal(status.status, 'error');
      assert.match(status.error ?? '', options.noJava ? /Java/i : /SHA-256/i);
      assert.equal(status.configured, false);
      assert.equal(status.preview, undefined);
      assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
      assert.equal(state.service.connections.resolve(state.server).backendPort, state.server.port);
    });
  }
});

test('failed preparation invalidates an older browser setup preview', async (t) => {
  const options = { downloadError: false };
  const state = await fixture(t, options);
  const ready = await state.inspect();
  assert.ok(ready.preview);
  options.downloadError = true;
  const failed = await state.inspect();
  assert.equal(failed.status, 'error');
  assert.equal(failed.preview, undefined);
  await assert.rejects(state.service.setup(serverId, ready.preview!.revision), { code: 'browser_preview_stale' });
  assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
});

test('insufficient disk space prevents browser downloads and configuration changes', async (t) => {
  const state = await fixture(t);
  const space = t.mock.method(fsPromises, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
  syncBuiltinESMExports();
  try {
    const status = await state.inspect();
    assert.equal(status.status, 'error');
    assert.match(status.error ?? '', /512 MB|free disk/i);
    assert.equal(state.installations, 0);
    assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
  } finally {
    space.mock.restore();
    syncBuiltinESMExports();
  }
});

test('browser setup rejects stale configuration and version previews without overwriting external edits', async (t) => {
  const state = await fixture(t);
  const status = await state.inspect();
  assert.ok(status.preview);
  assert.equal(status.configured, false);
  assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
  await assert.rejects(state.service.setup(serverId, 'invalid-revision'), { code: 'browser_preview_stale' });
  const externallyEdited = state.originalProperties + 'outside-edit=preserve\n';
  await writeFile(path.join(state.serverRoot, 'server.properties'), externallyEdited);
  await assert.rejects(state.service.setup(serverId, status.preview!.revision), { code: 'browser_preview_stale' });
  assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), externallyEdited);
  await writeFile(path.join(state.serverRoot, 'server.properties'), state.originalProperties);
  state.database.prepare('UPDATE servers SET version = ? WHERE id = ?').run('1.21.5', serverId);
  await assert.rejects(state.service.setup(serverId, status.preview!.revision), { code: 'browser_preview_stale' });
  state.database.prepare('UPDATE servers SET version = ?, software = ? WHERE id = ?').run('1.21.4', 'vanilla', serverId);
  await assert.rejects(state.service.setup(serverId, status.preview!.revision), { code: 'browser_preview_stale' });
  assert.equal(state.service.ports(serverId), null);
});

test('browser setup refuses occupied listener ports before writing managed configuration', async (t) => {
  const state = await fixture(t);
  const status = await state.inspect();
  assert.ok(status.preview);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(state.server.port, '0.0.0.0', resolve));
  try {
    await assert.rejects(state.service.setup(serverId, status.preview!.revision), { code: 'browser_port_in_use' });
    assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), state.originalProperties);
    assert.equal(state.service.ports(serverId), null);
    assert.equal(state.service.hasRecoveryBlock(serverId), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test('approved browser setup isolates the backend and disabling restores owned settings while keeping unrelated edits', async (t) => {
  const state = await fixture(t);
  const prepared = await state.setup();
  assert.equal(prepared.configured, true);
  assert.equal(prepared.enabled, false);
  const via = parse(await readFile(path.join(state.installed.directory, 'plugins/viaversion/config.yml'), 'utf8'));
  assert.equal(via['velocity-ping-interval'], -1);
  assert.equal(via['velocity-ping-save'], false);
  assert.deepEqual(via['velocity-servers'], { default: 769, nodepilot: 769 });
  const propertiesPath = path.join(state.serverRoot, 'server.properties');
  const managedText = await readFile(propertiesPath, 'utf8');
  const properties = parseJavaProperties(managedText);
  assert.equal(properties['online-mode'], 'false');
  assert.equal(properties['server-ip'], '127.0.0.1');
  assert.equal(properties['server-port'], String(state.service.ports(serverId)!.backendPort));
  assert.equal(properties['custom-property'], 'leave-me');
  assert.notEqual(state.service.connections.resolve(state.server).backendPort, state.server.port);
  assert.deepEqual(await readFile(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar')), guardBytes);
  await assert.rejects(state.service.validateStart(serverId), { code: 'browser_gateway_disabled' });
  await writeFile(propertiesPath, managedText + 'new-user-setting=keep-this\n');
  const restored = await state.service.disable(serverId);
  assert.equal(restored.configured, false);
  assert.equal(restored.enabled, false);
  const restoredProperties = parseJavaProperties(await readFile(propertiesPath, 'utf8'));
  assert.equal(restoredProperties['online-mode'], 'true');
  assert.equal(restoredProperties['server-port'], String(state.server.port));
  assert.equal(restoredProperties['new-user-setting'], 'keep-this');
  const spigotText = await readFile(path.join(state.serverRoot, 'spigot.yml'), 'utf8');
  assert.ok(spigotText.includes('# Spigot comment'));
  assert.deepEqual(parse(spigotText), parse(state.originalSpigot));
  assert.deepEqual(parse(await readFile(path.join(state.serverRoot, 'config/paper-global.yml'), 'utf8')), parse(state.originalPaper));
  await assert.rejects(readFile(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(state.serverRoot, 'plugins/BungeeGuard/config.yml')), { code: 'ENOENT' });
  assert.equal(state.service.connections.resolve(state.server).backendPort, state.server.port);
});

test('disabling removes newly created configuration files when they contain only NodePilot-owned settings', async (t) => {
  const state = await fixture(t, { missingYaml: true });
  await state.setup();
  await state.service.disable(serverId);
  for (const relative of ['spigot.yml', 'config/paper-global.yml', 'plugins/BungeeGuard/config.yml']) {
    await assert.rejects(readFile(path.join(state.serverRoot, relative)), { code: 'ENOENT' });
  }
});

test('browser disabling refuses conflicting edits to owned settings and preserves the configured state', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const propertiesPath = path.join(state.serverRoot, 'server.properties');
  const edited = (await readFile(propertiesPath, 'utf8')).replace('online-mode=false', 'online-mode=true');
  await writeFile(propertiesPath, edited);
  await assert.rejects(state.service.disable(serverId), { code: 'browser_configuration_conflict' });
  assert.equal(state.service.hasRecoveryBlock(serverId), false);
  assert.equal((await state.service.status(serverId)).configured, true);
  assert.equal(await readFile(propertiesPath, 'utf8'), edited);
  assert.deepEqual(await readFile(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar')), guardBytes);
});

test('browser startup refuses tampered backend forwarding protection before starting any process', async (t) => {
  for (const relative of ['plugins/NodePilot-BungeeGuard.jar', 'plugins/BungeeGuard/config.yml']) {
    await t.test(relative, async (subtest) => {
      const state = await fixture(subtest);
      await state.setup();
      const record = state.row();
      record.enabled = true;
      state.saveRow(record);
      await writeFile(path.join(state.serverRoot, relative), 'externally changed forwarding protection');
      await assert.rejects(state.service.validateStart(serverId), /guard|forward|configuration|changed/i);
    });
  }
});

test('restart recovery rolls an interrupted setup back and blocks startup when an external edit prevents recovery', async (t) => {
  for (const conflict of [false, true]) {
    await t.test(conflict ? 'external edit blocks recovery' : 'interrupted setup rolls back', async (subtest) => {
      const state = await fixture(subtest);
      await state.setup();
      const record = state.row();
      record.configured = false;
      record.journal = { kind: 'setup', changes: record.files };
      state.saveRow(record);
      const propertiesPath = path.join(state.serverRoot, 'server.properties');
      const externalText = 'external-edit=true\n';
      if (conflict) await writeFile(propertiesPath, externalText);
      const recovered = state.recoverService();
      await recovered.recover();
      assert.equal(recovered.hasRecoveryBlock(serverId), conflict);
      if (conflict) {
        assert.throws(() => recovered.assertCanStart(serverId), { code: 'browser_recovery_required' });
        assert.equal(await readFile(propertiesPath, 'utf8'), externalText);
      } else {
        assert.equal(await readFile(propertiesPath, 'utf8'), state.originalProperties);
        assert.equal(recovered.ports(serverId), null);
        await assert.rejects(readFile(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar')), { code: 'ENOENT' });
      }
    });
  }
});

test('interrupted disable recovery restores the forwarding guard before clearing the startup block', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const record = state.row();
  record.journal = { kind: 'disable', changes: record.files.map((file: { path: string; before: string | null; after: string }) => ({ path: file.path, before: file.after, after: file.before })) };
  state.saveRow(record);
  await writeFile(path.join(state.serverRoot, 'server.properties'), state.originalProperties);
  await unlink(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar'));
  const recovered = state.recoverService();
  await recovered.recover();
  assert.equal(recovered.hasRecoveryBlock(serverId), false);
  assert.equal((await recovered.status(serverId)).configured, true);
  assert.deepEqual(await readFile(path.join(state.serverRoot, 'plugins/NodePilot-BungeeGuard.jar')), guardBytes);
  assert.equal(parseJavaProperties(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'))['online-mode'], 'false');
});

test('stopping during an authentication listener bind settles startup instead of leaving a pending launch', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const live = { children: [], http: [] as HttpServer[], aliases: new Map<number, net.Server>(), sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as {
    running: Map<string, unknown>;
    authListener(id: string, record: unknown, runtime: unknown): Promise<void>;
  };
  internals.running.set(serverId, live);
  const binding = internals.authListener(serverId, state.row(), live);
  const outcome = binding.then(() => 'bound', () => 'cancelled');
  await state.service.stopOwned(serverId);
  const result = await Promise.race([outcome, delay(500).then(() => 'unsettled')]);
  assert.notEqual(result, 'unsettled');
  assert.ok(live.http.every((listener) => !listener.listening));
});

test('stopping during a public wake alias bind leaves no orphan listener', async (t) => {
  const state = await fixture(t, { publicWakePort: await freePort() });
  await state.setup();
  const live = { children: [], http: [] as HttpServer[], aliases: new Map<number, net.Server>(), sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as { running: Map<string, unknown> };
  internals.running.set(serverId, live);
  t.after(() => { for (const listener of live.aliases.values()) listener.close(); });
  const binding = state.service.refreshRouting(serverId);
  const outcome = binding.then(() => 'bound', () => 'cancelled');
  await state.service.stopOwned(serverId);
  const result = await Promise.race([outcome, delay(500).then(() => 'unsettled')]);
  assert.notEqual(result, 'unsettled');
  assert.ok([...live.aliases.values()].every((listener) => !listener.listening));
});

test('public browser readiness retries fresh-domain DNS failures and requires a valid WebSocket upgrade', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const live = { children: [], http: [] as HttpServer[], aliases: new Map<number, net.Server>(), sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as {
    running: Map<string, unknown>;
    probePublicGateway(address: string, runtime: unknown): Promise<void>;
  };
  internals.running.set(serverId, live);
  const mocked = mockPublicGateway(t, ['dns', 'valid']);
  let settled = false;
  const probing = internals.probePublicGateway('wss://newly-created.trycloudflare.com/', live);
  void probing.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();
  assert.equal(mocked.attempts.length, 1);
  assert.equal(settled, false);
  assert.notEqual((await state.service.status(serverId)).status, 'running');
  t.mock.timers.tick(2_000);
  await flushMicrotasks();
  await probing;
  assert.equal(mocked.attempts.length, 2);
  assert.equal(settled, true);
  assert.ok(mocked.sockets.every((socket) => socket.destroyed));
});

test('public browser readiness rejects repeated invalid upgrade signatures within its retry deadline', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const live = { children: [], http: [] as HttpServer[], aliases: new Map<number, net.Server>(), sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as { probePublicGateway(address: string, runtime: unknown): Promise<void> };
  const mocked = mockPublicGateway(t, ['invalid-accept']);
  let resolved = false;
  let settled = false;
  const probing = internals.probePublicGateway('wss://newly-created.trycloudflare.com/', live);
  const outcome = probing.then(() => { resolved = true; settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
  await flushMicrotasks();
  assert.equal(resolved, false);
  assert.equal(mocked.attempts.length, 1);
  for (let iteration = 0; iteration < 31 && !settled; iteration += 1) {
    t.mock.timers.tick(2_000);
    await flushMicrotasks();
  }
  assert.equal(settled, true, 'Invalid upgrades must finish within the simulated retry deadline');
  const error = await outcome as { code: string; message: string };
  assert.equal(resolved, false);
  assert.equal(error.code, 'browser_public_gateway_unreachable');
  assert.match(error.message, /invalid WebSocket handshake/);
  assert.ok(mocked.attempts.length > 1);
  assert.ok(mocked.sockets.every((socket) => socket.destroyed));
  assert.equal(live.publicAddress, null);
});

test('stopping the browser gateway aborts an in-flight public readiness request without retrying', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const live = { children: [], http: [] as HttpServer[], aliases: new Map<number, net.Server>(), sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as {
    running: Map<string, unknown>;
    probePublicGateway(address: string, runtime: unknown): Promise<void>;
  };
  internals.running.set(serverId, live);
  const mocked = mockPublicGateway(t, ['pending']);
  const probing = internals.probePublicGateway('wss://newly-created.trycloudflare.com/', live);
  const outcome = probing.then(() => undefined, (error: unknown) => error);
  await flushMicrotasks();
  assert.equal(mocked.attempts.length, 1);
  assert.equal(mocked.attempts[0].signal.aborted, false);
  await state.service.stopOwned(serverId);
  assert.equal(mocked.attempts[0].signal.aborted, true);
  await flushMicrotasks();
  t.mock.timers.tick(2_000);
  await flushMicrotasks();
  const error = await outcome as Error;
  assert.match(error.message, /cancelled/i);
  assert.equal(mocked.attempts.length, 1);
  assert.equal(live.publicAddress, null);
});

test('browser authentication listener requires its scoped token and verifies local browser accounts', async (t) => {
  const state = await fixture(t);
  await state.setup();
  const record = state.row();
  const live = { children: [], http: [] as HttpServer[], sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const listenerHost = state.service as unknown as { authListener(id: string, configuration: unknown, runtime: unknown): Promise<void> };
  await listenerHost.authListener(serverId, record, live);
  t.after(() => { live.stopping = true; for (const listener of live.http) { listener.closeAllConnections(); listener.close(); } });
  const password = 'correct-browser-password';
  const account = await state.service.accounts.create(serverId, { name: 'Alex', password });
  const endpoint = `http://127.0.0.1:${record.authPort}/verify`;
  const verify = (authorization?: string, candidate = password) => fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
    'content-type': 'application/json', ...(authorization ? { authorization } : {}),
  }, body: JSON.stringify({ name: account.name, password: candidate }) });
  assert.equal((await verify()).status, 403);
  assert.equal((await verify('Bearer incorrect-token')).status, 403);
  assert.equal((await verify(`Bearer ${record.bridgeToken}`, 'wrong-browser-password')).status, 403);
  const accepted = await verify(`Bearer ${record.bridgeToken}`);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, name: account.name, uuid: account.uuid });
  await writeFile(path.join(state.serverRoot, 'usercache.json'), JSON.stringify([{ name: account.name, uuid: account.uuid }]));
  assert.equal((await verify(`Bearer ${record.bridgeToken}`)).status, 200, 'The browser account must be able to reconnect after Minecraft caches its identity');
  await writeFile(path.join(state.serverRoot, 'usercache.json'), JSON.stringify([{ name: account.name, uuid: '22222222-2222-4222-8222-222222222222' }]));
  assert.equal((await verify(`Bearer ${record.bridgeToken}`)).status, 403, 'A conflicting Java identity must block the browser name');
  await unlink(path.join(state.serverRoot, 'usercache.json'));
  state.service.accounts.revoke(serverId, account.id);
  assert.equal((await verify(`Bearer ${record.bridgeToken}`)).status, 403);
});

test('open browser login requires a scoped local token and the persisted open setting, and preserves identities', async (t) => {
  const state = await fixture(t);
  await state.setup();
  assert.equal((await state.service.status(serverId)).requirePassword, true);
  const record = state.row();
  const live = { children: [], http: [] as HttpServer[], sockets: new Set<net.Socket>(), publicAddress: null, stopping: false };
  const internals = state.service as unknown as { authListener(id: string, configuration: unknown, runtime: unknown): Promise<void> };
  await internals.authListener(serverId, record, live);
  t.after(() => { live.stopping = true; for (const listener of live.http) { listener.closeAllConnections(); listener.close(); } });
  const endpoint = `http://127.0.0.1:${record.authPort}/open`;
  const login = (name = 'Alex', token = record.bridgeToken) => fetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`,
  }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(10_000) });
  assert.equal((await login()).status, 403);
  const account = await state.service.accounts.create(serverId, { name: 'Alex', password: '1234' });
  const originalProperties = await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8');
  await state.service.updateSettings(serverId, false);
  while (state.service.isBusy(serverId)) await delay(10);
  assert.equal((await state.service.status(serverId)).requirePassword, false);
  const config = JSON.parse(await readFile(path.join(state.installed.directory, 'plugins/nodepilot-browser-auth/config.json'), 'utf8'));
  assert.equal(config.requirePassword, false);
  assert.equal(await readFile(path.join(state.serverRoot, 'server.properties'), 'utf8'), originalProperties);
  assert.equal((await login('Alex', 'incorrect-token')).status, 403);
  assert.deepEqual(await (await login()).json(), { ok: true, name: account.name, uuid: account.uuid });
  assert.deepEqual(await (await login('NP_ALEX')).json(), { ok: true, name: account.name, uuid: account.uuid });
  state.service.accounts.revoke(serverId, account.id);
  assert.equal((await login()).status, 403);
  await state.service.updateSettings(serverId, true);
  while (state.service.isBusy(serverId)) await delay(10);
  assert.equal((await login('Guest')).status, 403, 'An old listener must honor the new persisted setting');
  state.setActive(true);
  await assert.rejects(state.service.updateSettings(serverId, false), { code: 'server_active' });
});
