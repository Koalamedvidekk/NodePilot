// Run after npm run build. Uses Playwright without contacting a real NodePilot
// instance or applying an update. Optional bundled-runtime overrides match
// scripts/test-playit-link.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? 'playwright');
const html = readFileSync(fileURLToPath(new URL('../client/dist/index.html', import.meta.url)), 'utf8');
const recovery = readFileSync(fileURLToPath(new URL('../client/dist/update-recovery.js', import.meta.url)), 'utf8');
const fixtureHtml = html.replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/, '<script type="module">document.getElementById("root").textContent = "Test panel loaded";</script>');
assert.notEqual(fixtureHtml, html, 'Expected a compiled main module in client/dist/index.html');
const fixture = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/update-recovery.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }).end(recovery);
  } else if (url.pathname.startsWith('/assets/')) response.writeHead(404).end('Missing test asset');
  else response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(url.searchParams.has('broken') ? html : fixtureHtml);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + fixture.address().port;
const key = 'nodepilot:update-recovery';
let browser;

async function run(name, action) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await action(page, context);
    console.log('PASS ' + name);
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}),
  });
  await run('healthy app hides bootstrap fallback', async (page) => {
    await page.goto(baseUrl);
    await page.getByText('Test panel loaded', { exact: true }).waitFor();
    assert.equal(await page.locator('#nodepilot-bootstrap').isVisible(), false);
  });
  await run('missing application chunk shows a usable recovery screen', async (page) => {
    await page.goto(baseUrl + '/?broken=1');
    await page.getByRole('heading', { name: 'The NodePilot panel could not load' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry loading panel' }).isVisible(), true);
    assert.equal(page.url(), baseUrl + '/?broken=1', 'A missing asset must not cause an automatic reload loop');
  });
  await run('offline backend reconnects to target version using PIN header', async (page) => {
    let requests = 0;
    await page.addInitScript(() => localStorage.setItem('nodepilot_pin', 'test-only-pin'));
    await page.route('**/api/host/updates', (route) => {
      assert.equal(route.request().headers()['x-nodepilot-pin'], 'test-only-pin');
      assert.equal(new URL(route.request().url()).search, '', 'The PIN must not appear in a URL');
      requests += 1;
      if (requests === 1) return route.abort('connectionrefused');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ update: { currentVersion: '0.1.10', status: 'idle' } }) });
    });
    await page.goto(baseUrl);
    await page.evaluate(() => window.nodePilotUpdateRecovery.begin('0.1.10'));
    await page.getByRole('heading', { name: 'NodePilot is restarting' }).waitFor();
    await page.waitForURL(/_nodepilot_reload=/);
    assert.equal(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key), null);
    assert.ok(requests >= 2);
  });
  await run('rollback is detected instead of endlessly waiting for target', async (page) => {
    let requests = 0;
    await page.route('**/api/host/updates', (route) => {
      requests += 1;
      if (requests === 1) return route.abort('connectionrefused');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ update: { currentVersion: '0.1.9', status: 'idle' } }) });
    });
    await page.goto(baseUrl);
    await page.evaluate(() => window.nodePilotUpdateRecovery.begin('0.1.10'));
    await page.getByRole('heading', { name: 'NodePilot returned to the previous version' }).waitFor();
    assert.equal(page.url(), baseUrl + '/');
    await page.getByRole('button', { name: 'Open previous version' }).click();
    await page.waitForURL(/_nodepilot_reload=/);
    assert.equal(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key), null);
  });
  await run('updater failure stays visible with recovery instructions', async (page) => {
    await page.route('**/api/host/updates', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ update: { currentVersion: '0.1.9', status: 'error', error: 'Dependency installation failed.' } }) }));
    await page.goto(baseUrl);
    await page.evaluate(() => window.nodePilotUpdateRecovery.begin('0.1.10'));
    await page.getByRole('heading', { name: 'NodePilot update did not finish' }).waitFor();
    await page.getByText('Dependency installation failed.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Check again' }).isEnabled(), true);
    assert.equal(page.url(), baseUrl + '/');
  });
  await run('three-minute timeout is bounded and Retry resumes checking', async (page) => {
    await page.clock.install();
    await page.route('**/api/host/updates', (route) => route.abort('connectionrefused'));
    await page.goto(baseUrl);
    await page.evaluate(() => window.nodePilotUpdateRecovery.begin('0.1.10'));
    await page.getByRole('heading', { name: 'NodePilot is restarting' }).waitFor();
    await page.clock.fastForward(180001);
    await page.getByRole('heading', { name: 'NodePilot has not returned yet' }).waitFor();
    assert.equal(page.url(), baseUrl + '/');
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('heading', { name: 'NodePilot is restarting' }).waitFor();
  });
  await run('stored recovery attempt resumes after a browser refresh', async (page) => {
    await page.addInitScript((storageKey) => sessionStorage.setItem(storageKey, JSON.stringify({ expectedVersion: '0.1.10', startedAt: Date.now() - 180001, sawOffline: true })), key);
    await page.goto(baseUrl);
    await page.getByRole('heading', { name: 'NodePilot has not returned yet' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Check again' }).isVisible(), true);
  });
} finally {
  await browser?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
