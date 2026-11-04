// UI regression tests with intercepted fixture APIs. No actual server, add-on,
// user configuration or backup is changed; backend integration is tested separately.
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
const addonPath = serverPath + '/addons';
const stamp = '2026-11-03T17:00:00.000Z';
let browser;

async function run(name, action, options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1486, height: 1000 } });
  const calls = [];
  const addonType = options.mods || options.unsupported ? 'mod' : 'plugin';
  const gameServer = { id: serverId, name: 'Add-on queue fixture', software: options.mods || options.unsupported ? 'fabric' : 'paper', flavor: 'paper', version: '1.21.4', status: options.status ?? 'running', port: 25565, memoryMb: 2048, installState: 'ready', directory: 'addon-fixture' };
  const installed = [{ type: addonType, fileName: 'Example-1.0.jar', size: 5000, modifiedAt: stamp, source: 'modrinth', projectId: 'example-project', versionId: 'v1', metadata: { name: 'Example add-on', version: '1.0' }, compatible: true }];
  const pending = options.pending ? [{ id: 'pending-initial', serverId, type: addonType, fileName: 'Queued.jar', action: 'install', name: 'Previously queued', source: 'upload', createdAt: stamp }] : [];
  const state = { apply: false, fail: options.fail ?? false, pendingError: options.pendingError ?? null, cancelFail: options.cancelFail ?? false };
  const result = { source: 'modrinth', projectId: 'new-project', title: 'New catalogue add-on', description: 'Compatible fixture project', versions: ['1.21.4'], compatible: true, url: 'https://modrinth.com/project/new-project' };
  let count = 0;
  function listing() {
    if (state.apply) { pending.splice(0); installed[0].metadata.version = '2.0'; installed[0].fileName = 'Example-2.0.jar'; }
    const stable = ['running', 'offline', 'stopped', 'error'].includes(gameServer.status);
    return { plugins: addonType === 'mod' ? [] : installed, mods: addonType === 'mod' ? installed : [], pendingChanges: pending, pendingError: state.pendingError,
      capabilities: { plugins: !options.mods && !options.unsupported, mods: Boolean(options.mods && !options.unsupported), pluginMessage: 'This software cannot load Bukkit plugins.', modMessage: 'This software cannot load loader mods.', canMutate: stable && !options.maintenance, mutationMessage: options.maintenance ? 'World maintenance is in progress.' : stable ? undefined : 'Wait until the server finishes changing state.' } };
  }
  function save(action, filename, projectId, originalFileName) {
    const change = { id: 'pending-' + ++count, serverId, type: addonType, fileName: filename, originalFileName, action, name: projectId === 'new-project' ? result.title : filename, version: action === 'update' ? '2.0' : undefined, source: projectId ? 'modrinth' : 'upload', projectId, createdAt: stamp };
    const queued = gameServer.status === 'running' || pending.length > 0 || options.applyFail;
    if (queued) pending.push(change);
    else if (action === 'install') installed.push({ type: addonType, fileName: filename, size: 5000, modifiedAt: stamp, source: 'modrinth', metadata: { name: result.title, version: '1.0' }, compatible: true });
    return { queued, pendingChange: queued ? change : undefined, restartRequired: true };
  }
  try {
    await context.addInitScript(() => localStorage.setItem('nodepilot_pin', 'addon-fixture-pin'));
    await context.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let body = {};
      if (pathname.startsWith(addonPath)) {
        let posted;
        try { posted = request.postDataJSON(); } catch { posted = request.postDataBuffer()?.toString('utf8'); }
        calls.push({ pathname, method, body: posted });
        assert.equal(request.headers()['x-nodepilot-pin'], 'addon-fixture-pin');
        if (pathname === addonPath && method === 'GET') body = listing();
        else if (pathname.endsWith('/search')) body = { results: [result] };
        else if (pathname.endsWith('/updates')) body = { updates: [{ type: addonType, fileName: 'Example-1.0.jar', source: 'modrinth', projectId: 'example-project', available: true, versionName: '2.0' }] };
        else if (pathname.includes('/pending/') && method === 'DELETE') {
          assert.equal(posted.confirm, true);
          if (state.cancelFail) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'recovery_required', message: 'Finish recovery before cancelling this change.' }) });
          const index = pending.findIndex(change => change.id === pathname.split('/').at(-1));
          assert.ok(index >= 0); pending.splice(index, 1); body = { ok: true };
        } else if (options.applyFail && pathname.endsWith('/modrinth')) {
          // A stopped-server mutation can save the queue successfully, then fail
          // while applying it. Its error response must still trigger a fresh list.
          save('install', 'New-addon.jar', posted.projectId);
          state.pendingError = 'The add-on could not be applied. The original JARs were restored.';
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'addon_pending_failed', message: state.pendingError }) });
        } else if (state.fail) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'addon_incompatible', message: 'The queued add-on is incompatible.' }) });
        else if (pathname.endsWith('/modrinth')) { assert.equal(posted.type, addonType); body = save('install', 'New-addon.jar', posted.projectId); }
        else if (pathname.endsWith('/upload')) { assert.match(posted, /filename="Uploaded.jar"/); assert.equal(new URL(request.url()).searchParams.get('type'), addonType); body = save('install', 'Uploaded.jar'); }
        else if (pathname.endsWith('/update')) { assert.equal(posted.fileName, 'Example-1.0.jar'); body = save('update', 'Example-2.0.jar', 'example-project', posted.fileName); }
        else if (method === 'DELETE') { assert.equal(posted.confirm, true); body = save('remove', decodeURIComponent(pathname.split('/').at(-1)), 'example-project'); }
        else throw new Error('Unhandled add-on fixture endpoint ' + method + ' ' + pathname);
      } else if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
      else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, isNetworkVisible: false, addresses: [], accessUrls: [], hasPin: false };
      else if (pathname === '/api/host/updates') body = { update: { status: 'idle', currentVersion: 'fixture' } };
      else if (pathname === '/api/servers') body = { servers: [gameServer] };
      else if (pathname === serverPath) body = { server: gameServer };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl + '/servers/' + serverId + '/addons');
    const panel = page.locator('.addons-panel');
    await panel.waitFor();
    await panel.getByRole('heading', { name: options.mods || options.unsupported ? 'Mods' : 'Plugins', exact: true }).waitFor();
    await panel.locator('.addon-installed-row').first().waitFor();
    await action({ page, panel, calls, state, installed, pending, gameServer });
    assert.deepEqual(errors, []);
    console.log('PASS ' + name);
  } finally { await context.close(); }
}

