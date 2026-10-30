// Run after npm run build. Requires Playwright, optionally supplied through
// NODEPILOT_PLAYWRIGHT_MODULE and NODEPILOT_CHROMIUM_EXECUTABLE.
// All account/API traffic is intercepted; no real Playit account is changed.
import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? 'playwright');
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
const fixtureServer = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = pathname.startsWith('/assets/')
    ? path.resolve(dist, '.' + pathname)
    : path.join(dist, 'index.html');
  if (!target.startsWith(dist) || !existsSync(target)) {
    response.writeHead(404).end();
    return;
  }
  const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
  response.setHeader('Content-Type', mime[path.extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + fixtureServer.address().port;
let browser;
const serverId = '22222222-3333-4444-5555-666666666666';
const claimUrl = 'https://playit.gg/claim/nodepilottest';
const playit = { installed: true, isManaged: true, version: 'test', isRunning: false, secretExists: false, binaryPath: 'test', secretPath: 'test', claimUrl: null };
const gameServer = { id: serverId, name: 'Test server', software: 'paper', flavor: 'paper', version: '1.21.4', status: 'offline', port: 25565, memoryMb: 2048, installState: 'ready' };
const claimFailure = 'Could not open Playit account linking: the agent could not connect. Try again.';

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}),
  });
  for (const screen of ['host', 'server']) {
    for (const failed of [false, true]) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(() => {
          window.__popupCalls = 0;
          window.open = () => { window.__popupCalls += 1; return null; };
        });
        let claimRequests = 0;
        await context.route('https://playit.gg/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Playit claim test</h1>' }));
        await context.route('**/api/**', async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          let body = {};
          if (pathname === '/api/auth/status') body = { hasPin: false, authenticated: true };
          else if (pathname === '/api/network') body = { host: '127.0.0.1', port: 7420, isNetworkVisible: false, addresses: [], accessUrls: [], hasPin: false };
          else if (pathname === '/api/host/settings') body = {
            settings: { systemStartupEnabled: false, launchMode: 'headless', continueRunningOnClose: true },
            startup: { platform: 'win32', isSupported: true, registeredInOs: false },
            playit,
            tor: { supported: false, installed: false, autoInstallSupported: false },
            pinConfigured: false,
          };
          else if (pathname === '/api/host/diagnostics') body = { recentLogs: [] };
          else if (pathname === '/api/host/updates') body = { update: { status: 'idle', currentVersion: 'test' } };
          else if (pathname === '/api/servers') body = { servers: [] };
          else if (pathname === '/api/servers/' + serverId) body = { server: gameServer };
          else if (pathname === '/api/servers/' + serverId + '/tunnel') body = {
            playit,
            tunnel: { serverId, status: 'connecting', localPort: 25565, publicAddress: null, connectionAddress: null, tunnelId: null },
          };
          else if (pathname === '/api/host/playit') body = { playit };
          else if (pathname === '/api/host/playit/claim') {
            claimRequests += 1;
            assert.equal(route.request().method(), 'POST');
            if (failed) {
              await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'playit_claim_failed', message: claimFailure }) });
              return;
            }
            body = { ok: true, claimUrl, claimCode: 'nodepilottest', playit: { ...playit, isRunning: true, claimUrl } };
          }
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const localPath = screen === 'host' ? '/settings' : '/servers/' + serverId;
        await page.goto(baseUrl + localPath);
        const buttonName = screen === 'host' ? 'Link Account (1-Click)' : 'Link Playit Account (1-Click)';
        await page.getByRole('button', { name: buttonName, exact: true }).click();
        if (failed) {
          await page.getByText(claimFailure, { exact: true }).first().waitFor();
          if (screen === 'host') await page.getByRole('alert').filter({ hasText: claimFailure }).waitFor();
          assert.equal(page.url(), baseUrl + localPath);
          assert.equal(await page.evaluate(() => window.__popupCalls), 0);
          assert.equal(await page.getByRole('button', { name: buttonName, exact: true }).isEnabled(), true);
        } else {
          await page.waitForURL(claimUrl);
          await page.getByRole('heading', { name: 'Playit claim test' }).waitFor();
          assert.equal(context.pages().length, 1);
        }
        assert.equal(claimRequests, 1);
        assert.deepEqual(errors, []);
        console.log('PASS ' + screen + ': ' + (failed ? 'claim failure is visible and retry is enabled' : 'same-tab redirect succeeds with popups blocked'));
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
}
