// Run after npm run build. Starts a separate compiled NodePilot backend using
// temporary data and an ephemeral port; never contacts the user's running panel.
// Set NODEPILOT_VERSIONS_LIVE_METADATA=1 to fetch the full official Paper release
// catalogue instead of seeded metadata. No game download or Java launch occurs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-versions-api-'));
const serverId = '12345678-1234-4234-8234-123456789abc';
const pin = 'versions-test-pin';
const liveMetadata = process.env.NODEPILOT_VERSIONS_LIVE_METADATA === '1';
let child;
let output = '';
let database;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const running = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated test backend did not exit.')), 10_000);
    running.once('exit', () => { clearTimeout(timeout); resolve(); });
    // This PID belongs exclusively to the test. Never kill by executable name.
    running.kill('SIGTERM');
  });
  child = undefined;
}

try {
  const port = await freePort();
  const dataDirectory = path.join(root, 'data');
  const serverDirectory = path.join(dataDirectory, 'servers', 'api-fixture');
  await mkdir(path.join(serverDirectory, 'plugins'), { recursive: true });
  await writeFile(path.join(serverDirectory, 'plugins', 'compatibility-marker.jar'), 'test marker; never launched');
  await writeFile(path.join(serverDirectory, 'server.properties'), 'server-port=25565\nlevel-name=world\n');
  await writeFile(path.join(serverDirectory, 'server.jar'), 'test runtime; never launched');
  await mkdir(path.join(root, 'server'), { recursive: true });
  await cp(path.join(projectRoot, 'server', 'dist'), path.join(root, 'server', 'dist'), { recursive: true });
  await cp(path.join(projectRoot, 'package.json'), path.join(root, 'package.json'));
  await cp(path.join(projectRoot, 'server', 'package.json'), path.join(root, 'server', 'package.json'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, '.env'), [
    'NODEPILOT_HOST=127.0.0.1',
    'NODEPILOT_PORT=' + port,
    'NODEPILOT_PIN=' + pin,
    'NODEPILOT_DATA_DIR="' + dataDirectory.replaceAll('\\', '/') + '"',
    'NODEPILOT_CLIENT_DIST="' + path.join(root, 'no-client-build').replaceAll('\\', '/') + '"',
    'NODEPILOT_LOG_LEVEL=error',
  ].join('\n'));
  // Disable only unrelated external-agent discovery. A globally installed
  // Playit agent or its credentials must never be used by this regression test.
  await writeFile(path.join(root, 'run.mjs'), `
import { PlayitService } from './server/dist/services/playit-service.js';
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false,
  binaryPath: null, version: null, isRunning: false, secretExists: false,
  secretPath: null, claimUrl: null });
await import('./server/dist/index.js');
`);

  const { openDatabase } = await import(pathToFileURL(path.join(root, 'server', 'dist', 'db.js')).href);
  const { ServerRepository } = await import(pathToFileURL(path.join(root, 'server', 'dist', 'repositories', 'server-repository.js')).href);
  database = openDatabase(path.join(dataDirectory, 'nodepilot.sqlite'));
  const repository = new ServerRepository(database);
  repository.create({
    id: serverId, machineId: 'local', name: 'Isolated Versions API test',
    directory: 'api-fixture', software: 'paper', version: '1.21.4',
    port: 25565, memoryMb: 1024, eulaAccepted: true,
  });
  repository.markReady(serverId);

  if (liveMetadata) {
    const response = await fetch('https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds', {
      headers: { 'User-Agent': 'NodePilot regression test (https://github.com/Koalamedvidekk/NodePilot)' },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, 'Official Paper build metadata must load in live mode');
    const builds = await response.json();
    const stable = builds.find((build) => build.channel === 'STABLE' && build.downloads?.['server:default']?.url);
    assert.ok(stable, 'Paper 1.21.4 must have an official stable downloadable build');
    repository.setCache('minecraft:paper-build:1.21.4', stable);
    console.log('PASS official Paper stable-release metadata verified (no artifact download)');
  }
  if (!liveMetadata) repository.setCache('minecraft:paper-available-versions', [{ id: '1.21.4', stable: true }]);
  database.close();
  database = undefined;

  const baseUrl = 'http://127.0.0.1:' + port;
  async function request(route, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch(baseUrl + '/api' + route, {
      method, signal: AbortSignal.timeout(liveMetadata ? 60_000 : 15_000),
      headers: {
        ...(authenticated ? { 'x-nodepilot-pin': pin } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Expected API JSON, received: ' + text.slice(0, 120)); }
    return { status: response.status, body: payload };
  }
  async function startChild() {
    output = '';
    child = spawn(process.execPath, [path.join(root, 'run.mjs')], {
      cwd: root, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-24_000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-24_000); });
    let spawnError;
    child.once('error', (error) => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Test backend exited: ' + output);
      try {
        const result = await request('/health');
        if (result.status === 200 && result.body.ok) return;
      } catch { /* Wait briefly for the temporary listener. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Test backend never became ready: ' + output);
  }

  await startChild();
  const route = '/servers/' + serverId + '/versions';
  const unauthorized = await request(route, { authenticated: false });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, 'pin_required');
  console.log('PASS Versions API requires the panel PIN');

  const initial = await request(route);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.currentVersion, '1.21.4');
  assert.equal(initial.body.software, 'paper');
  assert.ok(initial.body.versions.some((version) => version.id === '1.21.4'));
  assert.equal(initial.body.autoUpdate, false);
  assert.match(initial.body.automaticUpdateBlockedReason, /plugins or mods/i);
  assert.equal(initial.body.lastError, null);
  if (liveMetadata) assert.ok(initial.body.versions.length > 1, 'Live GET must discover the real Paper release catalogue');
  console.log('PASS Versions GET returns usable release metadata and add-on compatibility state');
  if (liveMetadata) console.log('LIVE Paper releases: ' + initial.body.versions.length + '; latest stable: ' + initial.body.latestVersion);

  const checked = await request(route + '/check', { method: 'POST' });
  assert.equal(checked.status, 200);
  assert.ok(Number.isFinite(Date.parse(checked.body.lastCheckedAt)));
  assert.ok(checked.body.versions.some((version) => version.id === checked.body.latestVersion));
  console.log('PASS Check for updates reaches the registered backend endpoint');

  const enabled = await request(route + '/preferences', { method: 'PUT', body: { autoUpdate: true } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.autoUpdate, true);
  assert.equal((await request(route + '/preferences', { method: 'PUT', body: { autoUpdate: 'yes' } })).status, 400);
  assert.equal((await request(route + '/install', { method: 'POST', body: { version: '1.21.4' } })).status, 400);
  assert.equal((await request(route + '/install', { method: 'POST', body: { version: '../escape', confirm: true } })).status, 400);
  const snapshot = await request(route + '/install', { method: 'POST', body: { version: '1.22-pre1', confirm: true } });
  assert.equal(snapshot.status, 400);
  assert.equal(snapshot.body.error, 'invalid_minecraft_version');
  const unavailable = await request(route + '/install', { method: 'POST', body: { version: '999.1', confirm: true } });
  assert.equal(unavailable.status, 422);
  assert.equal(unavailable.body.error, 'unsupported_version');
  const missingServer = await request('/servers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/versions');
  assert.equal(missingServer.status, 404);
  assert.equal(missingServer.body.error, 'server_not_found');
  console.log('PASS preference, confirmation, version and missing-server validation');

  await stopChild();
  // The process is restarted with the same temporary DB, as a real panel restart
  // does; the preference must survive and must not trigger a game launch.
  await startChild();
  const persisted = await request(route);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.autoUpdate, true);
  assert.equal(persisted.body.currentVersion, '1.21.4');
  assert.match(persisted.body.automaticUpdateBlockedReason, /plugins or mods/i);
  const disabled = await request(route + '/preferences', { method: 'PUT', body: { autoUpdate: false } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.autoUpdate, false);
  console.log('PASS auto-update preference survives a real backend restart and can be disabled');
} catch (error) {
  if (output) console.error('Isolated backend output:\n' + output);
  throw error;
} finally {
  if (database) database.close();
  await stopChild();
  // Validate the exact mkdtemp target before recursive removal. rm does not
  // follow the node_modules directory link into the real project.
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('nodepilot-versions-api-'));
  await rm(root, { recursive: true, force: true });
}
