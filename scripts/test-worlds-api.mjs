// Run after the server build. Exercises the actual compiled backend in a fresh
// temporary installation, never the user's running panel or shared data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import * as yazl from 'yazl';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-worlds-api-'));
const dataDirectory = path.join(root, 'data');
const serverDirectory = path.join(dataDirectory, 'servers', 'api-fixture');
const serverId = '12345678-1234-4234-8234-123456789abc';
const pin = 'worlds-test-pin';
const route = '/servers/' + serverId + '/worlds';
const hold = path.join(root, 'hold-world-copy');
let child;
let output = '';
let database;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const running = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { running.kill('SIGKILL'); reject(new Error('Isolated Worlds backend did not stop gracefully.')); }, 10_000);
    running.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Isolated Worlds backend exited ' + code)); });
    if (process.platform === 'win32') running.send('test-shutdown');
    else running.kill('SIGTERM');
  });
  child = undefined;
}

async function zipFile(filename, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, contents] of Object.entries(entries)) zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(filename, { flags: 'wx' }));
  return readFile(filename);
}

async function world(folder, inventory) {
  const tree = { name: '', type: 'compound', value: { Data: nbt.comp({
    LevelName: nbt.string(folder), DataVersion: nbt.int(3465), Version: nbt.comp({ Name: nbt.string('1.20.1') }),
    WorldGenSettings: nbt.comp({ seed: { type: 'long', value: [-2147483648, 0] }, generate_features: nbt.byte(1) }),
    Difficulty: nbt.byte(2), hardcore: nbt.byte(0),
    GameRules: nbt.comp({ keepInventory: nbt.string('false'), randomTickSpeed: nbt.string('3') }),
    DataPacks: nbt.comp({ Enabled: { type: 'list', value: { type: 'string', value: ['vanilla'] } }, Disabled: { type: 'list', value: { type: 'string', value: [] } } }),
  }) } };
  await mkdir(path.join(serverDirectory, folder, 'playerdata'), { recursive: true });
  await writeFile(path.join(serverDirectory, folder, 'level.dat'), gzipSync(nbt.writeUncompressed(tree)));
  await writeFile(path.join(serverDirectory, folder, 'playerdata', 'owner.dat'), inventory);
}

