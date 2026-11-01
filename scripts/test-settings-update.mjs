// Run after npm run build. All API traffic is intercepted; this never changes
// a real NodePilot installation. Playwright may be supplied using the same
// environment overrides as scripts/test-playit-link.mjs.
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
  if (!target.startsWith(dist) || !existsSync(target)) return response.writeHead(404).end();
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + fixture.address().port;
const releaseUrl = 'https://github.com/Koalamedvidekk/NodePilot/releases/tag/v1.3.0';
const sourceReason = 'This is a Git checkout. Use Git to update it so local source changes are never overwritten.';
let browser;

async function run(name, action, options = {}) {
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  const calls = [];
  let update = {
    currentVersion: '1.2.0', isUpdateAvailable: true,
    availableRelease: {
      version: '1.3.0', rawTag: 'v1.3.0', name: 'NodePilot test release',
      publishedAt: '2026-11-01T12:00:00Z', isPrerelease: false, htmlUrl: releaseUrl,
      body: 'Test release', changelog: { features: ['A test release feature'], improvements: [], bugFixes: [], rawNotes: 'Test release' },
    },
    lastCheckedAt: '2026-11-01T12:00:00Z', checkError: null, status: 'idle',
    progressPercent: 0, downloadedBytes: 0, totalBytes: 0, statusMessage: 'Update available.',
    error: null, includePrereleases: false, canAutoInstall: true, unattendedSupported: true,
    dismissedVersion: null, snoozedVersion: '1.3.0', snoozedUntil: '2999-01-01T00:00:00Z',
    autoInstallReason: null, ...options.status,
  };
  try {
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      let body = {};
      if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
      else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, isNetworkVisible: false, addresses: [], accessUrls: [], hasPin: false };
      else if (pathname === '/api/host/settings') body = {
        settings: { systemStartupEnabled: false, launchMode: 'headless', continueRunningOnClose: true },
        startup: { platform: 'win32', isSupported: true, registeredInOs: false },
        playit: { installed: false, isRunning: false, secretExists: false },
        tor: { supported: false, installed: false, autoInstallSupported: false },
        pinConfigured: false,
      };
      else if (pathname === '/api/host/diagnostics') body = { recentLogs: [] };
      else if (pathname === '/api/servers') body = { servers: options.running ? [{ id: 'test', name: 'Running server', status: 'running', software: 'paper', version: '1.21.4', port: 25565, memoryMb: 1024, installState: 'ready' }] : [] };
      else if (pathname === '/api/host/updates') {
        if (options.unavailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: 'Update status unavailable' }) });
        body = { update };
      } else if (pathname === '/api/host/updates/install') {
        calls.push({ pathname, method: request.method() });
        assert.equal(request.method(), 'POST');
        if (options.installFailure) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'update_refused', message: 'The server became active before installation.' }) });
        update = { ...update, status: 'restarting', statusMessage: 'Applying update and restarting.' };
        body = { ok: true, status: 'ready_to_restart', message: 'Applying update and restarting.', update };
      } else if (pathname === '/api/host/updates/check') {
        calls.push({ pathname, method: request.method() });
        assert.equal(request.method(), 'POST');
        body = { update };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl + '/settings');
    const panel = page.locator('.update-settings-card');
    await panel.waitFor();
    await action({ page, context, panel, calls });
    assert.deepEqual(errors, []);
    console.log('PASS ' + name);
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  await run('Settings can install a snoozed update and begin restart recovery', async ({ page, panel, calls }) => {
    assert.equal(await page.getByRole('dialog').count(), 0, 'The global update popup is snoozed');
    let confirmed = false;
    page.once('dialog', async (dialog) => {
      assert.match(dialog.message(), /build the verified release and restart/);
      confirmed = true;
      await dialog.accept();
    });
    await panel.getByRole('button', { name: 'Install & Restart', exact: true }).click();
    await page.getByRole('heading', { name: 'Updating NodePilot', exact: true }).waitFor();
    assert.equal(confirmed, true);
    assert.deepEqual(calls, [{ pathname: '/api/host/updates/install', method: 'POST' }]);
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('nodepilot:update-recovery')).expectedVersion), '1.3.0');
  });
  await run('blocked source checkout keeps the button, reason and working official download link together', async ({ page, panel, calls, context }) => {
    const install = panel.getByRole('button', { name: 'Install & Restart', exact: true });
    assert.equal(await install.isVisible(), true);
    assert.equal(await install.isDisabled(), true);
    assert.equal(await install.getAttribute('aria-describedby'), 'nodepilot-install-update-reason');
    const reason = panel.getByText(sourceReason, { exact: true });
    assert.equal(await reason.isVisible(), true);
    const reasonBounds = await reason.boundingBox();
    const notesBounds = await panel.locator('.update-release-details').boundingBox();
    assert.ok(reasonBounds.y < notesBounds.y, 'Restriction must appear before the release notes');
    await context.route(releaseUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Official release download page test</h1>' }));
    const popupPromise = page.waitForEvent('popup');
    await panel.getByRole('link', { name: 'Open download page', exact: true }).click();
    const popup = await popupPromise;
    await popup.getByRole('heading', { name: 'Official release download page test' }).waitFor();
    assert.equal(popup.url(), releaseUrl);
    assert.equal(calls.length, 0);
  }, { status: { canAutoInstall: false, autoInstallReason: sourceReason } });
  await run('no newer release retains a disabled Up to date button', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Up to date', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('link', { name: 'Open download page' }).count(), 0);
  }, { status: { currentVersion: '1.3.0', isUpdateAvailable: false, canAutoInstall: false } });
  await run('failed or unavailable metadata is never labelled Up to date', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Install & Restart', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: 'Up to date', exact: true }).count(), 0);
  }, { unavailable: true });
  await run('unperformed check requests a check instead of claiming Up to date', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Check for updates first', exact: true }).isDisabled(), true);
  }, { status: { isUpdateAvailable: false, canAutoInstall: false, lastCheckedAt: null, availableRelease: null } });
  await run('running servers prevent installation from Settings', async ({ page, panel, calls }) => {
    await panel.getByRole('button', { name: 'Install & Restart', exact: true }).click();
    await page.getByText('Stop all managed game servers before updating NodePilot.', { exact: true }).waitFor();
    assert.equal(calls.length, 0);
  }, { running: true });
  await run('external preparation disables Settings actions and shows progress', async ({ panel }) => {
    assert.equal(await panel.getByRole('button', { name: 'Preparing Update…', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: 'Check for Updates', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByLabel('Update preparation progress').isVisible(), true);
  }, { status: { status: 'downloading', progressPercent: 40 } });
  await run('a refused installation reports its error and enables retry', async ({ page, panel, calls }) => {
    page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: 'Install & Restart', exact: true }).click();
    await page.getByText('The server became active before installation.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Install & Restart', exact: true }).isEnabled(), true);
    assert.equal(calls.length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('nodepilot:update-recovery')), null);
  }, { installFailure: true });
} finally {
  await browser?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
