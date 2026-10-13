import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db.js';
import { AppError } from '../lib/errors.js';
import { resolveManagedServerRoot } from '../lib/paths.js';
import { ServerRepository } from '../repositories/server-repository.js';

test('deleting a server whose directory was deleted manually succeeds in removing repository record', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-del-'));
  const serversDir = path.join(tempDir, 'servers');
  const dbPath = path.join(tempDir, 'test.sqlite');
  await mkdir(serversDir, { recursive: true });

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dbPath);
    const repo = new ServerRepository(db);

    const serverDirName = 'deleted-server-12345678';
    const serverPath = path.join(serversDir, serverDirName);
    await mkdir(serverPath, { recursive: true });

    const serverId = '11111111-2222-3333-4444-555555555555';
    repo.create({
      id: serverId,
      machineId: 'local',
      name: 'Deleted Server',
      directory: serverDirName,
      flavor: 'paper',
      software: 'paper',
      version: '1.20.4',
      requiredJavaMajor: 17,
      port: 25565,
      memoryMb: 2048,
      eulaAccepted: true,
    });

    assert.equal(repo.find(serverId)?.id, serverId);

    // Simulate user manually deleting the folder on PC
    await rm(serverPath, { recursive: true, force: true });

    // The deletion logic in server/index.ts
    try {
      const target = await resolveManagedServerRoot(serversDir, serverDirName);
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'server_directory_not_found') {
        throw error;
      }
    }
    repo.delete(serverId);

    // Confirm server is removed from database
    assert.equal(repo.find(serverId), null);
    assert.equal(repo.list().length, 0);
  } finally {
    db?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
