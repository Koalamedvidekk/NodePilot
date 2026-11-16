// Optional real-download smoke test. Requires a build and minecraft-protocol via
// NODEPILOT_MINECRAFT_PROTOCOL_MODULE. Uses fresh data, loopback-only game ports,
// and offline authentication exclusively inside these disposable QA servers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.NODEPILOT_BUNDLE_LIVE_ROOT ? await realpath(process.env.NODEPILOT_BUNDLE_LIVE_ROOT) : await mkdtemp(path.join(os.tmpdir(), 'nodepilot-bundle-live-'));
assert.equal(path.dirname(await realpath(root)), await realpath(os.tmpdir()));
assert.ok(path.basename(root).startsWith('nodepilot-bundle-live-'));
const data = path.join(root, 'data');
const pin = 'isolated-bundle-live-test';
const require = createRequire(import.meta.url);
const mc = require(process.env.NODEPILOT_MINECRAFT_PROTOCOL_MODULE ?? 'minecraft-protocol');
const nbt = require('prismarine-nbt');
const portFor = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const port = await portFor();
await mkdir(path.join(root, 'server'), { recursive: true });
await cp(path.join(project, 'server/dist'), path.join(root, 'server/dist'), { recursive: true });
await cp(path.join(project, 'package.json'), path.join(root, 'package.json'));
await cp(path.join(project, 'server/package.json'), path.join(root, 'server/package.json'));
if (!await lstat(path.join(root, 'node_modules')).catch(() => null)) await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(path.join(root, 'run.mjs'), `
import { PlayitService } from './server/dist/services/playit-service.js';
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false, binaryPath: null, version: null,
  isRunning: false, secretExists: false, secretPath: null, claimUrl: null });
await import('./server/dist/index.js');
process.on('message', message => { if (message === 'test-shutdown') process.emit('SIGTERM'); });
`);
const { parseJavaProperties } = await import(pathToFileURL(path.join(root, 'server/dist/lib/java-properties.js')).href);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^NODEPILOT_/i.test(name)));
const backend = spawn(process.execPath, [path.join(root, 'run.mjs')], { cwd: root, windowsHide: true,
  env: { ...env, NODEPILOT_HOST: '127.0.0.1', NODEPILOT_PORT: String(port), NODEPILOT_PIN: pin, NODEPILOT_DATA_DIR: data,
    NODEPILOT_CLIENT_DIST: path.join(project, 'client/dist'), NODEPILOT_LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
backend.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
backend.stderr.on('data', chunk => { output = (output + chunk).slice(-20000); });
const base = 'http://127.0.0.1:' + port;
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + route, { method, headers: { 'x-nodepilot-pin': pin,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, signal: AbortSignal.timeout(180000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify({ route, status: response.status, result })); return result;
}
async function wait(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(message);
}
const clients = new Set();
async function connect(server, name) {
  const client = mc.createClient({ host: '127.0.0.1', port: server.port, username: name, auth: 'offline', version: server.version });
  clients.add(client); client.messages = []; client.chunks = 0; client.packetNames = [];
  client.on('packet', (_packet, meta) => { client.packetNames.push(meta.name); if (client.packetNames.length > 40) client.packetNames.shift(); });
  client.on('ping', packet => client.write('pong', { id: packet.id }));
  client.registerChannel('minecraft:brand', ['string', []]);
  client.on('state', state => { if (state === mc.states.CONFIGURATION) client.writeChannel('minecraft:brand', 'vanilla'); });
  client.on('error', error => { client.failure = error.message; });
  client.on('disconnect', packet => { client.failure = JSON.stringify(packet); });
  client.on('systemChat', packet => client.messages.push(JSON.stringify(packet)));
  client.on('playerChat', packet => client.messages.push(JSON.stringify(packet)));
  client.on('map_chunk', () => { client.chunks += 1; });
  client.on('chunk_batch_finished', () => client.write('chunk_batch_received', { chunksPerTick: 20 }));
  client.on('position', packet => {
    client.position = { x: packet.x, y: packet.y, z: packet.z };
    client.write('teleport_confirm', { teleportId: packet.teleportId });
    client.write('position', { ...client.position, flags: { onGround: true, horizontalCollision: false } });
    if (!client.loaded) { client.loaded = true; client.write('player_loaded', {}); }
  });
  await wait(() => { if (client.failure) throw new Error(client.failure); return client.position && client.chunks > 0; }, 'Vanilla-protocol client did not load a world');
  return client;
}
const closeClient = client => { client.end('QA complete'); clients.delete(client); };
try {
  await wait(async () => { if (backend.exitCode !== null) throw new Error(output); try { return (await api('/health')).ok; } catch { return false; } }, 'QA backend did not start');
  console.log(JSON.stringify({ liveRoot: root, panelPort: port }));
  const java = await api('/java/install', { major: 21 });
  const templates = (await api('/minecraft/templates')).templates;
  const results = JSON.parse(await readFile(path.join(root, 'results.json'), 'utf8').catch(() => '[]'));
  for (const software of process.env.NODEPILOT_LIVE_SOFTWARE?.split(',') ?? ['paper', 'purpur', 'fabric', 'neoforge']) {
    const templateId = ['paper', 'purpur'].includes(software) ? 'smp' : 'optimized-smp';
    const template = templates.find(item => item.id === templateId);
    const settings = { ...template.defaults, viewDistance: 3, maxPlayers: 4, structures: false, seed: '-9223372036854775808' };
    console.log(JSON.stringify({ previewing: software, version: '1.21.4' }));
    const preview = (await api('/minecraft/templates/preview', { templateId, software, version: '1.21.4', templateSettings: settings,
      selections: template.recommendedAddons.map(({ source, projectId }) => ({ source, projectId })) })).preview;
    assert.equal(preview.compatible, true, preview.reason ?? '');
    const { server } = await api('/servers', { name: 'Live bundle ' + software, software, version: '1.21.4', templateId,
      templateSettings: settings, templatePlanId: preview.planId, javaPath: java.installation.path, port: await portFor(), memoryMb: 2048, eulaAccepted: true });
    let last = '';
    await wait(async () => {
      const operation = (await api('/servers/' + server.id + '/template-installation')).installation;
      if (operation.phase !== last) { last = operation.phase; console.log(JSON.stringify({ software, phase: operation.phase })); }
      if (operation.state === 'failed' || operation.state === 'cancelled') throw new Error(operation.error);
      return operation.state === 'succeeded';
    }, software + ' installation did not finish', 15 * 60000);
    const directory = path.join(data, 'servers', server.directory);
    const properties = parseJavaProperties(await readFile(path.join(directory, 'server.properties'), 'utf8'));
    assert.equal(properties['online-mode'], 'true'); assert.equal(properties['enable-rcon'], 'false');
    const listing = await api('/servers/' + server.id + '/addons');
    assert.equal((templateId === 'smp' ? listing.plugins : listing.mods).length, preview.artifacts.length);
    assert.ok((templateId === 'smp' ? listing.plugins : listing.mods).every(item => item.source === 'modrinth' && item.versionId));
    await api('/servers/' + server.id + '/properties', { values: { ...properties, 'server-ip': '127.0.0.1', 'online-mode': 'false', 'enforce-secure-profile': 'false',
      'simulation-distance': '3', 'allow-flight': 'true' } }, 'PUT');
    assert.equal(parseJavaProperties(await readFile(path.join(directory, 'server.properties'), 'utf8'))['server-port'], String(server.port));
    await api('/servers/' + server.id + '/start', {});
    await wait(async () => {
      const lines = (await api('/servers/' + server.id + '/logs?tail=500')).logs;
      const current = (await api('/servers/' + server.id)).server;
      if (current.status === 'error') throw new Error(JSON.stringify(lines.slice(-25)));
      return lines.some(line => /Done \(/.test(line.message));
    }, software + ' did not reach Minecraft readiness', 150000);
    // A stationary protocol client does not simulate gravity. Give it a safe
    // QA platform so teleport safety checks test permissions, not falling.
    await api('/servers/' + server.id + '/command', { command: 'fill -16 100 -16 48 100 16 minecraft:stone' });
    await api('/servers/' + server.id + '/command', { command: 'fill -16 101 -16 48 105 16 minecraft:air' });
    const alice = await connect(server, 'BundleAlice');
    await api('/servers/' + server.id + '/command', { command: 'tp BundleAlice 0.5 101 0.5' });
    await wait(() => Math.abs(alice.position.y - 101) < 0.1, 'QA player did not reach its safe platform');
    const initial = { ...alice.position };
    alice.write('position', { x: initial.x + 1, y: initial.y, z: initial.z, flags: { onGround: true, horizontalCollision: false } });
    let commands = false;
    if (templateId === 'smp') {
      const bob = await connect(server, 'BundleBob');
      await api('/servers/' + server.id + '/command', { command: 'tp BundleBob 32.5 101 0.5' });
      await wait(() => Math.abs(bob.position.y - 101) < 0.1, 'Second QA player did not reach its platform');
      alice.chat('/sethome');
      await wait(async () => { try { return YAML.parse(await readFile(path.join(directory, 'plugins/Essentials/userdata', alice.uuid + '.yml'), 'utf8')).homes?.home; } catch { return false; } }, 'Non-operator could not set a home');
      alice.chat('/msg BundleBob NodePilotBundleMessage');
      await wait(() => bob.messages.some(message => message.includes('NodePilotBundleMessage')), 'Private messages did not work');
      bob.chat('/tpa BundleAlice');
      await new Promise(resolve => setTimeout(resolve, 500));
      alice.chat('/tpaccept');
      await wait(() => bob.position && Math.abs(bob.position.x - initial.x) < 4, 'Accepted teleport did not move the requesting player');
      alice.chat('/gamemode creative'); alice.chat('/op BundleAlice');
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'ops.json'), 'utf8')), []);
      closeClient(bob); commands = true;
    }
    const uuid = alice.uuid; const chunks = alice.chunks; closeClient(alice);
    await new Promise(resolve => setTimeout(resolve, 250));
    const reconnected = await connect(server, 'BundleAlice'); closeClient(reconnected);
    await api('/servers/' + server.id + '/stop', {});
    const player = nbt.simplify((await nbt.parse(await readFile(path.join(directory, 'world/playerdata', uuid + '.dat')))).parsed);
    assert.equal(player.playerGameType, 0, 'An ordinary player gained Creative mode');
    const worlds = (await api('/servers/' + server.id + '/worlds')).worlds;
    assert.equal(worlds.find(world => world.active).seed, '-9223372036854775808');
    const previous = results.findIndex(item => item.software === software); if (previous !== -1) results.splice(previous, 1);
    results.push({ software, version: server.version, artifacts: preview.artifacts.map(file => ({ name: file.name, version: file.versionName })),
      started: true, unmodifiedProtocolJoined: true, chunks, reconnect: true, ordinaryCommands: commands, adminDenied: templateId === 'smp', exactSeed: true });
    await writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ verified: results.at(-1) }));
  }
  console.log(JSON.stringify({ requestedProfilesPassed: true, allLiveChecksPassed: ['paper', 'purpur', 'fabric', 'neoforge'].every(software => results.some(item => item.software === software)), root }));
} finally {
  await writeFile(path.join(root, 'last-client-messages.json'), JSON.stringify([...clients].map(client => ({ name: client.username, state: client.state, loaded: client.loaded, packets: client.packetNames, messages: client.messages.slice(-12) })), null, 2));
  for (const client of clients) client.end('QA ending');
  if (backend.exitCode === null) await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { backend.kill(); reject(new Error('Live QA shutdown did not finish')); }, 60000);
    backend.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Live QA backend exit ' + code)); });
    backend.send('test-shutdown');
  });
}
