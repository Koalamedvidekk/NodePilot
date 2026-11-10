import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';

import { PlayitService } from '../services/playit-service.js';

const existingKey = 'abcdef0123456789';
const replacementKey = '0123456789abcdef';
const claimCode = 'abcdef0123';
const claimUrl = `https://playit.gg/claim/${claimCode}`;
const repairedAgent = 'verified legacy agent fixture';
const secretToml = (key: string) => `secret_key = "${key}"\n`;

class FakeAgent extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unref(): void {}

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}

async function fixture(t: TestContext, { incompatible = false, downloadContent = repairedAgent } = {}) {
  const tempDirectory = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempDirectory, 'nodepilot-playit-link-'));
  const secretPath = path.join(root, 'playit.toml');
  const fileName = process.platform === 'win32' ? 'playit.exe' : 'playit';
  const previousPath = path.join(root, 'bin', fileName);
  const managedPath = path.join(root, 'bin', 'playit-v0.17.1', fileName);
  await mkdir(path.dirname(previousPath));
  await writeFile(previousPath, 'previous managed agent fixture');
  const service = new PlayitService(root);
  const binaryProbe = service as unknown as {
    getBinaryInfo(path: string): Promise<{ version: string | null; legacy: boolean }>;
  };
  t.mock.method(service, 'getSecretPath', () => secretPath);
  t.mock.method(service, 'isProcessRunning', async () => false);
  const stop = t.mock.method(service, 'stopAgent', async () => { throw new Error('Unexpected global agent stop'); });
  t.mock.method(binaryProbe, 'getBinaryInfo', async (file: string) => {
    if (!existsSync(file)) return { version: null, legacy: false };
    const legacy = file !== previousPath || !incompatible;
    return { version: legacy ? '0.17.1' : '2.0.2', legacy };
  });
  const downloadUrl = 'https://github.com/playit-cloud/playit-agent/releases/download/v0.17.1/test-agent';
  t.mock.method(service, 'getDownloadUrl', () => ({
    url: downloadUrl,
    fileName,
    sha256: createHash('sha256').update(repairedAgent).digest('hex'),
  }));
  const download = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, downloadUrl);
    return new Response(downloadContent);
  });

  const agents = new EventEmitter();
  const spawn = t.mock.method(childProcess, 'spawn', (file: string, args: string[]) => {
    assert.equal(file, incompatible ? managedPath : previousPath);
    assert.ok(existsSync(file));
    const child = new FakeAgent();
    agents.emit('spawn', { child, args });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();

  t.after(async () => {
    try {
      await service.cancelPendingClaim();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(path.dirname(root), tempDirectory);
      assert.ok(path.basename(root).startsWith('nodepilot-playit-link-'));
      await rm(root, { recursive: true, force: true });
    }
  });

  async function beginClaim() {
    const launched = new Promise<{ child: FakeAgent; args: string[] }>((resolve) => agents.once('spawn', resolve));
    const linking = service.claimAccount();
    const agent = await Promise.race([
      launched,
      linking.then(() => { throw new Error('Expected a claim agent to launch'); }),
    ]);
    return { ...agent, linking };
  }

  return { service, secretPath, managedPath, download, spawn, stop, beginClaim };
}

test('linking repairs an incompatible managed agent and promotes a completed staged claim', { timeout: 10_000 }, async (t) => {
  const { service, secretPath, managedPath, download, spawn, stop, beginClaim } = await fixture(t, { incompatible: true });
  await writeFile(secretPath, secretToml(existingKey));

  const { child, args, linking } = await beginClaim();
  assert.equal(download.mock.callCount(), 1);
  assert.equal(await readFile(managedPath, 'utf8'), repairedAgent);
  assert.equal(stop.mock.callCount(), 0);
  const stagedPath = args[1];
  assert.deepEqual(args, ['--secret_path', stagedPath, '--stdout']);
  assert.ok(stagedPath);
  assert.notEqual(stagedPath, secretPath);
  child.stdout.write(`Open ${claimUrl.slice(0, -4)}`);
  child.stdout.write(`${claimUrl.slice(-4)}\r\n`);
  assert.deepEqual(await linking, { claimUrl, claimCode });
  assert.equal((await service.getStatus()).claimUrl, claimUrl);
  assert.equal((await service.startAgent()).claimUrl, claimUrl);
  assert.deepEqual(await service.claimAccount(), { claimUrl, claimCode });
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(child.killed, false);
  assert.equal(await readFile(secretPath, 'utf8'), secretToml(existingKey));

  await writeFile(stagedPath, secretToml(replacementKey));
  const status = await service.getStatus();
  assert.equal(status.secretExists, true);
  assert.equal(status.claimUrl, null);
  assert.equal(service.readSecretKey(), replacementKey);
  child.finish(0);
});

test('an agent that exits during relinking clears the stale URL and preserves the existing credential', { timeout: 10_000 }, async (t) => {
  const { service, secretPath, beginClaim } = await fixture(t);
  await writeFile(secretPath, secretToml(existingKey));

  const { child, linking } = await beginClaim();
  child.stderr.write(`${claimUrl}\n`);
  await linking;
  child.finish(1);

  const status = await service.getStatus();
  assert.equal(status.claimUrl, null);
  assert.match(status.claimError ?? '', /exit|closed|stopped/i);
  assert.equal(status.secretExists, true);
  assert.equal(await readFile(secretPath, 'utf8'), secretToml(existingKey));

  const retry = await beginClaim();
  retry.child.stderr.write('error: unexpected argument\n');
  retry.child.finish(2);
  await assert.rejects(retry.linking, /rejected the linking command/i);
  assert.equal(await readFile(secretPath, 'utf8'), secretToml(existingKey));
});

test('an unverified repair never replaces the credential or launches the download', { timeout: 10_000 }, async (t) => {
  const { service, secretPath, managedPath, spawn } = await fixture(t, { incompatible: true, downloadContent: 'corrupt agent' });
  await writeFile(secretPath, secretToml(existingKey));

  await assert.rejects(service.claimAccount(), /SHA-256 checksum/);
  assert.equal(existsSync(managedPath), false);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(await readFile(secretPath, 'utf8'), secretToml(existingKey));
});

test('starting without a parsed credential fails before launching Playit', { timeout: 10_000 }, async (t) => {
  const { service, secretPath, spawn } = await fixture(t);
  await writeFile(secretPath, `# ${secretToml(existingKey)}`);

  assert.equal((await service.getStatus()).secretExists, false);
  await assert.rejects(service.startAgent(), /link|secret key|credential/i);
  assert.equal(spawn.mock.callCount(), 0);
});
