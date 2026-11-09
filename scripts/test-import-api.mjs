// Run after npm run build -w server. Exercises the compiled import API with
// temporary storage and local sockets. It never starts Minecraft or Playit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = await realpath(os.tmpdir());
const root = await mkdtemp(path.join(temporary, 'nodepilot-import-api-'));
const dataDirectory = path.join(root, 'data');
const serversDirectory = path.join(dataDirectory, 'servers');
const source = path.join(root, 'Existing Forge World');
const pin = 'isolated-forge-import-test';
const launcher = 'libraries/net/minecraftforge/forge/1.20.1-47.4.0';
let occupied;
let backend;
let output = '';

async function bindLocal() {
  const listener = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  return listener;
}

function closeListener(listener) {
  return new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

async function stopBackend() {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      backend.kill('SIGKILL');
      reject(new Error('Isolated import backend did not shut down gracefully.'));
    }, 10_000);
    backend.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('Isolated import backend exited with code ' + code));
    });
    if (process.platform === 'win32') backend.send('test-shutdown');
    else backend.kill('SIGTERM');
  });
}

try {
  occupied = await bindLocal();
  const originalPort = occupied.address().port;
  const panelSocket = await bindLocal();
  const panelPort = panelSocket.address().port;
  await closeListener(panelSocket);

  const properties = '# preserve this line\nserver-port=' + originalPort + '\nlevel-name=world\nmotd=Forge fixture\n';
  const files = new Map([
    ['server.properties', properties],
    ['eula.txt', '# Original acceptance\neula=true\n'],
    ['user_jvm_args.txt', '-Dfixture.jvm=true\n'],
    [launcher + '/win_args.txt', '-Dfixture.platform=windows\n'],
    [launcher + '/unix_args.txt', '-Dfixture.platform=linux\n'],
    ['world/level.dat', 'fixture world bytes'],
    ['world/playerdata/9cb8385a-659b-4d81-bccf-51a4a204af0f.dat', 'fixture player bytes'],
    ['mods/example.jar', 'fixture mod bytes'],
    ['config/example.toml', 'fixture = true\n'],
  ]);
  for (const [file, content] of files) {
    const destination = path.join(source, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  await mkdir(path.join(root, 'server'));
  await cp(path.join(project, 'server', 'dist'), path.join(root, 'server', 'dist'), { recursive: true });
  await cp(path.join(project, 'package.json'), path.join(root, 'package.json'));
  await cp(path.join(project, 'server', 'package.json'), path.join(root, 'server', 'package.json'));
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, 'run.mjs'), `
import { JavaService } from './server/dist/services/java-service.js';
import { PlayitService } from './server/dist/services/playit-service.js';
JavaService.prototype.findUsable = async (major) => major === 17
  ? { installation: { path: process.execPath, major } } : null;
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false,
  binaryPath: null, version: null, isRunning: false, secretExists: false,
  secretPath: null, claimUrl: null });
await import('./server/dist/index.js');
process.on('message', (message) => {
  if (message === 'test-shutdown') process.emit('SIGTERM');
});
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODEPILOT_/i.test(key)));
  backend = spawn(process.execPath, [path.join(root, 'run.mjs')], {
    cwd: root,
    env: {
      ...env,
      NODEPILOT_HOST: '127.0.0.1',
      NODEPILOT_PORT: String(panelPort),
      NODEPILOT_PIN: pin,
      NODEPILOT_DATA_DIR: dataDirectory,
      NODEPILOT_CLIENT_DIST: path.join(root, 'no-client-build'),
      NODEPILOT_LOG_LEVEL: 'error',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  backend.stdout.on('data', chunk => { output = (output + chunk).slice(-24_000); });
  backend.stderr.on('data', chunk => { output = (output + chunk).slice(-24_000); });
  let spawnError;
  backend.once('error', error => { spawnError = error; });

  async function request(route, input) {
    const headers = { 'x-nodepilot-pin': pin };
    const isForm = input instanceof FormData;
    if (input !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    const response = await fetch('http://127.0.0.1:' + panelPort + '/api' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
      body: isForm ? input : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }

  let healthy = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null) throw new Error('Isolated import backend exited early.');
    try {
      healthy = (await request('/health')).body.ok === true;
    } catch { /* Give the temporary listener time to start. */ }
    if (healthy) break;
    await delay(100);
  }
  assert.ok(healthy, 'Isolated import backend must become ready.');

  const expectedStartup = {
    mode: 'arg-files',
    windowsArgFile: launcher + '/win_args.txt',
    linuxArgFile: launcher + '/unix_args.txt',
    jvmArgFiles: ['user_jvm_args.txt'],
    gameArguments: ['nogui'],
  };
  function assertInspection(inspection) {
    assert.equal(inspection.canImport, true);
    assert.equal(inspection.detectedSoftware, 'forge');
    assert.equal(inspection.minecraftVersion, '1.20.1');
    assert.equal(inspection.serverJar, undefined);
    assert.equal(inspection.port, originalPort);
    assert.deepEqual(inspection.startupConfig, expectedStartup);
    assert.deepEqual(inspection.worlds, ['world']);
    assert.deepEqual(inspection.mods, ['example.jar']);
    assert.equal(inspection.playerDataFiles, 1);
  }

  const detected = await request('/imports/inspect-directory', { path: source });
  assert.equal(detected.status, 200, JSON.stringify(detected.body));
  assertInspection(detected.body.inspection);

  const settings = { software: 'forge', version: '1.20.1', memoryMb: 2048, eulaAccepted: true };
  const directoryInput = { ...settings, name: 'Directory import', source: { type: 'directory', path: source } };
  const conflict = await request('/imports', { ...directoryInput, port: originalPort });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error, 'port_in_use');
  assert.deepEqual(await readdir(serversDirectory), []);

  async function assertImported(result) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const { server } = result.body;
    assert.equal(server.installState, 'ready');
    assert.equal(server.software, 'forge');
    assert.equal(server.version, '1.20.1');
    assert.equal(server.requiredJavaMajor, 17);
    assert.equal(server.javaPath, process.execPath);
    assert.notEqual(server.port, originalPort);
    assert.deepEqual(server.startupConfig, expectedStartup);
    assert.match(server.directory, /^[a-z0-9-]+$/);
    const copied = path.join(serversDirectory, server.directory);
    for (const [file, content] of files) {
      const expected = file === 'server.properties' ? properties.replace('server-port=' + originalPort, 'server-port=' + server.port)
        : file === 'eula.txt' ? 'eula=true\n' : content;
      assert.equal(await readFile(path.join(copied, file), 'utf8'), expected, file);
      assert.equal(await readFile(path.join(source, file), 'utf8'), content, 'Source changed: ' + file);
    }
    assert.ok((await readdir(copied)).every(file => file !== 'server.jar'));
    return server;
  }

  const directory = await assertImported(await request('/imports', directoryInput));
  console.log('PASS Forge directory import selects a free port, Java 17 and retains the original files.');

  const archive = new ZipFile();
  const wrapper = 'Forge Server';
  for (const directory of ['', '/world', '/world/playerdata', '/mods', '/config', '/' + launcher]) {
    archive.addEmptyDirectory(wrapper + directory);
  }
  for (const [file, content] of files) archive.addBuffer(Buffer.from(content), wrapper + '/' + file);
  archive.end();
  const zipPath = path.join(root, 'forge-backup.zip');
  await pipeline(archive.outputStream, createWriteStream(zipPath, { flags: 'wx' }));
  const form = new FormData();
  form.append('file', new Blob([await readFile(zipPath)], { type: 'application/zip' }), 'forge-backup.zip');
  const uploaded = await request('/imports/upload-archive', form);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assertInspection(uploaded.body.inspection);
  const zip = await assertImported(await request('/imports', {
    ...settings, name: 'ZIP import', source: { type: 'archive', uploadId: uploaded.body.uploadId },
  }));
  assert.notEqual(zip.port, directory.port);
  console.log('PASS Wrapped Forge ZIP import accepts directory entries and retains worlds, mods and launch files.');
} catch (error) {
  if (output) console.error('Isolated backend output:\n' + output);
  throw error;
} finally {
  try {
    await stopBackend();
  } finally {
    if (occupied?.listening) await closeListener(occupied);
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('nodepilot-import-api-'));
    await rm(root, { recursive: true, force: true });
  }
}
