import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { managedServerDirectoryExists, resolveInside, resolveManagedServerRoot, safeDirectoryName } from '../lib/paths.js';

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'nodepilot-paths-'));
}

test('resolveInside permits contained relative files and rejects traversal', async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(path.join(root, 'configs'));
    await writeFile(path.join(root, 'configs', 'server.properties'), 'motd=Test\n');
    const resolved = await resolveInside(root, 'configs/server.properties');
    assert.equal(resolved, path.join(root, 'configs', 'server.properties'));

    await assert.rejects(() => resolveInside(root, '../outside.txt'), { code: 'invalid_path' });
    await assert.rejects(() => resolveInside(root, 'C:/Windows/win.ini'), { code: 'invalid_path' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveInside rejects a symlink that escapes a server directory', async (context) => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  try {
    await writeFile(path.join(outside, 'private.txt'), 'not part of server');
    try {
      await symlink(outside, path.join(root, 'escaped-directory'), 'junction');
    } catch (error) {
      // Some locked-down Windows environments do not permit links. The traversal test above
      // remains meaningful there; do not report a false product failure.
      context.skip(`Symlink creation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await assert.rejects(() => resolveInside(root, 'escaped-directory/private.txt'), { code: 'invalid_path' });
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test('safeDirectoryName never exposes display-name traversal characters', () => {
  const directory = safeDirectoryName('../A server\\with strange chars', 'a1b2c3d4-e5f6-7890-abcd-ef0123456789');
  assert.match(directory, /^a-server-with-strange-chars-a1b2c3d4$/);
  assert.equal(directory.includes('..'), false);
  assert.equal(directory.includes('\\'), false);
  assert.equal(directory.includes('/'), false);
});

test('managed server roots refuse a symlink/junction before process or file operations', async (context) => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  try {
    try {
      await symlink(outside, path.join(root, 'safe-server-a1b2c3d4'), 'junction');
    } catch (error) {
      context.skip(`Symlink creation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await assert.rejects(
      () => resolveManagedServerRoot(root, 'safe-server-a1b2c3d4'),
      { code: 'unsafe_server_directory' },
    );
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test('managedServerDirectoryExists correctly reports existing and missing directories', async () => {
  const root = await temporaryRoot();
  try {
    const serverDirName = 'test-server-12345678';
    assert.equal(await managedServerDirectoryExists(root, serverDirName), false);

    await mkdir(path.join(root, serverDirName));
    assert.equal(await managedServerDirectoryExists(root, serverDirName), true);

    await rm(path.join(root, serverDirName), { recursive: true, force: true });
    assert.equal(await managedServerDirectoryExists(root, serverDirName), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