async function search(panel) {
  await panel.getByRole('textbox', { name: 'Search add-ons' }).fill('fixture');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  await run('running catalogue installs queue separately from current disk versions and can be cancelled', async ({ panel, calls }) => {
    assert.equal(await panel.getByRole('button', { name: 'Upload plugin JAR' }).isEnabled(), true);
    await search(panel);
    await panel.getByRole('button', { name: 'Queue install', exact: true }).click();
    await panel.getByRole('heading', { name: /Pending changes/ }).waitFor();
    await panel.getByRole('status').filter({ hasText: 'Current JAR files have not changed.' }).waitFor();
    assert.equal(await panel.locator('.addon-installed-row').count(), 1);
    assert.match(await panel.locator('.addon-installed-row').innerText(), /v1\.0/);
    assert.equal(await panel.getByRole('button', { name: 'Queued', exact: true }).isDisabled(), true);
    await panel.getByRole('button', { name: 'Cancel queued install of New catalogue add-on' }).click();
    await panel.locator('.addon-pending-card').waitFor({ state: 'hidden' });
    assert.equal(calls.filter(call => call.method === 'DELETE' && call.pathname.includes('/pending/')).length, 1);
    assert.equal(await panel.locator('.addon-installed-row').count(), 1);
  });
  await run('running loader mods accept a queued upload without changing installed mods', async ({ panel, calls }) => {
    assert.equal(await panel.getByRole('button', { name: 'Upload mod JAR' }).isEnabled(), true);
    await panel.getByLabel('Mod JAR file').setInputFiles({ name: 'Uploaded.jar', mimeType: 'application/java-archive', buffer: Buffer.from('fixture bytes intercepted by mock API') });
    await panel.locator('.addon-pending-row').waitFor();
    assert.match(await panel.locator('.addon-pending-row').innerText(), /Install queued.*Mod/s);
    assert.equal(await panel.locator('.addon-installed-row').count(), 1);
    assert.equal(calls.some(call => call.method === 'POST' && call.pathname.endsWith('/upload')), true);
  }, { mods: true });
  await run('removal confirmation schedules the next start and preserves the current installed row', async ({ page, panel, calls }) => {
    const removal = panel.getByRole('button', { name: 'Remove Example-1.0.jar', exact: true });
    page.once('dialog', dialog => { assert.match(dialog.message(), /next server start or restart/); return dialog.dismiss(); });
    await removal.click();
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
    page.once('dialog', dialog => dialog.accept());
    await removal.click();
    await panel.locator('.addon-pending-row').waitFor();
    assert.match(await panel.locator('.addon-installed-row').innerText(), /Removal queued/);
    assert.equal(await removal.isDisabled(), true);
    await panel.getByRole('button', { name: /Cancel queued removal/ }).click();
    await panel.locator('.addon-pending-card').waitFor({ state: 'hidden' });
    assert.equal(await removal.isEnabled(), true);
  });
  await run('renamed updates show the queued replacement while keeping the installed version visible', async ({ page, panel }) => {
    await panel.getByRole('button', { name: 'Check updates', exact: true }).click();
    page.once('dialog', dialog => { assert.match(dialog.message(), /current JAR stays in place/); return dialog.accept(); });
    await panel.getByRole('button', { name: 'Queue update', exact: true }).click();
    await panel.locator('.addon-pending-row').waitFor();
    assert.match(await panel.locator('.addon-pending-row').innerText(), /Example-1\.0\.jar → Example-2\.0\.jar/);
    assert.match(await panel.locator('.addon-installed-row').innerText(), /v1\.0/);
    assert.match(await panel.locator('.addon-installed-row').innerText(), /Update queued/);
  });
  await run('a stopped server with no queue preserves immediate installation behavior', async ({ panel }) => {
    await search(panel); await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'was installed on disk' }).waitFor();
    assert.equal(await panel.locator('.addon-pending-card').count(), 0);
    assert.equal(await panel.locator('.addon-installed-row').count(), 2);
  }, { status: 'offline' });
  await run('a stopped server with an existing queue keeps further changes deferred', async ({ panel }) => {
    await panel.getByText('These changes are saved for the next start.', { exact: false }).waitFor();
    await search(panel); await panel.getByRole('button', { name: 'Queue install', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Current JAR files have not changed.' }).waitFor();
    assert.equal(await panel.locator('.addon-pending-row').count(), 2);
    assert.equal(await panel.locator('.addon-installed-row').count(), 1);
  }, { status: 'offline', pending: true });
  for (const status of ['starting', 'stopping', 'installing']) await run(status + ' blocks mutations with a reason', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Upload plugin JAR' }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: 'Remove Example-1.0.jar' }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: /Cancel queued install/ }).isDisabled(), true);
    await panel.getByText('Wait until the server finishes changing state.', { exact: true }).waitFor();
  }, { status, pending: true });
  await run('maintenance and pending-application errors remain explicit', async ({ panel }) => {
    await panel.getByText('World maintenance is in progress.', { exact: true }).waitFor();
    await panel.getByText('A queued file changed after upload. Review the pending change.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Upload plugin JAR' }).isDisabled(), true);
  }, { maintenance: true, pending: true, pendingError: 'A queued file changed after upload. Review the pending change.' });
  await run('unavailable backend capabilities disable installation but allow cancellation of old changes', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Upload mod JAR' }).isDisabled(), true);
    await panel.getByRole('button', { name: /Cancel queued install/ }).click();
    await panel.locator('.addon-pending-card').waitFor({ state: 'hidden' });
  }, { unsupported: true, pending: true });
  await run('a rejected queued install shows the real backend error without a success claim', async ({ panel }) => {
    await search(panel); await panel.getByRole('button', { name: 'Queue install', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'The queued add-on is incompatible.' }).waitFor();
    assert.equal(await panel.locator('.addon-pending-card').count(), 0);
    assert.equal(await panel.getByRole('status').count(), 0);
  }, { fail: true });
  await run('failed immediate application refreshes and displays its saved queue without waiting for polling', async ({ panel }) => {
    await search(panel); await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await panel.locator('.addon-pending-row').waitFor({ timeout: 2_000 });
    await panel.locator('.addon-pending-error').filter({ hasText: 'The original JARs were restored.' }).waitFor();
    assert.equal(await panel.getByRole('status').count(), 0);
    assert.equal(await panel.locator('.addon-installed-row').count(), 1);
  }, { status: 'offline', applyFail: true });
  await run('a rejected cancellation keeps the queue and its error visible', async ({ panel }) => {
    await panel.getByRole('button', { name: /Cancel queued install/ }).click();
    await panel.getByRole('alert').filter({ hasText: 'Finish recovery before cancelling this change.' }).waitFor();
    assert.equal(await panel.locator('.addon-pending-row').count(), 1);
  }, { pending: true, cancelFail: true });
  await run('polling reflects a queue applied by a simulated restart', async ({ panel, state }) => {
    await panel.locator('.addon-pending-row').waitFor(); state.apply = true;
    await panel.locator('.addon-pending-card').waitFor({ state: 'hidden', timeout: 10_000 });
    assert.match(await panel.locator('.addon-installed-row').innerText(), /v2\.0/);
  }, { pending: true });
  await run('pending controls and installed rows fit a 390px mobile viewport', async ({ page, panel }) => {
    await panel.locator('.addon-pending-row').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.NODEPILOT_ADDON_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.NODEPILOT_ADDON_SCREENSHOT), fullPage: true });
  }, { pending: true, mobile: true });
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
