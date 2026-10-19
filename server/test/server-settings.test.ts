import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import { parseMemoryMb, formatMemoryMb, validateCustomJvmArgs } from '../lib/settings-helpers.js';
import { AutoSleepService } from '../services/auto-sleep-service.js';
import { AppError } from '../lib/errors.js';

test('parseMemoryMb handles human memory strings and bounds correctly', () => {
  assert.equal(parseMemoryMb('2G'), 2048);
  assert.equal(parseMemoryMb('4g'), 4096);
  assert.equal(parseMemoryMb('4GB'), 4096);
  assert.equal(parseMemoryMb('2048M'), 2048);
  assert.equal(parseMemoryMb('2048m'), 2048);
  assert.equal(parseMemoryMb('2048MB'), 2048);
  assert.equal(parseMemoryMb('4096'), 4096);
  assert.equal(parseMemoryMb(2048), 2048);
  assert.equal(parseMemoryMb(null), null);
  assert.equal(parseMemoryMb(undefined), null);
  assert.equal(parseMemoryMb(''), null);

  // Formatter
  assert.equal(formatMemoryMb(2048), '2G');
  assert.equal(formatMemoryMb(4096), '4G');
  assert.equal(formatMemoryMb(2500), '2500M');
  assert.equal(formatMemoryMb(null), '');

  // Out of bounds / invalid formats
  assert.throws(() => parseMemoryMb('invalid'), (err) => err instanceof AppError && err.code === 'invalid_memory_format');
  assert.throws(() => parseMemoryMb('100M'), (err) => err instanceof AppError && err.code === 'invalid_memory_range');
  assert.throws(() => parseMemoryMb('100G'), (err) => err instanceof AppError && err.code === 'invalid_memory_range');
});

test('validateCustomJvmArgs safely filters JVM flags', () => {
  const valid = validateCustomJvmArgs([
    '-XX:+UseG1GC',
    '-Dfile.encoding=UTF-8',
    '-XX:+ParallelRefProcEnabled',
    '@args.txt',
  ]);
  assert.deepEqual(valid, [
    '-XX:+UseG1GC',
    '-Dfile.encoding=UTF-8',
    '-XX:+ParallelRefProcEnabled',
    '@args.txt',
  ]);

  // Disallow shell characters
  assert.throws(
    () => validateCustomJvmArgs(['-Dflag=1; rm -rf /']),
    (err) => err instanceof AppError && err.code === 'unsafe_jvm_arg',
  );
  assert.throws(
    () => validateCustomJvmArgs(['-Dflag=1 | echo test']),
    (err) => err instanceof AppError && err.code === 'unsafe_jvm_arg',
  );

  // Disallow duplicate heap flags (must use dedicated inputs)
  assert.throws(
    () => validateCustomJvmArgs(['-Xms2G']),
    (err) => err instanceof AppError && err.code === 'duplicate_heap_arg',
  );
  assert.throws(
    () => validateCustomJvmArgs(['-Xmx4G']),
    (err) => err instanceof AppError && err.code === 'duplicate_heap_arg',
  );

  // Disallow code execution vectors
  assert.throws(
    () => validateCustomJvmArgs(['-XX:OnError=cmd.exe']),
    (err) => err instanceof AppError && err.code === 'prohibited_jvm_arg',
  );
  assert.throws(
    () => validateCustomJvmArgs(['-javaagent:malicious.jar']),
    (err) => err instanceof AppError && err.code === 'prohibited_jvm_arg',
  );

  // Disallow bare words that are not flags
  assert.throws(
    () => validateCustomJvmArgs(['not-a-flag']),
    (err) => err instanceof AppError && err.code === 'invalid_jvm_arg_format',
  );
});

