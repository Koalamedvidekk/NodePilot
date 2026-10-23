import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const manifestScript = fileURLToPath(new URL('../../scripts/create-release-manifest.mjs', import.meta.url));
const linuxUpdaterScript = fileURLToPath(new URL('../../scripts/apply-update.sh', import.meta.url));

async function writeReleaseFixture(root: string, includeLinuxUpdater = true): Promise<void> {
  await mkdir(path.join(root, 'server'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"nodepilot"}\n');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(root, 'server', 'index.ts'), 'export {};\n');
  await writeFile(path.join(root, 'scripts', 'bootstrap.ps1'), 'exit 0\n');
  await writeFile(path.join(root, 'scripts', 'bootstrap.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'scripts', 'apply-update.ps1'), 'exit 0\n');
  await writeFile(path.join(root, 'start.bat'), '@echo off\r\nexit /b 0\r\n');
  await writeFile(path.join(root, 'start.sh'), '#!/bin/sh\nexit 0\n');
  if (includeLinuxUpdater) {
    await writeFile(path.join(root, 'scripts', 'apply-update.sh'), '#!/bin/sh\nexit 0\n');
  }
}

test('release manifest generator lists the complete verified package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-release-manifest-'));
  try {
    await writeReleaseFixture(root);
    const result = spawnSync(process.execPath, [manifestScript, root, '1.2.3'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(await readFile(path.join(root, 'nodepilot-release.json'), 'utf8')) as {
      schemaVersion: number;
      version: string;
      files: string[];
    };
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.version, '1.2.3');
    assert.deepEqual(manifest.files, [...manifest.files].sort((left, right) => left.localeCompare(right, 'en')));
    assert.ok(manifest.files.includes('scripts/apply-update.sh'));
    assert.ok(manifest.files.includes('scripts/apply-update.ps1'));
    assert.ok(!manifest.files.includes('nodepilot-release.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release manifest generator refuses an incomplete updater package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-release-manifest-'));
  try {
    await writeReleaseFixture(root, false);
    const result = spawnSync(process.execPath, [manifestScript, root, '1.2.3'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/apply-update\.sh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release manifest generator refuses nested protected configuration files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-release-manifest-'));
  try {
    await writeReleaseFixture(root);
    await writeFile(path.join(root, 'server', '.env'), 'NODEPILOT_PIN=keep-private\n');
    const result = spawnSync(process.execPath, [manifestScript, root, '1.2.3'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /protected path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux update helper preserves protected data and applies a verified staged package', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-linux-updater-'));
  const target = path.join(root, 'application');
  const updateRoot = path.join(root, 'updates');
  const staged = path.join(updateRoot, 'staged', 'fixture');
  const backup = path.join(updateRoot, 'backups', 'fixture');
  const packageJson = JSON.stringify({
    name: 'nodepilot-update-fixture',
    scripts: {
      build: "node -e \"const fs=require('node:fs');fs.mkdirSync('server/dist',{recursive:true});fs.mkdirSync('client/dist',{recursive:true});fs.writeFileSync('server/dist/index.js','ok');fs.writeFileSync('client/dist/index.html','ok')\"",
    },
  });

  try {
    await writeReleaseFixture(staged);
    await copyFile(linuxUpdaterScript, path.join(staged, 'scripts', 'apply-update.sh'));
    await writeFile(path.join(staged, 'package.json'), packageJson);
    await writeFile(path.join(staged, 'server', 'index.ts'), 'export const version = "new";\n');
    assert.equal(spawnSync(process.execPath, [manifestScript, staged, '1.2.3'], { encoding: 'utf8' }).status, 0);

    await mkdir(path.join(target, 'server'), { recursive: true });
    await mkdir(path.join(target, 'node_modules'), { recursive: true });
    await mkdir(path.join(target, '.nodepilot'), { recursive: true });
    await writeFile(path.join(target, 'package.json'), packageJson);
    await writeFile(path.join(target, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await writeFile(path.join(target, 'server', 'index.ts'), 'export const version = "old";\n');
    await writeFile(path.join(target, '.nodepilot', 'preserved.txt'), 'keep');

    const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
    assert.ok(exitedPid);
    const result = spawnSync('/bin/sh', [linuxUpdaterScript,
      '--parent-pid', String(exitedPid),
      '--staged-dir', staged,
      '--target-dir', target,
      '--update-root', updateRoot,
      '--backup-dir', backup,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(target, 'server', 'index.ts'), 'utf8'), 'export const version = "new";\n');
    assert.equal(await readFile(path.join(target, '.nodepilot', 'preserved.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(target, 'server', 'dist', 'index.js'), 'utf8'), 'ok');
    assert.equal(await readFile(path.join(target, 'client', 'dist', 'index.html'), 'utf8'), 'ok');
    assert.equal(await readFile(path.join(backup, 'application', 'server', 'index.ts'), 'utf8'), 'export const version = "old";\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
