import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BROWSER_AUTH_JAR_BASE64, BROWSER_AUTH_JAR_SHA256 } from '../services/browser-auth-artifact.js';
import { browserJavaDependencies, cloudflaredDependency, type BrowserDependency } from '../services/browser-dependency-manifest.js';
import { BrowserDependencyService } from '../services/browser-dependencies.js';

const payload = Buffer.from('a verified fixture dependency');
const fixture: BrowserDependency = {
  id: 'fixture', version: '1', fileName: 'fixture.jar',
  url: 'https://github.com/example/releases/download/1/fixture.jar',
  sha256: createHash('sha256').update(payload).digest('hex'),
};

test('browser dependency pins identify official immutable assets and the bundled companion passes integrity', () => {
  for (const dependency of browserJavaDependencies) {
    assert.match(dependency.sha256, /^[a-f0-9]{64}$/);
    assert.ok(dependency.url.startsWith('https://github.com/') || dependency.url.startsWith('https://fill-data.papermc.io/'));
    assert.ok(!dependency.url.includes('/latest/'));
  }
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    assert.ok(cloudflaredDependency(platform, arch));
  }
  assert.equal(cloudflaredDependency('win32', 'arm64'), null);
  assert.equal(createHash('sha256').update(Buffer.from(BROWSER_AUTH_JAR_BASE64, 'base64')).digest('hex'), BROWSER_AUTH_JAR_SHA256);
});

test('verified downloads are atomic and reused while a checksum mismatch preserves existing bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-browser-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new BrowserDependencyService(root) as unknown as { download(dependency: BrowserDependency, target: string): Promise<void> };
  const target = path.join(root, 'fixture.jar');
  let response = payload;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(response));
  await service.download(fixture, target);
  assert.deepEqual(await readFile(target), payload);
  await service.download(fixture, target);
  assert.equal(fetchMock.mock.callCount(), 1);
  await writeFile(target, 'keep the old file');
  response = Buffer.from('corrupt download');
  await assert.rejects(service.download(fixture, target), /SHA-256/);
  assert.equal(await readFile(target, 'utf8'), 'keep the old file');
  assert.deepEqual(await readdir(root), ['fixture.jar']);
});

test('an official download HTTP failure leaves no partial artifact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-browser-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new BrowserDependencyService(root) as unknown as { download(dependency: BrowserDependency, target: string): Promise<void> };
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(service.download(fixture, path.join(root, 'fixture.jar')), /HTTP 503/);
  assert.deepEqual(await readdir(root), []);
});

test('dependency installation rejects invalid identities and linked managed directories before network access', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-browser-deps-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-browser-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network should not be reached'); });
  const service = new BrowserDependencyService(root);
  await assert.rejects(service.install('../unsafe'), /identity/);
  await symlink(outside, path.join(root, 'browser-access'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.install('11111111-2222-4333-8444-555555555555'), /filesystem link/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('shutdown cancels the active install and prevents subsequent component downloads', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-browser-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let started!: () => void;
  const fetched = new Promise<void>((resolve) => { started = resolve; });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    started();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const service = new BrowserDependencyService(root);
  const install = service.install('11111111-2222-4333-8444-555555555555');
  await fetched;
  service.cancelAll();
  await assert.rejects(install, /cancelled/);
  await assert.rejects(service.install('22222222-3333-4333-8444-555555555555'), /cancelled/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual((await readdir(path.join(root, 'browser-access', '11111111-2222-4333-8444-555555555555'))).sort(), ['backend', 'plugins']);
});
