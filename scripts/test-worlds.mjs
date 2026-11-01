// Run after npm run build. Uses intercepted APIs and temporary browser sessions;
// no user world, game process, configuration, or backup is changed.
import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? 'playwright');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
const fixture = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = pathname.startsWith('/assets/') || pathname === '/update-recovery.js' ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html');
  if (!target.startsWith(dist) || !existsSync(target)) return response.writeHead(404).end();
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(response);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + fixture.address().port;
const serverId = '22222222-3333-4444-5555-666666666666';
const serverPath = '/api/servers/' + serverId;
const worldPath = serverPath + '/worlds';
const stamp = '2026-11-01T17:00:00.000Z';
let browser;

async function run(name, action, options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1486, height: 1000 }, acceptDownloads: true });
  const calls = [];
  const gameServer = { id: serverId, name: 'World test server', software: options.bedrock ? 'bedrock' : 'paper', flavor: 'paper', version: '26.3', status: options.running ? 'running' : 'offline', port: 25565, memoryMb: 2048, installState: 'ready', directory: 'world-test' };
  const capabilities = { canMutate: !options.running && !options.bedrock, reason: options.running ? 'Stop the server before editing worlds.' : null, presets: [{ id: options.legacy ? 'default' : 'minecraft:normal', name: 'Normal' }, { id: options.legacy ? 'flat' : 'minecraft:flat', name: 'Superflat' }] };
  const worlds = [
    { id: 'world-a', deleted: false, name: 'Survival home', folder: 'world', active: true, state: 'generated', layout: 'modern-paper', seed: '9223372036854775807', minecraftVersion: '26.3', dataVersion: 5000, difficulty: 'normal', hardcore: false, dimensions: ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'], sizeBytes: 12345678, lastSavedAt: stamp, revision: 'revision-a', readOnlyReason: null },
    { id: 'world-b', deleted: false, name: 'Creative build', folder: 'build', active: false, state: 'generated', layout: 'legacy-paper', seed: '-9223372036854775808', minecraftVersion: '1.21.4', dataVersion: 4000, difficulty: 'peaceful', hardcore: false, dimensions: ['minecraft:overworld'], sizeBytes: 9000, lastSavedAt: stamp, revision: 'revision-b', readOnlyReason: null },
  ];
  const details = new Map();
  function makeDetails(world) {
    return {
      world,
      generation: { seed: '', preset: 'minecraft:normal', generatorSettings: '{}', structures: true, hardcore: false, difficulty: world.difficulty ?? 'normal', enabledPacks: ['vanilla'], disabledPacks: ['file/welcome.zip'] },
      gameRules: [{ id: 'minecraft:keep_inventory', label: 'Keep inventory', type: 'boolean', value: false, editable: true }, { id: 'minecraft:random_tick_speed', label: 'Random tick speed', type: 'integer', value: 3, minimum: 0, maximum: 2147483647, editable: true }, { id: 'mod:unknown', label: 'Unknown mod rule', type: 'unknown', value: 'custom', editable: false }],
      features: ['minecraft:vanilla'],
      datapacks: [
        { id: 'vanilla', name: 'Vanilla', description: 'Required base game', enabled: true, compatible: true, managed: true, generationPack: false, reason: 'Provided by Minecraft', removable: false },
        { id: 'file/welcome.zip', name: 'Welcome pack', description: 'A compatible uploaded pack', enabled: false, compatible: true, managed: false, generationPack: false, reason: null, removable: true },
        { id: 'file/broken.zip', name: 'Older pack', description: 'Wrong format', enabled: false, compatible: false, managed: false, generationPack: false, reason: 'Pack format is incompatible.', removable: true },
        ...(options.builtin ? [{ id: 'trade_rebalance', name: 'Trade rebalance', description: 'Verified built-in experiment', enabled: false, compatible: true, managed: false, generationPack: true, reason: 'Creation-time choice from the installed runtime', removable: false }] : []),
      ],
      backups: [{ id: 'backup-one', worldId: world.id, name: 'Before change', createdAt: stamp, sizeBytes: 111111 }],
      capabilities, warnings: [], metadataSource: options.running ? 'last-saved' : 'saved',
    };
  }
  worlds.forEach(world => details.set(world.id, makeDetails(world)));
  let operation;
  let operationCount = 0;
  let completeOperation;
  const state = { stale: options.stale ?? false };
  const operations = new Map();
  function list() { return { supported: !options.bedrock, unsupportedReason: options.bedrock ? 'World management is currently available for Minecraft Java. Bedrock support is not available yet.' : null, activeWorldId: worlds.find(world => world.active)?.id ?? null, worlds, capabilities, operation: operation ?? null, warnings: [], revision: 'library-revision' }; }
  function job(kind, worldId, complete, result) {
    operation = { id: 'operation-' + ++operationCount, serverId, worldId, kind, state: 'running', phase: 'backing_up', processedBytes: 50, totalBytes: 100, error: null, result, createdAt: stamp, updatedAt: stamp };
    completeOperation = complete;
    operations.set(operation.id, operation);
    return { operation };
  }
  try {
    await context.addInitScript(() => localStorage.setItem('nodepilot_pin', 'world-test-pin'));
    await context.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let body = {};
      if (pathname.startsWith(worldPath)) {
        let posted;
        try { posted = request.postDataJSON(); } catch { posted = request.postDataBuffer()?.toString('utf8'); }
        calls.push({ path: pathname, method, body: posted, headers: request.headers() });
        assert.equal(request.headers()['x-nodepilot-pin'], 'world-test-pin');
        if (options.missingApi) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found', message: 'The requested API resource was not found.' }) });
        if (pathname.endsWith('/download')) {
          assert.equal(new URL(request.url()).search, '');
          return route.fulfill({ contentType: 'application/zip', headers: { 'content-disposition': 'attachment; filename="survival-home.zip"' }, body: Buffer.from('test zip download') });
        }
        if (pathname.startsWith(worldPath + '/operations/')) {
          const found = operations.get(pathname.split('/').at(-1));
          assert.ok(found);
          if (found.state === 'running') {
            if (!options.jobFailure) completeOperation?.();
            completeOperation = undefined;
            found.state = options.jobFailure ? 'failed' : 'succeeded';
            found.error = options.jobFailure ? 'Not enough space for a safe world backup.' : null;
            found.phase = found.state;
            found.processedBytes = 100;
          }
          body = found;
        } else if (pathname === worldPath && method === 'GET') body = list();
        else if (pathname === worldPath && method === 'POST') {
          assert.equal(posted.revision, 'library-revision');
          body = job('prepare', 'world-new', () => {
            const world = { ...worlds[0], id: 'world-new', name: posted.name, folder: 'np-world-new', active: true, state: 'prepared', seed: null, minecraftVersion: null, dataVersion: null, sizeBytes: 0, lastSavedAt: null, dimensions: [], revision: 'revision-new' };
            worlds.forEach(value => { value.active = false; }); worlds.push(world);
            const detail = makeDetails(world); detail.generation = posted; detail.gameRules = []; detail.features = []; detail.metadataSource = 'not-generated'; details.set(world.id, detail);
          }, { worldId: 'world-new' });
        } else if (pathname === worldPath + '/import/inspect') {
          assert.match(posted, /filename="existing-world.zip"/);
          body = job('inspect', null, undefined, { inspection: { id: 'inspection-one', candidates: [{ id: 'candidate-one', name: 'Imported adventure', layout: 'modern-java', minecraftVersion: null, seed: '12345', dimensions: ['minecraft:overworld'], warnings: ['Minecraft version could not be detected.'] }], fileCount: 5, totalBytes: 800, warnings: [] } });
        } else if (pathname === worldPath + '/import') {
          assert.equal(posted.inspectionId, 'inspection-one'); assert.equal(posted.candidateId, 'candidate-one'); assert.equal(posted.confirmCompatibility, true);
          body = job('import', 'world-imported', () => { const world = { ...worlds[1], id: 'world-imported', name: posted.name, folder: 'np-imported', revision: 'imported-revision' }; worlds.push(world); details.set(world.id, makeDetails(world)); }, { worldId: 'world-imported' });
        } else {
          const worldId = pathname.slice(worldPath.length + 1).split('/')[0];
          const detail = details.get(worldId);
          assert.ok(detail, 'Unknown world endpoint ' + pathname);
          if (method === 'GET') body = detail;
          else if (state.stale && method === 'PATCH' && pathname === worldPath + '/' + worldId) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale_world', message: 'The saved world changed since it was opened.' }) });
          else if (pathname.endsWith('/activate')) body = job('activate', worldId, () => { assert.equal(posted.confirmCompatibility, true); worlds.forEach(value => { value.active = value.id === worldId; }); }, { worldId });
          else if (pathname.endsWith('/gamerules')) body = job('rules', worldId, () => { detail.gameRules.forEach(rule => { if (rule.id in posted.rules) rule.value = posted.rules[rule.id]; }); }, { worldId });
          else if (pathname.endsWith('/export')) body = job('export', worldId, undefined, { downloadUrl: worldPath + '/operations/operation-' + (operationCount + 1) + '/download' });
          else if (pathname.endsWith('/restore')) body = job('restore', worldId, () => { detail.world.deleted = false; detail.world.state = 'generated'; detail.world.readOnlyReason = null; }, { worldId });
          else if (pathname.endsWith('/backups')) body = job('backup', worldId, () => { detail.backups.push({ id: 'backup-new', worldId, name: 'Manual world backup', createdAt: stamp, sizeBytes: 222222 }); }, { worldId, backupId: 'backup-new' });
          else if (pathname.endsWith('/datapacks') && method === 'PATCH') body = job('datapacks', worldId, () => { detail.datapacks.forEach(pack => { pack.enabled = posted.enabled.includes(pack.id); }); }, { worldId });
          else if (pathname.endsWith('/datapacks') && method === 'POST') { assert.match(posted, /name="revision"/); assert.match(posted, /filename="new-pack.zip"/); body = job('datapack-upload', worldId, undefined, { worldId }); }
          else if (pathname.includes('/datapacks/') && method === 'DELETE') body = job('datapack-remove', worldId, undefined, { worldId });
          else if (pathname === worldPath + '/' + worldId && method === 'PATCH') body = job('settings', worldId, () => { detail.world.name = posted.name; detail.world.difficulty = posted.difficulty; detail.world.hardcore = posted.hardcore; }, { worldId });
          else if (pathname === worldPath + '/' + worldId && method === 'DELETE') body = job('delete', worldId, () => { assert.equal(posted.confirmName, detail.world.name); detail.world.deleted = true; detail.world.state = 'missing'; detail.world.readOnlyReason = 'World files are absent; a retained backup can be restored.'; }, { worldId });
          else throw new Error('Unhandled endpoint ' + method + ' ' + pathname);
        }
      } else if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
      else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, isNetworkVisible: false, addresses: [], accessUrls: [], hasPin: false };
      else if (pathname === '/api/host/updates') body = { update: { status: 'idle', currentVersion: 'test' } };
      else if (pathname === '/api/servers') body = { servers: [gameServer] };
      else if (pathname === serverPath) body = { server: gameServer };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl + '/servers/' + serverId + '/worlds');
    const panel = page.locator('.worlds-panel');
    await panel.waitFor();
    await action({ page, panel, calls, state });
    assert.deepEqual(errors, []);
    console.log('PASS ' + name);
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  await run('real-shaped metadata preserves 64-bit seeds, dimensions, rules and pack capabilities', async ({ panel }) => {
    await panel.getByText('9223372036854775807', { exact: true }).waitFor();
    await panel.getByText('minecraft:the_nether', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Delete world', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('checkbox', { name: 'Enable Vanilla', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('checkbox', { name: 'Enable Older pack', exact: true }).isDisabled(), true);
  });
  await run('preparation preserves old world and waits for the next normal server start', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
    await dialog.getByLabel('World name', { exact: true }).fill('Fresh adventure');
    await dialog.getByLabel('Seed', { exact: true }).fill('-9223372036854775808');
    await dialog.getByText('Advanced generator settings', { exact: true }).click();
    await dialog.getByLabel('Generator JSON', { exact: true }).fill('[]');
    await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Generator settings must be a valid JSON object.' }).waitFor();
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    await dialog.getByLabel('Generator JSON', { exact: true }).fill('{}');
    await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
    await panel.getByText('Game rules become available after Minecraft generates this world and the server is stopped.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: /Survival home\s*Saved world/ }).count(), 1);
    const posted = calls.find(call => call.method === 'POST' && call.path === worldPath).body;
    assert.equal(posted.name, 'Fresh adventure'); assert.equal(posted.seed, '-9223372036854775808'); assert.equal(posted.structures, true); assert.equal(posted.hardcore, false);
    assert.equal(calls.some(call => /\/(start|restart)$/.test(call.path)), false);
  });
  await run('switching requires confirmation and sends the selected saved-world revision', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: /Creative build\s*Saved world/ }).click();
    await panel.getByText('-9223372036854775808', { exact: true }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Use on next start', exact: true }).click();
    await panel.locator('.world-current h3').filter({ hasText: 'Creative build' }).waitFor();
    assert.deepEqual(calls.find(call => call.path.endsWith('/activate')).body, { revision: 'revision-b', confirmCompatibility: true });
  });
  await run('new-world datapacks come from the primary world while another world is viewed', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: /Creative build\s*Saved world/ }).click();
    await panel.getByText('-9223372036854775808', { exact: true }).waitFor();
    const reads = calls.filter(call => call.method === 'GET' && call.path === worldPath + '/world-a').length;
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
    await dialog.getByRole('checkbox', { name: 'Welcome pack', exact: true }).check();
    assert.equal(calls.filter(call => call.method === 'GET' && call.path === worldPath + '/world-a').length, reads + 1);
  });
  await run('legacy Minecraft preparation defaults to the backend-supported normal preset', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
    await dialog.getByLabel('World name', { exact: true }).fill('Legacy terrain');
    await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(calls.find(call => call.method === 'POST' && call.path === worldPath).body.preset, 'default');
  }, { legacy: true });
  await run('verified built-in experiments are creation choices and locked on generated worlds', async ({ page, panel, calls }) => {
    assert.equal(await panel.getByRole('checkbox', { name: 'Enable Trade rebalance', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: 'Remove Trade rebalance', exact: true }).count(), 0);
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
    await dialog.getByRole('checkbox', { name: 'Trade rebalance', exact: true }).check();
    await dialog.getByLabel('World name', { exact: true }).fill('Experimental world');
    await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(calls.find(call => call.method === 'POST' && call.path === worldPath).body.enabledPacks, ['vanilla', 'trade_rebalance']);
  }, { builtin: true });
  await run('game-rule editing searches and submits typed values with a revision', async ({ panel, calls }) => {
    await panel.getByRole('searchbox', { name: 'Search game rules' }).fill('inventory');
    await panel.getByRole('switch', { name: 'Keep inventory', exact: true }).check();
    await panel.getByRole('searchbox', { name: 'Search game rules' }).fill('');
    await panel.getByRole('spinbutton', { name: 'Random tick speed', exact: true }).fill('7');
    await panel.getByRole('button', { name: 'Save game rules', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).waitFor();
    assert.deepEqual(calls.find(call => call.path.endsWith('/gamerules')).body, { revision: 'revision-a', rules: { 'minecraft:keep_inventory': true, 'minecraft:random_tick_speed': 7 } });
  });
  await run('datapack choices and ZIP uploads use the selected world and revision', async ({ panel, calls }) => {
    await panel.getByRole('checkbox', { name: 'Enable Welcome pack', exact: true }).check();
    await panel.getByRole('button', { name: 'Save datapack selection', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).waitFor();
    assert.deepEqual(calls.find(call => call.method === 'PATCH' && call.path.endsWith('/datapacks')).body.enabled, ['vanilla', 'file/welcome.zip']);
    await panel.getByLabel('Datapack ZIP file', { exact: true }).setInputFiles({ name: 'new-pack.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP fixture') });
    await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).waitFor();
    assert.ok(calls.some(call => call.method === 'POST' && call.path.endsWith('/datapacks')));
  });
  await run('ZIP import previews uncertain metadata and requires compatibility confirmation', async ({ page, panel, calls }) => {
    await panel.getByLabel('World ZIP file', { exact: true }).setInputFiles({ name: 'existing-world.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP fixture') });
    const dialog = page.getByRole('dialog', { name: 'Import a saved world', exact: true });
    await dialog.waitFor();
    await dialog.getByText('Minecraft version could not be detected.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Import world', exact: true }).isDisabled(), true);
    await dialog.getByRole('checkbox', { name: /I reviewed Minecraft version and mod compatibility/ }).check();
    await dialog.getByRole('button', { name: 'Import world', exact: true }).click();
    await panel.getByRole('button', { name: /Imported adventure\s*Saved world/ }).waitFor();
    assert.equal(calls.find(call => call.path === worldPath + '/import').body.confirmCompatibility, true);
  });
  await run('export downloads authenticate with a header without exposing the PIN in a URL', async ({ page, panel, calls }) => {
    const downloaded = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download ZIP', exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'survival-home.zip');
    assert.ok(calls.some(call => call.path.endsWith('/download') && call.headers['x-nodepilot-pin'] === 'world-test-pin'));
  });
  await run('deletion requires the exact name and retains a recoverable backup entry', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: /Creative build\s*Saved world/ }).click();
    await panel.getByText('-9223372036854775808', { exact: true }).waitFor();
    page.once('dialog', dialog => dialog.accept('wrong name'));
    await panel.getByRole('button', { name: 'Delete world', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'The world name did not match.' }).waitFor();
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
    page.once('dialog', dialog => dialog.accept('Creative build'));
    await panel.getByRole('button', { name: 'Delete world', exact: true }).click();
    await panel.getByText('The world files were deleted. Restore a retained backup below to recover this world.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Restore backup', exact: true }).isEnabled(), true);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await panel.getByRole('button', { name: 'Download ZIP', exact: true }).waitFor({ state: 'visible' });
    await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).waitFor();
  });
  await run('stale saves preserve draft fields and report the conflict', async ({ panel }) => {
    await panel.getByLabel('Display name', { exact: true }).fill('My unsaved name');
    await panel.getByRole('button', { name: 'Save world settings', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'Your unsaved fields are still here.' }).waitFor();
    assert.equal(await panel.getByLabel('Display name', { exact: true }).inputValue(), 'My unsaved name');
  }, { stale: true });
  await run('running servers expose last-saved data and disable every file mutation', async ({ panel }) => {
    await panel.getByText('LAST SAVED STATE', { exact: true }).waitFor();
    for (const label of ['Prepare new world', 'Upload world ZIP', 'Download ZIP', 'Create world backup', 'Save world settings']) assert.equal(await panel.getByRole('button', { name: label, exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('switch', { name: 'Keep inventory', exact: true }).isDisabled(), true);
  }, { running: true });
  await run('Bedrock clearly explains unsupported world management', async ({ panel }) => {
    await panel.getByText('World management is currently available for Minecraft Java. Bedrock support is not available yet.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Prepare new world', exact: true }).isDisabled(), true);
  }, { bedrock: true });
  await run('a failed operation reports recovery information without announcing success', async ({ panel }) => {
    await panel.getByRole('button', { name: 'Create world backup', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'Not enough space for a safe world backup.' }).waitFor();
    assert.equal(await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Create world backup', exact: true }).isEnabled(), true);
  }, { jobFailure: true });
  await run('a failed background preparation retains its modal and draft fields', async ({ page, panel }) => {
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
    await dialog.getByLabel('World name', { exact: true }).fill('Keep my draft');
    await dialog.getByLabel('Seed', { exact: true }).fill('1234');
    await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Not enough space for a safe world backup.' }).waitFor();
    assert.equal(await dialog.getByLabel('World name', { exact: true }).inputValue(), 'Keep my draft');
    assert.equal(await dialog.getByLabel('Seed', { exact: true }).inputValue(), '1234');
    assert.equal(await dialog.getByRole('button', { name: 'Prepare world', exact: true }).isEnabled(), true);
  }, { jobFailure: true });
  await run('mobile world controls and the preparation dialog fit a 390px viewport', async ({ page, panel }) => {
    await panel.getByText('9223372036854775807', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }, { mobile: true });
  await run('missing backend routes explain the required update and restart', async ({ panel }) => {
    await panel.getByRole('alert').filter({ hasText: 'The running NodePilot backend does not have the Worlds API.' }).waitFor();
  }, { missingApi: true });
} finally {
  await browser?.close();
  await new Promise(resolve => fixture.close(resolve));
}
