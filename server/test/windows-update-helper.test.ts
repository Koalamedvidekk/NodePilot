import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../../scripts/apply-update.ps1', import.meta.url));
const manifestScript = fileURLToPath(new URL('../../scripts/create-release-manifest.mjs', import.meta.url));

async function releaseFixture(root: string, version: string): Promise<void> {
  await mkdir(path.join(root, 'server'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'nodepilot-fixture', version }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'nodepilot-fixture', version, lockfileVersion: 3 }));
  await writeFile(path.join(root, 'server', 'index.ts'), `export const version = '${version}';\n`);
  await writeFile(path.join(root, 'scripts', 'bootstrap.ps1'), 'exit 0\n');
  await writeFile(path.join(root, 'scripts', 'bootstrap.sh'), '#!/bin/sh\nexit 0\n');
  await copyFile(helperPath, path.join(root, 'scripts', 'apply-update.ps1'));
  await writeFile(path.join(root, 'scripts', 'apply-update.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'start.bat'), `@echo off\r\necho ${version}> "%~dp0relaunch-marker.txt"\r\nexit /b 0\r\n`);
  await writeFile(path.join(root, 'start.sh'), '#!/bin/sh\nexit 0\n');
  const manifest = spawnSync(process.execPath, [manifestScript, root, version], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-windows-update-'));
  const target = path.join(root, 'application with spaces');
  const updateRoot = path.join(target, '.nodepilot', 'updates');
  const staged = path.join(updateRoot, 'staged', 'fixture');
  const backup = path.join(updateRoot, 'backups', 'fixture');
  const fakeBin = path.join(root, 'fake-bin');
  const npmLog = path.join(root, 'npm.log');
  const readyFile = path.join(updateRoot, 'helper-ready.json');
  await releaseFixture(target, '1.0.0');
  await releaseFixture(staged, '1.1.0');

  // These files are generated after extracting a release and are deliberately
  // absent from the old manifest. They must not invalidate an installed release.
  await mkdir(path.join(target, 'server', 'dist'), { recursive: true });
  await mkdir(path.join(target, 'client', 'dist'), { recursive: true });
  await mkdir(path.join(target, 'node_modules'), { recursive: true });
  await writeFile(path.join(target, 'server', 'dist', 'index.js'), 'old server build');
  await writeFile(path.join(target, 'client', 'dist', 'index.html'), 'old client build');
  await writeFile(path.join(target, 'client', 'tsconfig.tsbuildinfo'), 'generated');
  await writeFile(path.join(target, '.env'), 'NODEPILOT_PIN=keep-root-private\n');
  await writeFile(path.join(target, 'server', '.env'), 'NODEPILOT_DATA_DIR=keep-nested-private\n');
  await writeFile(path.join(target, '.nodepilot', 'server-data.txt'), 'keep world data');
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'npm.cmd'), [
    '@echo off',
    'echo npm %*>> "%NODEPILOT_TEST_NPM_LOG%"',
    'if "%1"=="ci" goto success',
    'if "%NODEPILOT_TEST_BUILD_FAIL%"=="1" goto failure',
    'if not exist server\\dist mkdir server\\dist',
    'if not exist client\\dist mkdir client\\dist',
    'echo new server build> server\\dist\\index.js',
    'echo new client build> client\\dist\\index.html',
    'echo.',
    'echo fixture build succeeded',
    'echo.',
    ':success',
    'exit /b 0',
    ':failure',
    'echo fixture build failed 1>&2',
    'exit /b 17',
    '',
  ].join('\r\n'));

  const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(exitedPid);
  const invoke = (buildFails = false) => spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-ParentPid', String(exitedPid), '-StagedDir', staged, '-TargetDir', target,
    '-UpdateRoot', updateRoot, '-BackupDir', backup, '-ReadyFile', readyFile,
  ], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: {
      ...process.env,
      PATH: fakeBin + path.delimiter + process.env.PATH,
      NODEPILOT_TEST_NPM_LOG: npmLog,
      NODEPILOT_TEST_BUILD_FAIL: buildFails ? '1' : '0',
    },
  });
  const cleanup = async () => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(absolute, { recursive: true, force: true });
  };
  return { root, target, staged, backup, updateRoot, npmLog, readyFile, invoke, cleanup };
}

async function relaunchMarker(target: string): Promise<string> {
  const marker = path.join(target, 'relaunch-marker.txt');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await readFile(marker, 'utf8').catch(() => undefined);
    if (value) return value.trim();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The fixture launcher was not invoked.');
}

async function assertProtectedFiles(target: string): Promise<void> {
  assert.equal(await readFile(path.join(target, '.env'), 'utf8'), 'NODEPILOT_PIN=keep-root-private\n');
  assert.equal(await readFile(path.join(target, 'server', '.env'), 'utf8'), 'NODEPILOT_DATA_DIR=keep-nested-private\n');
  assert.equal(await readFile(path.join(target, '.nodepilot', 'server-data.txt'), 'utf8'), 'keep world data');
}

test('Windows updater accepts generated files in the previous install, applies a strict staged release, and relaunches', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const result = f.invoke();
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    assert.equal(await relaunchMarker(f.target), '1.1.0');
    assert.match(await readFile(path.join(f.target, 'server', 'index.ts'), 'utf8'), /1\.1\.0/);
    assert.match(await readFile(path.join(f.target, 'server', 'dist', 'index.js'), 'utf8'), /new server build/);
    assert.match(await readFile(path.join(f.backup, 'application', 'server', 'index.ts'), 'utf8'), /1\.0\.0/);
    assert.match(await readFile(f.npmLog, 'utf8'), /npm ci --include=dev/);
    assert.match(await readFile(path.join(f.updateRoot, 'update.log'), 'utf8'), /fixture build succeeded/);
    assert.equal(JSON.parse(await readFile(f.readyFile, 'utf8')).ready, true);
    await assertProtectedFiles(f.target);
  } finally {
    await f.cleanup();
  }
});

test('Windows updater restores and relaunches the previous app after a failed build while preserving local data', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const result = f.invoke(true);
    assert.equal(result.status, 1, result.stdout + '\n' + result.stderr);
    assert.equal(await relaunchMarker(f.target), '1.0.0');
    assert.match(await readFile(path.join(f.target, 'server', 'index.ts'), 'utf8'), /1\.0\.0/);
    assert.equal(await readFile(path.join(f.target, 'server', 'dist', 'index.js'), 'utf8'), 'old server build');
    const log = await readFile(path.join(f.updateRoot, 'update.log'), 'utf8');
    assert.match(log, /fixture build failed/);
    assert.match(log, /Update failed/);
    assert.match(log, /Restarting the previous NodePilot/);
    assert.equal((await readFile(f.npmLog, 'utf8')).match(/npm ci --include=dev/g)?.length, 2);
    await assertProtectedFiles(f.target);
  } finally {
    await f.cleanup();
  }
});

test('Windows updater still rejects unlisted files in the new package before acknowledging readiness', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.staged, 'unlisted.txt'), 'unexpected');
    const result = f.invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /unlisted file/);
    await assert.rejects(readFile(f.readyFile, 'utf8'), { code: 'ENOENT' });
    assert.match(await readFile(path.join(f.target, 'server', 'index.ts'), 'utf8'), /1\.0\.0/);
    await assertProtectedFiles(f.target);
  } finally {
    await f.cleanup();
  }
});