try {
  const port = await freePort();
  await world('world', 'world-A inventory and XP');
  await world('second', 'world-B inventory and XP');
  await mkdir(path.join(serverDirectory, 'world_nether', 'DIM-1'), { recursive: true });
  await writeFile(path.join(serverDirectory, 'world_nether', 'DIM-1', 'chunks.mca'), 'preserve nether');
  await mkdir(path.join(serverDirectory, 'plugins'), { recursive: true });
  await writeFile(path.join(serverDirectory, 'plugins', 'global.json'), '{"keep":true}');
  await writeFile(path.join(serverDirectory, 'server.properties'), '# retained\nlevel-name=world\nserver-port=25565\nmotd=Keep me\n');
  await zipFile(path.join(serverDirectory, 'server.jar'), { 'version.json': JSON.stringify({ id: '1.20.1', pack_version: { data: 15 } }) });
  const datapack = await zipFile(path.join(root, 'welcome.zip'), {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 15, description: 'Welcome test' } }),
    'data/test/functions/welcome.mcfunction': 'say welcome\n',
  });
  await mkdir(path.join(root, 'server'), { recursive: true });
  await cp(path.join(projectRoot, 'server', 'dist'), path.join(root, 'server', 'dist'), { recursive: true });
  await cp(path.join(projectRoot, 'package.json'), path.join(root, 'package.json'));
  await cp(path.join(projectRoot, 'server', 'package.json'), path.join(root, 'server', 'package.json'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, '.env'), [
    'NODEPILOT_HOST=127.0.0.1', 'NODEPILOT_PORT=' + port, 'NODEPILOT_PIN=' + pin,
    'NODEPILOT_DATA_DIR="' + dataDirectory.replaceAll('\\', '/') + '"',
    'NODEPILOT_CLIENT_DIST="' + (process.env.NODEPILOT_WORLDS_BROWSER === '1' ? path.join(projectRoot, 'client', 'dist') : path.join(root, 'no-client')).replaceAll('\\', '/') + '"', 'NODEPILOT_LOG_LEVEL=error',
  ].join('\n'));
  await writeFile(path.join(root, 'run.mjs'), `
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PlayitService } from './server/dist/services/playit-service.js';
import { WorldArchiveService } from './server/dist/services/world-archive-service.js';
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false, binaryPath: null,
  version: null, isRunning: false, secretExists: false, secretPath: null, claimUrl: null });
// Only the scheduling is controlled: real copy/backup code runs after release.
const copy = WorldArchiveService.prototype.copyWorld;
WorldArchiveService.prototype.copyWorld = async function (...args) {
  while (await access(${JSON.stringify(hold)}).then(() => true, () => false)) await delay(25);
  return copy.apply(this, args);
};
await import('./server/dist/index.js');
process.on('message', message => { if (message === 'test-shutdown') process.emit('SIGTERM'); });
`);
  const { openDatabase } = await import(pathToFileURL(path.join(root, 'server/dist/db.js')).href);
  const { ServerRepository } = await import(pathToFileURL(path.join(root, 'server/dist/repositories/server-repository.js')).href);
  database = openDatabase(path.join(dataDirectory, 'nodepilot.sqlite'));
  const repository = new ServerRepository(database);
  repository.create({ id: serverId, machineId: 'local', name: 'Isolated Worlds test', directory: 'api-fixture', software: 'paper', version: '1.20.1', port: 25565, memoryMb: 1024, eulaAccepted: true });
  repository.markReady(serverId);
  repository.setCache('minecraft:paper-available-versions', [{ id: '1.20.1', stable: true }]);
  database.close(); database = undefined;
  const baseUrl = 'http://127.0.0.1:' + port;
  async function request(target, { method = 'GET', body, authenticated = true, form } = {}) {
    const response = await fetch(baseUrl + '/api' + target, { method, signal: AbortSignal.timeout(15_000),
      headers: { ...(authenticated ? { 'x-nodepilot-pin': pin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function startChild() {
    output = '';
    child = spawn(process.execPath, [path.join(root, 'run.mjs')], { cwd: root, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-24_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-24_000); });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Isolated Worlds backend exited: ' + output);
      try { if ((await request('/health')).status === 200) return; } catch { /* Listener startup. */ }
      await delay(100);
    }
    throw new Error('Isolated Worlds backend did not start: ' + output);
  }
  async function list() {
    const result = await request(route);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function details(id) {
    const result = await request(route + '/' + id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function completed(response) {
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const operationId = response.body.operation.id;
    for (let count = 0; count < 300; count += 1) {
      const result = await request(route + '/operations/' + operationId);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (result.body.state !== 'running') { assert.equal(result.body.state, 'succeeded', result.body.error); return result.body; }
      await delay(25);
    }
    throw new Error('World operation timed out.');
  }
  await startChild();
  assert.equal((await request(route, { authenticated: false })).status, 401);
  let listing = await list();
  assert.equal(listing.worlds.length, 2);
  const original = listing.worlds.find(world => world.active);
  assert.equal(original.seed, '-9223372036854775808');
  assert.ok(original.dimensions.includes('minecraft:the_nether'));
  console.log('PASS compiled Worlds routes require PIN and read exact seed/grouped dimensions');

  const preparation = await completed(await request(route, { method: 'POST', body: { name: 'Fresh world', revision: listing.revision, seed: '', preset: 'minecraft:normal', generatorSettings: '{}', structures: true, hardcore: false, difficulty: 'normal', enabledPacks: ['vanilla'], disabledPacks: [] } }));
  listing = await list();
  const fresh = listing.worlds.find(world => world.id === preparation.result.worldId);
  assert.equal(fresh.state, 'prepared'); assert.equal(fresh.active, true); assert.equal(fresh.seed, null);
  const server = await request('/servers/' + serverId);
  assert.equal(server.body.server.status, 'stopped');
  assert.equal(await readFile(path.join(serverDirectory, 'world/playerdata/owner.dat'), 'utf8'), 'world-A inventory and XP');
  assert.equal((await request(route, { method: 'POST', body: { name: 'Stale', revision: '0'.repeat(64), seed: '', preset: 'minecraft:normal', generatorSettings: '{}', structures: true, hardcore: false, difficulty: 'normal', enabledPacks: ['vanilla'], disabledPacks: [] } })).status, 409);
  console.log('PASS prepare selects a new world without starting Minecraft or changing previous player data');

  let saved = await details(original.id);
  await completed(await request(route + '/' + original.id + '/activate', { method: 'POST', body: { revision: saved.world.revision, confirmCompatibility: true } }));
  saved = await details(original.id);
  await completed(await request(route + '/' + original.id + '/gamerules', { method: 'PUT', body: { revision: saved.world.revision, rules: { keepInventory: true, randomTickSpeed: 6 } } }));
  saved = await details(original.id);
  assert.equal(saved.gameRules.find(rule => rule.id === 'keepInventory').value, true);
  const form = new FormData();
  // Deliberately send revision after file: multipart field order must not matter.
  form.append('file', new Blob([datapack], { type: 'application/zip' }), 'welcome.zip');
  form.append('revision', saved.world.revision);
  await completed(await request(route + '/' + original.id + '/datapacks', { method: 'POST', form }));
  saved = await details(original.id);
  assert.equal(saved.datapacks.find(pack => pack.id === 'file/welcome.zip').compatible, true);
  assert.equal(saved.datapacks.find(pack => pack.id === 'file/welcome.zip').enabled, false);
  await completed(await request(route + '/' + original.id + '/datapacks', { method: 'PATCH', body: { revision: saved.world.revision, enabled: ['vanilla', 'file/welcome.zip'], disabled: [] } }));
  saved = await details(original.id);
  assert.equal(saved.datapacks.find(pack => pack.id === 'file/welcome.zip').enabled, true);
  console.log('PASS saved game rules and compatible datapack upload/enable use real metadata writes');

  await writeFile(hold, 'hold backup scheduling');
  const backup = await request(route + '/' + original.id + '/backups', { method: 'POST', body: { revision: saved.world.revision } });
  assert.equal(backup.status, 202, JSON.stringify(backup.body));
  assert.equal((await request('/servers/' + serverId + '/start', { method: 'POST' })).status, 409);
  assert.equal((await request('/servers/' + serverId + '/files/content', { method: 'PUT', body: { path: 'server.properties', content: 'level-name=unsafe\n' } })).status, 409);
  assert.equal((await request(route + '/' + original.id, { method: 'PATCH', body: { revision: saved.world.revision, name: 'Concurrent' } })).status, 409);
  await rm(hold);
  await completed(backup);
  console.log('PASS lifecycle, file writes and concurrent world mutations share maintenance exclusion');

  saved = await details(original.id);
  const exported = await completed(await request(route + '/' + original.id + '/export', { method: 'POST', body: { revision: saved.world.revision } }));
  assert.equal((await fetch(baseUrl + exported.result.downloadUrl)).status, 401);
  const download = await fetch(baseUrl + exported.result.downloadUrl, { headers: { 'x-nodepilot-pin': pin } });
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/zip');
  const zippedWorld = await download.arrayBuffer();
  const upload = new FormData(); upload.append('file', new Blob([zippedWorld], { type: 'application/zip' }), 'world.zip');
  const inspected = await completed(await request(route + '/import/inspect', { method: 'POST', form: upload }));
  const inspection = inspected.result.inspection;
  assert.equal(inspection.candidates.length, 1);
  assert.equal(inspection.candidates[0].seed, '-9223372036854775808');
  listing = await list();
  const imported = await completed(await request(route + '/import', { method: 'POST', body: { revision: listing.revision, name: 'Imported copy', inspectionId: inspection.id, candidateId: inspection.candidates[0].id, confirmCompatibility: true } }));
  const importedWorld = (await details(imported.result.worldId)).world;
  assert.equal(importedWorld.active, false);
  assert.equal(await readFile(path.join(serverDirectory, importedWorld.folder, 'playerdata/owner.dat'), 'utf8'), 'world-A inventory and XP');
  assert.equal(await readFile(path.join(serverDirectory, importedWorld.folder + '_nether', 'DIM-1/chunks.mca'), 'utf8'), 'preserve nether');
  console.log('PASS authenticated ZIP export/inspection/import round trip preserves grouped dimensions and player progress');

  const removed = await completed(await request(route + '/' + importedWorld.id, { method: 'DELETE', body: { revision: importedWorld.revision, confirmName: importedWorld.name } }));
  const deleted = await details(importedWorld.id);
  assert.equal(deleted.world.deleted, true);
  await completed(await request(route + '/' + importedWorld.id + '/backups/' + removed.result.backupId + '/restore', { method: 'POST', body: { revision: deleted.world.revision, confirm: true } }));
  assert.equal((await details(importedWorld.id)).world.deleted, false);
  saved = await details(original.id);
  await completed(await request(route + '/' + original.id + '/datapacks/' + encodeURIComponent('file/welcome.zip'), { method: 'DELETE', body: { revision: saved.world.revision } }));
  assert.equal((await details(original.id)).datapacks.some(pack => pack.id === 'file/welcome.zip'), false);
  assert.equal(await readFile(path.join(serverDirectory, 'plugins/global.json'), 'utf8'), '{"keep":true}');
  await stopChild(); await startChild();
  listing = await list();
  assert.equal(listing.worlds.length, 4); assert.equal(listing.activeWorldId, original.id);
  assert.equal((await details(fresh.id)).world.state, 'prepared');
  assert.equal((await details(importedWorld.id)).backups.length > 0, true);
  assert.equal((await request('/servers/' + serverId)).body.server.status, 'stopped');
  console.log('PASS backed-up deletion/restore, datapack removal and catalogue state survive a backend restart');
  if (process.env.NODEPILOT_WORLDS_BROWSER === '1') {
    const { testWorldsBrowser } = await import('./test-worlds-browser.mjs');
    await testWorldsBrowser({ baseUrl, serverId, pin, originalWorldId: original.id });
  }
} catch (error) {
  if (output) console.error('Isolated Worlds backend output:\n' + output);
  throw error;
} finally {
  if (database) database.close();
  await rm(hold, { force: true });
  await stopChild();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('nodepilot-worlds-api-'));
  await rm(root, { recursive: true, force: true });
}