test('ServerSettingsRepository manages persistence and section resets', () => {
  const database = openDatabase(':memory:');
  const serverRepo = new ServerRepository(database);
  const settingsRepo = new ServerSettingsRepository(database);

  const server = serverRepo.create({
    id: 'test-server-1',
    machineId: 'local',
    name: 'Survival Server',
    directory: 'survival-1',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    requiredJavaMajor: 21,
    port: 25565,
    memoryMb: 4096,
    eulaAccepted: true,
  });

  // Default record
  const initial = settingsRepo.getOrCreate(server.id);
  assert.equal(initial.autoWake, false);
  assert.equal(initial.autoSleep, false);
  assert.equal(initial.idleTimeoutMinutes, 15);
  assert.equal(initial.minMemoryMb, null);
  assert.deepEqual(initial.customJvmArgs, []);
  assert.equal(initial.shutdownTimeoutSeconds, 20);

  // Update Auto-Wake independently
  const withWake = settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: 35565 });
  assert.equal(withWake.autoWake, true);
  assert.equal(withWake.wakeProxyPort, 35565);
  assert.equal(withWake.autoSleep, false); // independent!

  // Update Auto-Sleep independently
  const withSleep = settingsRepo.update(server.id, { autoSleep: true, idleTimeoutMinutes: 30 });
  assert.equal(withSleep.autoWake, true);
  assert.equal(withSleep.autoSleep, true);
  assert.equal(withSleep.idleTimeoutMinutes, 30);

  // Update Java settings
  const withJava = settingsRepo.update(server.id, {
    minMemoryMb: 2048,
    customJvmArgs: ['-XX:+UseG1GC'],
  });
  assert.equal(withJava.minMemoryMb, 2048);
  assert.deepEqual(withJava.customJvmArgs, ['-XX:+UseG1GC']);
  assert.equal(withJava.autoWake, true); // untouched

  // Reset section: Java
  const afterResetJava = settingsRepo.resetSection(server.id, 'java');
  assert.equal(afterResetJava.minMemoryMb, null);
  assert.deepEqual(afterResetJava.customJvmArgs, []);
  assert.equal(afterResetJava.autoWake, true); // untouched
  assert.equal(afterResetJava.autoSleep, true); // untouched

  // Reset section: Auto-Wake
  const afterResetWake = settingsRepo.resetSection(server.id, 'auto-wake');
  assert.equal(afterResetWake.autoWake, false);
  assert.equal(afterResetWake.wakeProxyPort, null);
  assert.equal(afterResetWake.autoSleep, true); // untouched

  database.close();
});

test('AutoSleepService calculates countdown and resets immediately when player joins', async () => {
  const database = openDatabase(':memory:');
  const serverRepo = new ServerRepository(database);
  const settingsRepo = new ServerSettingsRepository(database);

  const server = serverRepo.create({
    id: 'test-sleep-server',
    machineId: 'local',
    name: 'Sleep Test',
    directory: 'sleep-1',
    flavor: 'vanilla',
    software: 'vanilla',
    version: '1.20.4',
    requiredJavaMajor: 21,
    port: 25565,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);

  settingsRepo.update(server.id, { autoSleep: true, idleTimeoutMinutes: 10 });

  let onlineCount = 0;
  const mockPlayerService = {
    getOnlinePlayerCount: () => onlineCount,
  } as any;

  let stopped = false;
  const mockRuntime = {
    stop: async () => { stopped = true; },
  } as any;

  const autoSleep = new AutoSleepService(serverRepo, settingsRepo, mockRuntime, mockPlayerService);

  // When server is offline, countdown is null
  let status = autoSleep.getStatus(server.id);
  assert.equal(status.enabled, true);
  assert.equal(status.countdownSeconds, null);

  // Mark server running
  serverRepo.setStatus(server.id, 'running');

  // Tick when idle (0 players)
  await autoSleep.tick();
  status = autoSleep.getStatus(server.id);
  assert.equal(status.isIdle, true);
  assert.ok(status.countdownSeconds !== null && status.countdownSeconds > 0);
  assert.ok(status.countdownSeconds <= 600);

  // Player joins: onlineCount = 1
  onlineCount = 1;
  await autoSleep.tick();
  status = autoSleep.getStatus(server.id);
  assert.equal(status.isIdle, false);
  assert.equal(status.countdownSeconds, null);
  assert.equal(status.onlinePlayersCount, 1);

  // Player leaves: onlineCount = 0
  onlineCount = 0;
  await autoSleep.tick();
  status = autoSleep.getStatus(server.id);
  assert.equal(status.isIdle, true);
  assert.ok(status.countdownSeconds !== null && status.countdownSeconds > 0);

  autoSleep.stop();
  database.close();
});
