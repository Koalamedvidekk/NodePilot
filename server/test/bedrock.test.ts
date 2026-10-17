import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { MinecraftService } from '../services/minecraft-service.js';

type SqliteDb = ReturnType<typeof openDatabase>;

async function safeCleanup(db?: SqliteDb, tempDir?: string): Promise<void> {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (tempDir) {
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore cleanup errors on Windows temp files
    }
  }
}

test('ServerRepository correctly saves, retrieves, and parses Bedrock server with executable startup config', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-bedrock-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: SqliteDb | undefined;

  try {
    db = openDatabase(dbPath);
    const repo = new ServerRepository(db);

    const server = repo.create({
      id: 'bedrock-1111-2222-3333-444455556666',
      machineId: 'local',
      name: 'Bedrock Survival Realm',
      software: 'bedrock',
      game: 'minecraft-bedrock',
      version: '1.26.52',
      directory: 'bedrock-survival',
      port: 19132,
      memoryMb: 2048,
      eulaAccepted: true,
      startupConfig: {
        mode: 'executable',
        executablePath: 'bedrock_server.exe',
        gameArguments: [],
      },
    });

    assert.equal(server.software, 'bedrock');
    assert.equal(server.game, 'minecraft-bedrock');
    assert.equal(server.port, 19132);
    assert.equal(server.startupConfig.mode, 'executable');
    if (server.startupConfig.mode === 'executable') {
      assert.equal(server.startupConfig.executablePath, 'bedrock_server.exe');
      assert.deepEqual(server.startupConfig.gameArguments, []);
    }

    // Verify persistence across reload
    const reloaded = repo.find(server.id);
    assert.ok(reloaded);
    assert.equal(reloaded.software, 'bedrock');
    assert.equal(reloaded.game, 'minecraft-bedrock');
    assert.equal(reloaded.startupConfig.mode, 'executable');
    if (reloaded.startupConfig.mode === 'executable') {
      assert.equal(reloaded.startupConfig.executablePath, 'bedrock_server.exe');
      assert.deepEqual(reloaded.startupConfig.gameArguments, []);
    }
  } finally {
    await safeCleanup(db, tempDir);
  }
});

test('ServerRepository rejects invalid executable startup config', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-bedrock-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: SqliteDb | undefined;

  try {
    db = openDatabase(dbPath);
    const repo = new ServerRepository(db);

    // Path traversal in executablePath
    assert.throws(
      () => {
        repo.create({
          id: 'bedrock-2222-3333-4444-555566667777',
          machineId: 'local',
          name: 'Traversal Test',
          software: 'bedrock',
          game: 'minecraft-bedrock',
          version: '1.26.52',
          directory: 'traversal-test',
          port: 19132,
          memoryMb: 2048,
          eulaAccepted: true,
          startupConfig: {
            mode: 'executable',
            executablePath: '../bedrock_server.exe',
            gameArguments: [],
          },
        });
      },
      (error: unknown) => error instanceof Error && /invalid server startup configuration/i.test(error.message),
    );

    // Absolute path in executablePath
    assert.throws(
      () => {
        repo.create({
          id: 'bedrock-3333-4444-5555-666677778888',
          machineId: 'local',
          name: 'Absolute Test',
          software: 'bedrock',
          game: 'minecraft-bedrock',
          version: '1.26.52',
          directory: 'abs-test',
          port: 19132,
          memoryMb: 2048,
          eulaAccepted: true,
          startupConfig: {
            mode: 'executable',
            executablePath: '/usr/bin/bedrock_server',
            gameArguments: [],
          },
        });
      },
      (error: unknown) => error instanceof Error && /invalid server startup configuration/i.test(error.message),
    );
  } finally {
    await safeCleanup(db, tempDir);
  }
});

test('MinecraftService returns available Bedrock versions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-bedrock-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: SqliteDb | undefined;

  try {
    db = openDatabase(dbPath);
    const repo = new ServerRepository(db);
    const service = new MinecraftService(repo, tempDir);

    const versions = await service.getVersions('bedrock');
    assert.ok(versions.length > 0, 'Bedrock versions list should not be empty');
    for (const v of versions) {
      assert.equal(v.type, 'release');
      assert.equal(v.available, true);
      assert.match(v.id, /^\d+(\.\d+)+$/);
    }
  } finally {
    await safeCleanup(db, tempDir);
  }
});

test('MinecraftService reports no required Java major for Bedrock', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-bedrock-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: SqliteDb | undefined;

  try {
    db = openDatabase(dbPath);
    const repo = new ServerRepository(db);
    const service = new MinecraftService(repo, tempDir);

    const requiredJava = await service.getRequiredJavaMajor('bedrock', '1.26.52');
    assert.equal(requiredJava, null, 'Bedrock Edition servers must not require Java');
  } finally {
    await safeCleanup(db, tempDir);
  }
});
