// Called only by test-worlds-api.mjs against its temporary installation.
// This suite uses the actual compiled client and backend, without API interception.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export async function testWorldsBrowser({ baseUrl, serverId, pin, originalWorldId }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? 'playwright');
  const screenshotDirectory = process.env.NODEPILOT_WORLDS_SCREENSHOT_DIR
    ? path.resolve(process.env.NODEPILOT_WORLDS_SCREENSHOT_DIR)
    : await mkdtemp(path.join(os.tmpdir(), 'nodepilot-worlds-browser-'));
  await mkdir(screenshotDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE } : {}) });
  const errors = [];
  async function session(viewport) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(value => localStorage.setItem('nodepilot_pin', value), pin);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl + '/servers/' + serverId + '/worlds');
    const panel = page.locator('.worlds-panel');
    await panel.waitFor();
    return { context, page, panel };
  }
  const api = async target => {
    const response = await fetch(baseUrl + '/api/servers/' + serverId + '/worlds' + target, { headers: { 'x-nodepilot-pin': pin } });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const desktop = await session({ width: 1486, height: 1080 });
    try {
      const { page, panel } = desktop;
      await panel.getByText('-9223372036854775808', { exact: true }).waitFor();
      await panel.getByText('minecraft:the_nether', { exact: true }).waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Delete world', exact: true }).isDisabled(), true);
      await page.screenshot({ path: path.join(screenshotDirectory, 'worlds-desktop.png'), fullPage: true });

      const saved = await api('/' + originalWorldId);
      const keepInventory = saved.gameRules.find(rule => rule.id === 'keepInventory');
      assert.ok(keepInventory?.editable);
      await panel.getByRole('searchbox', { name: 'Search game rules' }).fill('inventory');
      await panel.getByRole('switch', { name: keepInventory.label, exact: true }).setChecked(!keepInventory.value);
      const savedResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/gamerules'));
      await panel.getByRole('button', { name: 'Save game rules', exact: true }).click();
      assert.equal((await savedResponse).status(), 202);
      await panel.getByRole('status').filter({ hasText: 'World operation completed.' }).waitFor();
      assert.equal((await api('/' + originalWorldId)).gameRules.find(rule => rule.id === 'keepInventory').value, !keepInventory.value);
      console.log('PASS real browser reads exact seed and persists a game-rule change through the compiled API');

      await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Prepare a new world', exact: true });
      await dialog.getByLabel('World name', { exact: true }).fill('Browser prepared world');
      await dialog.getByLabel('Seed', { exact: true }).fill('9223372036854775807');
      const preparedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/worlds'));
      await dialog.getByRole('button', { name: 'Prepare world', exact: true }).click();
      assert.equal((await preparedResponse).status(), 202);
      await panel.getByText('Game rules become available after Minecraft generates this world and the server is stopped.', { exact: true }).waitFor();
      await dialog.waitFor({ state: 'hidden' });
      const listing = await api('');
      const prepared = listing.worlds.find(world => world.name === 'Browser prepared world');
      assert.ok(prepared); assert.equal(prepared.state, 'prepared'); assert.equal(prepared.active, true);
      assert.equal(listing.worlds.find(world => world.id === originalWorldId).deleted, false);
      assert.equal((await api('/' + prepared.id)).generation.seed, '9223372036854775807');
      const response = await fetch(baseUrl + '/api/servers/' + serverId, { headers: { 'x-nodepilot-pin': pin } });
      assert.equal((await response.json()).server.status, 'stopped');
      console.log('PASS real browser preparation selects a world while leaving Minecraft stopped and the previous world saved');
    } finally { await desktop.context.close(); }

    const mobile = await session({ width: 390, height: 844 });
    try {
      const { page, panel } = mobile;
      await panel.getByText('Game rules become available after Minecraft generates this world and the server is stopped.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(screenshotDirectory, 'worlds-mobile.png'), fullPage: true });
      await panel.getByRole('button', { name: 'Prepare new world', exact: true }).click();
      await page.getByRole('dialog', { name: 'Prepare a new world', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.world-modal-backdrop').evaluate(element => element.getBoundingClientRect().height === innerHeight), true);
      await page.screenshot({ path: path.join(screenshotDirectory, 'worlds-mobile-dialog.png') });
      console.log('PASS real backend desktop and 390px mobile Worlds flows render without horizontal overflow');
    } finally { await mobile.context.close(); }
    assert.deepEqual(errors, []);
    console.log('Worlds browser screenshots: ' + screenshotDirectory);
  } finally { await browser.close(); }
}
