// Run after building. Uses an isolated backend, database and filesystem. Trusted
// downloads and Java detection have explicit fixtures; UI requests reach Fastify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZipFile } from 'yazl';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = await realpath(os.tmpdir());
const root = await mkdtemp(path.join(temporary, 'nodepilot-templates-api-'));
const data = path.join(root, 'data');
const pin = 'isolated-templates-test';
const ui = process.argv.includes('--ui');
const bundles = process.argv.includes('--bundles');
let backend, browser;
let output = '';
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = 'http://127.0.0.1:' + port;
const { parseJavaProperties, patchJavaProperties } = await import(pathToFileURL(path.join(project, 'server/dist/lib/java-properties.js')).href);

async function request(route, body, authenticated = true) {
  const response = await fetch(base + '/api' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { 'x-nodepilot-pin': pin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function start() {
  output = '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODEPILOT_/i.test(key)));
  backend = spawn(process.execPath, [path.join(root, 'run.mjs')], { cwd: root, windowsHide: true,
    env: { ...env, NODEPILOT_HOST: '127.0.0.1', NODEPILOT_PORT: String(port), NODEPILOT_PIN: pin,
      NODEPILOT_DATA_DIR: data, NODEPILOT_CLIENT_DIST: path.join(project, 'client/dist'), NODEPILOT_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backend.stdout.on('data', chunk => { output = (output + chunk).slice(-12_000); });
  backend.stderr.on('data', chunk => { output = (output + chunk).slice(-12_000); });
  let spawnError;
  backend.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null) throw new Error('Fixture backend exited: ' + output);
    try { if ((await request('/health')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture backend never became ready: ' + output);
}
async function stop() {
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { backend.kill(); reject(new Error('Fixture backend did not stop')); }, 10_000);
    backend.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Fixture backend exited ' + code)); });
    backend.send('test-shutdown');
  });
}

try {
  await mkdir(path.join(root, 'server'));
  await cp(path.join(project, 'server/dist'), path.join(root, 'server/dist'), { recursive: true });
  await cp(path.join(project, 'package.json'), path.join(root, 'package.json'));
  await cp(path.join(project, 'server/package.json'), path.join(root, 'server/package.json'));
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const definitions = [
    { id: 'hXiIvTyT', name: 'EssentialsX', mod: false }, { id: 'Vebnzrzj', name: 'LuckPerms', mod: false },
    { id: 'gvQqBUqZ', name: 'Lithium', mod: true }, { id: 'uXXizFIs', name: 'FerriteCore', mod: true },
  ];
  const providerFiles = {};
  for (const definition of definitions) {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(definition.mod ? JSON.stringify({ schemaVersion: 1, id: definition.name.toLowerCase(), name: definition.name, version: '1.0', environment: '*' })
      : `name: ${definition.name}\nversion: '1.0'\nmain: test.Main\napi-version: '1.21'\n`), definition.mod ? 'fabric.mod.json' : 'plugin.yml');
    const parts = []; zip.outputStream.on('data', part => parts.push(part));
    const ended = new Promise((resolve, reject) => { zip.outputStream.once('end', resolve); zip.outputStream.once('error', reject); });
    zip.end(); await ended; providerFiles[definition.id] = Buffer.concat(parts).toString('base64');
  }
  await writeFile(path.join(root, 'provider-fixtures.json'), JSON.stringify({ definitions, files: providerFiles }));
  await writeFile(path.join(root, 'run.mjs'), `
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MinecraftService } from './server/dist/services/minecraft-service.js';
import { JavaService } from './server/dist/services/java-service.js';
import { PlayitService } from './server/dist/services/playit-service.js';
const versions = ['26.3', '1.21.4', '1.8.9', '1.7.10'];
MinecraftService.prototype.getVersions = async () => versions.map(id => ({ id, type: 'release', releaseTime: null, available: true }));
MinecraftService.prototype.assertVersionAvailable = async (_, version) => { if (!versions.includes(version)) throw new Error('Unexpected fixture version'); };
MinecraftService.prototype.getRequiredJavaMajor = async () => 21;
MinecraftService.prototype.stageRuntime = async (server, directory) => {
  await writeFile(path.join(directory, 'server.jar'), 'isolated trusted-download fixture');
  return { software: server.software, loaderVersion: null, startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] } };
};
JavaService.prototype.list = async () => [{ path: process.execPath, major: 21, version: 'fixture-java-21' }];
JavaService.prototype.findUsable = async () => ({ installation: { path: process.execPath, major: 21 } });
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false, binaryPath: null, version: null,
  isRunning: false, secretExists: false, secretPath: null, claimUrl: null });
if (${bundles}) {
  const data = JSON.parse(await readFile('./provider-fixtures.json', 'utf8'));
  const nativeFetch = globalThis.fetch;
  let failNext = false;
  process.on('message', message => { if (message === 'test-fail-next-download') failNext = true; });
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'cdn.modrinth.com') {
      await new Promise(resolve => setTimeout(resolve, 350));
      const bytes = Buffer.from(data.files[target.pathname.split('/')[2]], 'base64');
      if (failNext) { failNext = false; return new Response('corrupt fixture'); }
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    if (target.hostname === 'api.modrinth.com') {
      if (target.pathname === '/v2/search') return Response.json({ hits: data.definitions.filter(p => p.name.toLowerCase().includes(target.searchParams.get('query').toLowerCase())).map(p => ({ project_id: p.id, title: p.name, description: 'Catalogue fixture', all_project_types: [p.mod ? 'mod' : 'plugin'], versions: ['1.21.4'], server_side: 'required', categories: [p.mod ? 'fabric' : 'paper'] })) });
      const id = target.pathname.split('/')[3];
      const p = data.definitions.find(item => item.id === id);
      if (!p) return Response.json({}, { status: 404 });
      if (target.pathname.endsWith('/version')) {
        const bytes = Buffer.from(data.files[id], 'base64');
        return Response.json([{ id: id + '-v1', project_id: id, name: '1.0', version_number: '1.0', version_type: 'release', date_published: '2026-11-01T00:00:00Z',
          game_versions: ['1.21.4'], loaders: [p.mod ? 'fabric' : 'paper'], dependencies: [], files: [{ primary: true, filename: p.name + '.jar',
          url: 'https://cdn.modrinth.com/data/' + id + '/1.0.jar', size: bytes.length, hashes: { sha512: createHash('sha512').update(bytes).digest('hex') } }] }]);
      }
      return Response.json({ id, title: p.name, client_side: p.mod ? 'optional' : 'unsupported', server_side: 'required' });
    }
    return nativeFetch(url, options);
  };
}
await import('./server/dist/index.js');
process.on('message', message => { if (message === 'test-shutdown') process.emit('SIGTERM'); });
`);
  await start();
  assert.equal((await request('/minecraft/templates', undefined, false)).status, 401);
  const catalogue = await request('/minecraft/templates');
  assert.equal(catalogue.status, 200);
  const templates = catalogue.body.templates;
  assert.deepEqual(templates.map(item => item.id), ['smp', 'optimized-smp', 'pure-vanilla', 'creative', 'hardcore']);
  const versions = await request('/minecraft/versions?software=vanilla&templateId=pure-vanilla');
  assert.deepEqual(versions.body.versions.map(item => item.id), ['26.3', '1.21.4', '1.8.9']);
  assert.equal((await request('/minecraft/versions?software=paper&templateId=pure-vanilla')).status, 422);
  assert.equal((await request('/minecraft/versions?software=vanilla&templateId=missing')).status, 400);
  console.log('PASS authenticated template catalogue and compatible version choices');

  const input = { name: 'Template API fixture', software: 'vanilla', version: '1.21.4', eulaAccepted: true, templateId: 'pure-vanilla' };
  for (const [changes, status] of [ [{ eulaAccepted: false }, 400], [{ templateId: 'missing' }, 400],
    [{ software: 'bedrock' }, 422], [{ software: 'paper' }, 422], [{ version: '1.7.10' }, 422],
    [{ templateSettings: { 'online-mode': false } }, 400], [{ templateSettings: { maxPlayers: 0 } }, 400],
    [{ templateSettings: { seed: 'seed\nonline-mode=false' } }, 400],
    [{ templateId: 'hardcore', templateSettings: { difficulty: 'peaceful' } }, 400],
    [{ templateId: undefined, templateSettings: {} }, 400] ]) {
    assert.equal((await request('/servers', { ...input, ...changes })).status, status, JSON.stringify(changes));
  }
  assert.deepEqual((await request('/servers')).body.servers, []);
  console.log('PASS invalid templates, settings, EULA and software rejected before creating servers');

  let saved;
  for (const template of templates) {
    const result = await request('/servers', { ...input, name: template.name + ' fixture', software: template.defaultSoftware,
      templateId: template.id, templateSettings: { maxPlayers: 9, viewDistance: 6, seed: '-9223372036854775808' } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const server = result.body.server;
    assert.ok(['offline', 'stopped'].includes(server.status));
    assert.equal(server.version, '1.21.4');
    const file = path.join(data, 'servers', server.directory, 'server.properties');
    const values = parseJavaProperties(await readFile(file, 'utf8'));
    assert.equal(values.gamemode, template.defaults.gameMode);
    assert.equal(values.hardcore, String(template.defaults.hardcore));
    assert.equal(values['level-seed'], '-9223372036854775808');
    assert.equal(values['max-players'], '9');
    assert.equal(values['online-mode'], 'true');
    saved = { file, id: server.id };
  }
  await writeFile(saved.file, patchJavaProperties(await readFile(saved.file, 'utf8'), { 'max-players': '13' }));
  await stop();
  await start();
  assert.equal((await request('/servers/' + saved.id)).status, 200);
  assert.equal(parseJavaProperties(await readFile(saved.file, 'utf8'))['max-players'], '13');
  console.log('PASS each template creates a stopped server and later edits survive panel restart');

  if (bundles) {
    const previewInput = { templateId: 'smp', software: 'paper', version: '1.21.4', selections: definitions.filter(p => !p.mod).map(p => ({ source: 'modrinth', projectId: p.id })) };
    assert.equal((await request('/minecraft/templates/preview', previewInput, false)).status, 401);
    const preview = (await request('/minecraft/templates/preview', previewInput)).body.preview;
    assert.equal(preview.compatible, true); assert.deepEqual(preview.versions, ['1.21.4']); assert.equal(preview.artifacts.length, 2);
    assert.equal((await request('/minecraft/templates/preview', { ...previewInput, version: '26.3' })).body.preview.compatible, false);
    const createInput = { ...input, name: 'Exact bundle fixture', software: 'paper', templateId: 'smp', templatePlanId: preview.planId };
    const created = await request('/servers', createInput); assert.equal(created.status, 202);
    const id = created.body.server.id;
    const repeated = await request('/servers', createInput); assert.equal(repeated.status, 202); assert.equal(repeated.body.server.id, id);
    assert.equal((await request('/servers/' + id + '/start', {})).status, 409);
    assert.equal((await request('/servers/' + id + '/files/create-file', { parentPath: '', name: 'external.txt', content: 'x' })).status, 409);
    assert.equal((await request('/host/updates/install', {})).status, 409);
    const wait = async serverId => {
      const end = Date.now() + 15000;
      while (Date.now() < end) { const result = await request('/servers/' + serverId + '/template-installation'); if (result.body.installation.state !== 'running') return result.body.installation; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Bundle operation did not settle');
    };
    assert.equal((await wait(id)).state, 'succeeded');
    const addons = await request('/servers/' + id + '/addons'); assert.equal(addons.body.plugins.length, 2);
    assert.ok(addons.body.plugins.every(file => file.source === 'modrinth' && file.versionId.endsWith('-v1')));
    backend.send('test-fail-next-download');
    const next = (await request('/minecraft/templates/preview', previewInput)).body.preview;
    const failed = await request('/servers', { ...createInput, templatePlanId: next.planId });
    assert.equal((await wait(failed.body.server.id)).state, 'failed');
    assert.equal((await request('/servers/' + failed.body.server.id + '/template-installation/retry', {})).status, 200);
    assert.equal((await wait(failed.body.server.id)).state, 'succeeded');
    const concurrentPlan = (await request('/minecraft/templates/preview', previewInput)).body.preview;
    const parallel = await Promise.all([request('/servers', { ...createInput, templatePlanId: concurrentPlan.planId }), request('/servers', { ...createInput, templatePlanId: concurrentPlan.planId })]);
    assert.ok(parallel.every(result => result.status === 202));
    assert.equal(parallel[0].body.server.id, parallel[1].body.server.id);
    assert.equal((await wait(parallel[0].body.server.id)).state, 'succeeded');
    const cancelledPlan = (await request('/minecraft/templates/preview', previewInput)).body.preview;
    const cancelled = await request('/servers', { ...createInput, templatePlanId: cancelledPlan.planId });
    assert.equal((await request('/servers/' + cancelled.body.server.id + '/template-installation/cancel', {})).body.installation.state, 'cancelled');
    assert.equal((await request('/servers/' + cancelled.body.server.id + '/start', {})).status, 409);
    console.log('PASS pinned background bundles, idempotent creation, maintenance exclusion and real failure/retry APIs');
  }

  if (ui) {
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? 'playwright');
    browser = await chromium.launch({ headless: true,
      ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(value => localStorage.setItem('nodepilot_pin', value), pin);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const choose = async (label, option) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
    await page.goto(base + '/servers/new');
    await page.getByRole('radio', { name: /Pure Vanilla/ }).check();
    await choose('Minecraft version', '1.21.4');
    assert.equal(await page.locator('input[name="software"]').count(), 1);
    await page.getByRole('button', { name: 'Continue', exact: false }).click();
    await page.getByRole('textbox', { name: 'Server name' }).fill('Browser template fixture');
    await page.getByRole('spinbutton', { name: 'Player limit' }).fill('8');
    await page.getByRole('textbox', { name: /World seed/ }).fill('9223372036854775807');
    await page.getByRole('checkbox', { name: 'Enable whitelist' }).check();
    await page.getByRole('checkbox', { name: 'Generate structures' }).uncheck();
    await choose('Template difficulty', 'Hard');
    await page.getByRole('button', { name: 'Review server' }).click();
    await page.getByText('Pure Vanilla · Minecraft 1.21.4', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/servers' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create server', exact: true }).click();
    const response = await created;
    assert.equal(response.status(), 201);
    assert.equal(response.request().postDataJSON().templateId, 'pure-vanilla');
    assert.equal(response.request().postDataJSON().enablePlayit, false);
    const result = await response.json();
    const values = parseJavaProperties(await readFile(path.join(data, 'servers', result.server.directory, 'server.properties'), 'utf8'));
    assert.equal(result.server.version, '1.21.4');
    assert.equal(values['max-players'], '8');
    assert.equal(values['level-seed'], '9223372036854775807');
    assert.equal(values['white-list'], 'true');
    assert.equal(values['generate-structures'], 'false');
    assert.equal(values.difficulty, 'hard');
    console.log('PASS browser selects a version, customizes a template and creates through the real API');

    await page.goto(base + '/servers/new');
    await page.getByRole('radio', { name: /Hardcore One-life/ }).check();
    await page.getByRole('button', { name: 'Continue', exact: false }).click();
    assert.equal(await page.getByRole('button', { name: 'Default game mode', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Template difficulty', exact: true }).isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Hardcore (one life)', exact: true }).uncheck();
    assert.equal(await page.getByRole('button', { name: 'Template difficulty', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: 'Reset template settings' }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Hardcore (one life)', exact: true }).isChecked(), true);
    await page.getByRole('button', { name: 'Back', exact: false }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const bounds = await page.locator('.template-card').evaluateAll(cards => cards.map(card => ({
      right: card.getBoundingClientRect().right, width: innerWidth,
    })));
    assert.ok(bounds.every(card => card.right <= card.width), JSON.stringify(bounds));
    if (process.env.NODEPILOT_TEST_SCREENSHOT) await page.screenshot({ path: process.env.NODEPILOT_TEST_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: /Minecraft: Bedrock Edition/ }).click();
    assert.equal(await page.locator('input[name="template"]').count(), 0);
    await page.getByRole('button', { name: /Minecraft: Java Edition/ }).click();
    await page.getByRole('radio', { name: /Custom setup/ }).waitFor();
    assert.equal(await page.getByRole('radio', { name: /Custom setup/ }).isChecked(), true);
    assert.equal(await page.locator('input[name="software"]').count(), 8);
    assert.deepEqual(errors, []);
    console.log('PASS Hardcore constraints/reset, responsive layout and unchanged Custom/Bedrock flows');

    if (bundles) {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.goto(base + '/servers/new');
      await page.getByRole('radio', { name: /SMP Survival multiplayer/ }).check();
      await page.waitForFunction(() => document.querySelector('[aria-label="Minecraft version"]')?.textContent.includes('1.21.4'));
      await choose('Minecraft version', '26.3');
      await page.getByRole('button', { name: /Continue/ }).click();
      await page.getByRole('alert').filter({ hasText: /no stable/ }).waitFor();
      assert.equal((await page.getByRole('button', { name: 'Bundle-compatible Minecraft version' }).textContent()).includes('Choose'), true);
      await choose('Bundle-compatible Minecraft version', '1.21.4');
      await page.getByText('2 verified downloads', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Remove LuckPerms', exact: true }).click();
      await page.getByRole('textbox', { name: 'Search template add-ons' }).fill('LuckPerms');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByText('2 verified downloads', { exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Server name' }).fill('Browser bundled SMP');
      await page.getByRole('button', { name: 'Review server' }).click();
      await page.getByText('2 verified downloads', { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
      const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/servers' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Create server', exact: true }).click();
      const result = await creating; assert.equal(result.status(), 202); const server = (await result.json()).server;
      assert.ok(result.request().postDataJSON().templatePlanId);
      await page.waitForURL('**/servers/' + server.id);
      const end = Date.now() + 15000;
      while ((await request('/servers/' + server.id + '/template-installation')).body.installation.state === 'running') {
        if (Date.now() > end) throw new Error('UI bundle never installed'); await new Promise(resolve => setTimeout(resolve, 100));
      }
      const installed = (await request('/servers/' + server.id + '/addons')).body;
      assert.equal(installed.plugins.length, 2);
      await page.getByRole('link', { name: 'Plugins', exact: true }).click();
      await page.locator('.addon-installed-row').filter({ hasText: 'EssentialsX.jar' }).waitFor();
      assert.deepEqual(errors, []);
      console.log('PASS browser bundle version adaptation, explicit-version preservation, editable catalogue selection and tracked installations');
    }
  }
} finally {
  await browser?.close();
  await stop();
  assert.equal(path.dirname(root), temporary);
  assert.ok(path.basename(root).startsWith('nodepilot-templates-api-'));
  await rm(root, { recursive: true, force: true });
}
