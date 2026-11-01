// Run after npm run build. API traffic is intercepted: no real game server,
// setting, backup, or installation is changed. Playwright can be supplied using
// NODEPILOT_PLAYWRIGHT_MODULE and NODEPILOT_CHROMIUM_EXECUTABLE.
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
  const target = pathname.startsWith('/assets/') || pathname === '/update-recovery.js'
    ? path.resolve(dist, '.' + pathname)
    : path.join(dist, 'index.html');
  if (!target.startsWith(dist) || !existsSync(target)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + fixture.address().port;
const serverId = '22222222-3333-4444-5555-666666666666';
const serverPath = '/api/servers/' + serverId;
let browser;

async function run(name, action, options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  const calls = [];
  let gameServer = {
    id: serverId, name: 'Version test', software: 'paper', flavor: 'paper',
    version: '1.21.4', status: options.running ? 'running' : 'offline', port: 25565,
    memoryMb: 2048, installState: 'ready', directory: 'version-test',
  };
  let status = {
    serverId, currentVersion: gameServer.version, software: 'paper',
    versions: [{ id: '1.21.5', type: 'release', available: true }, { id: '1.21.4', type: 'release', available: true }],
    latestVersion: '1.21.5', updateAvailable: true, autoUpdate: false,
    lastCheckedAt: '2026-10-30T12:00:00.000Z', lastError: null, lastBackupPath: null,
    busy: false, phase: null, automaticUpdateBlockedReason: null, warnings: [],
    supported: true, unsupportedReason: null,
  };
  const state = { missingApi: Boolean(options.missingApi), serverNotFound: Boolean(options.serverNotFound), metadataError: Boolean(options.metadataError) };
  try {
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let body = {};
      if (pathname.startsWith(serverPath + '/versions')) {
        calls.push({ path: pathname, method, body: request.postDataJSON() });
        if (state.missingApi || state.serverNotFound) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(state.serverNotFound
            ? { error: 'server_not_found', message: 'The server does not exist.' }
            : { error: 'not_found', message: 'The requested API resource was not found.' }) });
          return;
        }
        if (pathname === serverPath + '/versions/preferences') {
          assert.equal(method, 'PUT');
          status = { ...status, autoUpdate: request.postDataJSON().autoUpdate };
        } else if (pathname === serverPath + '/versions/install') {
          assert.equal(method, 'POST');
          const input = request.postDataJSON();
          assert.deepEqual(input, { version: '1.21.5', confirm: true });
          gameServer = { ...gameServer, version: input.version };
          status = { ...status, currentVersion: input.version, updateAvailable: false, lastBackupPath: 'C:\\NodePilot\\backups\\version-test-minecraft-test' };
          body = { server: gameServer, status };
        } else if (pathname === serverPath + '/versions/check') {
          assert.equal(method, 'POST');
        } else assert.equal(method, 'GET');
        if (state.metadataError) status = { ...status, lastError: 'Publisher metadata is temporarily unavailable.', versions: [], latestVersion: null };
        if (pathname !== serverPath + '/versions/install') body = status;
      } else if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
      else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, isNetworkVisible: false, addresses: [], accessUrls: [], hasPin: false };
      else if (pathname === '/api/host/updates') body = { update: { status: 'idle', currentVersion: 'test' } };
      else if (pathname === '/api/servers') body = { servers: [gameServer] };
      else if (pathname === serverPath) body = { server: gameServer };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl + '/servers/' + serverId + '/versions');
    const panel = page.locator('.versions-panel');
    await panel.waitFor();
    await action({ page, panel, calls, state });
    assert.deepEqual(errors, []);
    console.log('PASS ' + name);
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  await run('metadata, manual check, auto-update preference, confirmed installation, and backup display', async ({ page, panel, calls }) => {
    await panel.getByText('1.21.4', { exact: true }).waitFor();
    await panel.getByText('1.21.5', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Check for updates' }).click();
    await panel.getByText('Minecraft 1.21.5 is available for this server.', { exact: true }).waitFor();
    await panel.getByRole('switch', { name: 'Automatic Minecraft updates' }).click();
    await panel.getByText('Enabled', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('switch').isChecked(), true);
    await panel.getByRole('button', { name: 'Minecraft version', exact: true }).click();
    await panel.getByRole('option', { name: '1.21.5 · Latest stable', exact: true }).click();
    let confirmed = false;
    page.once('dialog', async (dialog) => {
      assert.match(dialog.message(), /back up the complete server/);
      confirmed = true;
      await dialog.accept();
    });
    await panel.getByRole('button', { name: 'Back up & install', exact: true }).click();
    await panel.getByText('Minecraft 1.21.5 is installed. The server remains stopped; review your add-ons before starting it.', { exact: true }).waitFor();
    await panel.getByText('C:\\NodePilot\\backups\\version-test-minecraft-test', { exact: true }).waitFor();
    assert.equal(confirmed, true);
    assert.equal(calls.filter((call) => call.path.endsWith('/check')).length, 1);
    assert.deepEqual(calls.find((call) => call.path.endsWith('/preferences'))?.body, { autoUpdate: true });
    assert.equal(calls.filter((call) => call.path.endsWith('/install')).length, 1);
  });
  await run('running server blocks manual installation while allowing opt-in auto updates', async ({ panel }) => {
    await panel.getByText('Stop the server before changing its Minecraft version. Automatic updates also wait until it is stopped.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Minecraft version', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: 'Back up & install', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('switch').isEnabled(), true);
  }, { running: true });
  await run('old backend explains restart requirement and recovers after checking again', async ({ panel, state }) => {
    await panel.getByRole('alert').filter({ hasText: 'The running NodePilot backend does not have the Versions API.' }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Back up & install', exact: true }).isDisabled(), true);
    state.missingApi = false;
    await panel.getByRole('button', { name: 'Check for updates' }).click();
    await panel.getByText('Minecraft 1.21.5 is available for this server.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('alert').count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Minecraft version', exact: true }).isEnabled(), true);
  }, { missingApi: true });
  await run('missing server error is not misreported as an old backend', async ({ panel }) => {
    await panel.getByRole('alert').filter({ hasText: 'The server does not exist.' }).waitFor();
    assert.equal(await panel.getByText(/does not have the Versions API/).count(), 0);
  }, { serverNotFound: true });
  await run('failed metadata check reports failure without a success notice', async ({ panel }) => {
    await panel.getByRole('alert').filter({ hasText: 'Publisher metadata is temporarily unavailable.' }).waitFor();
    await panel.getByRole('button', { name: 'Check for updates' }).click();
    await panel.getByRole('button', { name: 'Check for updates' }).waitFor();
    assert.equal(await panel.getByText(/Version metadata was checked/).count(), 0);
  }, { metadataError: true });
  await run('390px viewport keeps version controls within the page', async ({ page, panel }) => {
    await panel.getByRole('switch').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await panel.getByRole('button', { name: 'Minecraft version', exact: true }).click();
    await panel.getByRole('option', { name: '1.21.5 · Latest stable', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }, { mobile: true });
} finally {
  await browser?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
