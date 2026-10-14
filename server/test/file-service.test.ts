import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileService } from '../services/file-service.js';
import type { ServerRecord } from '../types.js';

function mockServer(directory: string): ServerRecord {
  return {
    id: 'test-server-1',
    machineId: 'local',
    name: 'Test Server',
    directory,
    game: 'minecraft-java',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    loaderVersion: null,
    startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] },
    requiredJavaMajor: 17,
    port: 25565,
    memoryMb: 2048,
    eulaAccepted: true,
    status: 'offline',
    installState: 'ready',
    javaPath: null,
    autoStart: 'disabled',
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStartedAt: null,
    lastStoppedAt: null,
  };
}

test('FileService handles create, rename, copy, move, and delete safely', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-files-'));
  const serverDir = path.join(baseDir, 'test-srv');
  await mkdir(serverDir);
  await writeFile(path.join(serverDir, 'server.jar'), 'dummy jar');
  await writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

  const service = new FileService(baseDir);
  const server = mockServer('test-srv');

  try {
    // 1. Create file and create folder
    await service.createFolder(server, '', 'plugins');
    await service.createFile(server, 'plugins', 'config.yml', 'debug: true\n');

    const listPlugins = await service.list(server, 'plugins');
    assert.equal(listPlugins.length, 1);
    assert.equal(listPlugins[0].name, 'config.yml');

    // 2. Reject creating protected files
    await assert.rejects(
      () => service.createFile(server, '', 'server.jar', 'bad'),
      { code: 'protected_file' },
    );

    // 3. Rename file
    const renameResult = await service.rename(server, 'plugins/config.yml', 'settings.yml');
    assert.equal(renameResult.path, 'plugins/settings.yml');

    // 4. Reject renaming protected files or renaming into protected files
    await assert.rejects(
      () => service.rename(server, 'server.jar', 'server-old.jar'),
      { code: 'protected_file' },
    );
    await assert.rejects(
      () => service.rename(server, 'plugins/settings.yml', 'server.jar'),
      { code: 'protected_file' },
    );

    // 5. Copy file
    const copyResult = await service.copy(server, 'plugins/settings.yml', '');
    assert.equal(copyResult.path, 'settings.yml');
    const copiedContent = await readFile(path.join(serverDir, 'settings.yml'), 'utf8');
    assert.equal(copiedContent, 'debug: true\n');

    // Duplicate copy generates copy suffix
    const duplicateCopy = await service.copy(server, 'plugins/settings.yml', '');
    assert.equal(duplicateCopy.path, 'settings-copy.yml');

    // 6. Refuse copy into self or child
    await assert.rejects(
      () => service.copy(server, 'plugins', 'plugins'),
      { code: 'cannot_copy_into_self' },
    );

    // 7. Move file
    await service.createFolder(server, '', 'backup');
    const moveResult = await service.move(server, 'settings-copy.yml', 'backup');
    assert.equal(moveResult.path, 'backup/settings-copy.yml');

    // 8. Delete
    await service.delete(server, 'backup/settings-copy.yml');
    const listBackup = await service.list(server, 'backup');
    assert.equal(listBackup.length, 0);

    // Delete folder recursively
    await service.delete(server, 'backup');

    // 9. Protect deletion of root or protected files
    await assert.rejects(
      () => service.delete(server, ''),
      { code: 'cannot_delete_root' },
    );
    await assert.rejects(
      () => service.delete(server, 'server.jar'),
      { code: 'protected_file' },
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
