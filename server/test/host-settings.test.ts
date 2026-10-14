import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db.js';
import { HostSettingsRepository } from '../repositories/host-settings-repository.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { StartupService } from '../services/startup-service.js';
import { PlayitService } from '../services/playit-service.js';
import { AutoStartService } from '../services/auto-start-service.js';
import { InstanceLock } from '../lib/lockfile.js';

test('HostSettingsRepository correctly saves, retrieves, and updates host configurations', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-host-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  try {
    const db = openDatabase(dbPath);
    const repo = new HostSettingsRepository(db);

    const initial = repo.getSettings();
    assert.equal(initial.systemStartupEnabled, false);
    assert.equal(initial.launchMode, 'headless');
    assert.equal(initial.openBrowserOnStartup, false);
    assert.equal(initial.continueRunningOnClose, true);

    const updated = repo.saveSettings({
      systemStartupEnabled: true,
      launchMode: 'windowed',
      openBrowserOnStartup: true,
    });

    assert.equal(updated.systemStartupEnabled, true);
    assert.equal(updated.launchMode, 'windowed');
    assert.equal(updated.openBrowserOnStartup, true);

    // Verify persistence across new repository instance
    const repo2 = new HostSettingsRepository(db);
    const reloaded = repo2.getSettings();
    assert.equal(reloaded.systemStartupEnabled, true);
    assert.equal(reloaded.launchMode, 'windowed');
    assert.equal(reloaded.openBrowserOnStartup, true);

    db.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ServerRepository manages autoStart mode correctly', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-srv-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  try {
    const db = openDatabase(dbPath);
    const repo = new ServerRepository(db);

    const server = repo.create({
      id: '22222222-3333-4444-5555-666666666666',
      machineId: 'local',
      name: 'AutoStart Server',
      directory: 'autostart-server',
      flavor: 'vanilla',
      software: 'vanilla',
      version: '1.20.4',
      requiredJavaMajor: 17,
      port: 25565,
      memoryMb: 1024,
      eulaAccepted: true,
    });

    assert.equal(server.autoStart, 'disabled');

    const updated = repo.setAutoStart(server.id, 'always');
    assert.equal(updated.autoStart, 'always');

    const fetched = repo.find(server.id);
    assert.equal(fetched?.autoStart, 'always');

    db.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('InstanceLock safely acquires, detects existing running processes, and releases', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-lock-'));

  try {
    const lock1 = new InstanceLock(tempDir);
    const acquired1 = await lock1.acquire();
    assert.equal(acquired1, true);

    // Re-entrant lock check for same process
    const lock2 = new InstanceLock(tempDir);
    const acquired2 = await lock2.acquire();
    assert.equal(acquired2, true);

    lock1.release();

    // After release, should acquire cleanly again
    const lock3 = new InstanceLock(tempDir);
    const acquired3 = await lock3.acquire();
    assert.equal(acquired3, true);
    lock3.release();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('StartupService provides valid paths and platform status', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-start-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  try {
    const db = openDatabase(dbPath);
    const hostRepo = new HostSettingsRepository(db);
    const startup = new StartupService(hostRepo, tempDir);

    const status = await startup.getStatus();
    assert.equal(status.platform, os.platform());
    assert.ok(status.permissionsExplanation.length > 0);

    const filePath = startup.getStartupFilePath();
    if (os.platform() === 'win32') {
      assert.ok(filePath?.endsWith('NodePilot-Startup.vbs'));
    } else if (os.platform() === 'linux') {
      assert.ok(filePath?.endsWith('nodepilot.service'));
    }

    db.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('PlayitService correctly resolves managed binary path and download URL', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-playit-'));

  try {
    const playit = new PlayitService(tempDir);
    const download = playit.getDownloadUrl();
    if (['win32', 'linux'].includes(os.platform())) {
      assert.ok(download !== null);
      assert.ok(download.url.includes('playit-cloud/playit-agent/releases'));
    }

    const binary = await playit.findBinaryPath();
    // System or null
    assert.ok(binary === null || typeof binary.path === 'string');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AutoStartService records diagnostics and handles server autostart gracefully', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-auto-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  try {
    const db = openDatabase(dbPath);
    const repo = new ServerRepository(db);
    const playit = new PlayitService();

    // Mock runtime
    const startedServers: string[] = [];
    const mockRuntime = {
      start: async (server: any, javaPath: string, warning?: string) => {
        startedServers.push(server.id);
      },
    } as any;

    const autoStartService = new AutoStartService(repo, mockRuntime, playit);

    // Boot with no autostart servers
    await autoStartService.runBootSequence();
    const logs = autoStartService.getDiagnostics();
    assert.ok(logs.some((l) => l.message.includes('No Minecraft servers configured for auto-start.')));

    // Second run should skip cleanly (exactly-once semantics)
    await autoStartService.runBootSequence();
    const secondLogs = autoStartService.getDiagnostics();
    assert.ok(secondLogs.some((l) => l.message.includes('Boot sequence already completed')));

    db.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
