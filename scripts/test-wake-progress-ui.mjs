// Run after npm run build -w client. Only fixture APIs are used; no real server,
// settings or player data is changed. Backend protocol tests run separately.
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
    ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html');
  if (!target.startsWith(dist) || !existsSync(target)) return response.writeHead(404).end();
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] ?? 'application/octet-stream');
  createReadStream(target).on('error', () => response.destroy()).pipe(response);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));

const id = '22222222-3333-4444-5555-666666666666';
const server = { id, name: 'Wake fixture', software: 'paper', version: '1.21.4', status: 'offline', port: 25565, memoryMb: 2048, installState: 'ready' };
const settings = { autoWake: true, wakeProxyPort: 35565, autoSleep: false, idleTimeoutMinutes: 15, minMemoryMb: null, maxMemoryMb: 2048, customJvmArgs: [], autoStart: 'disabled', shutdownTimeoutSeconds: 20 };
const startup = { stage: 'Preparing spawn area', percent: 42, isReady: false };
const runtime = { isRunning: false, isBedrock: false, status: 'offline', port: 25565, availableJava: [], wakeProxy: { status: 'active', wakePort: 35565, minecraftPort: 25565, starting: false, startup, playerNotice: 'Startup notice fixture' }, autoSleep: { enabled: false }, playit: { installed: true, isRunning: true, secretExists: true }, tunnel: null };
let reads = 0;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
    else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, addresses: [], accessUrls: [], hasPin: false };
    else if (pathname === '/api/servers') body = { servers: [server] };
    else if (pathname === '/api/servers/' + id) body = { server };
    else if (pathname === '/api/servers/' + id + '/settings') {
      assert.equal(route.request().method(), 'GET', 'Polling must not save the user\'s unsaved form edits.');
      reads++;
      body = { settings, runtime };
    } else if (pathname === '/api/host/updates') body = { update: { status: 'idle', currentVersion: 'fixture' } };
    else if (pathname.includes('/java/')) body = { versions: [21] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + fixture.address().port + '/servers/' + id + '/settings');
  const panel = page.locator('.server-settings-container');
  await panel.waitFor();
  await panel.locator('#custom-wake-port').fill('35566');
  assert.equal(await panel.getByRole('progressbar').count(), 0);

  // The server starts externally while this tab remains open on a stopped server.
  runtime.wakeProxy.starting = true;
  await panel.getByRole('progressbar', { name: 'Preparing spawn area' }).waitFor({ timeout: 12_000 });
  assert.equal(await panel.getByRole('progressbar').getAttribute('aria-valuenow'), '42');
  assert.equal(await panel.locator('#custom-wake-port').inputValue(), '35566');
  startup.percent = 71;
  await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '71');
  startup.percent = null;
  startup.stage = 'Loading worlds';
  await panel.getByRole('progressbar').waitFor({ state: 'hidden' });
  await panel.getByText('Minecraft has not reported a percentage for this stage.', { exact: true }).waitFor();
  assert.equal(await panel.locator('#custom-wake-port').inputValue(), '35566');
  await panel.getByText('Refresh the Minecraft multiplayer server list', { exact: false }).waitFor();
  assert.ok(reads >= 3);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS Auto-Wake panel polls while stopped, shows real stage percentage, updates/removes percentage, preserves unsaved edits, and fits 390px mobile viewport.');
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => fixture.close(resolve));
}
