import assert from 'node:assert/strict';
import test from 'node:test';

import { StartupProgressTracker, startupProgressFromLogs } from '../services/startup-progress.js';
import type { ConsoleLine } from '../types.js';

const time = '2026-11-05T10:00:00.000Z';
const line = (message: string, stream: ConsoleLine['stream'] = 'stdout', timestamp = time): ConsoleLine => ({ message, stream, timestamp });
const launch = (timestamp = time) => line('Starting Java /managed/java with 512 MB initial heap and 2048 MB maximum heap.', 'system', timestamp);
const done = '[10:00:01] [Server thread/INFO]: Done (1.234s)! For help, type "help"';

test('startup stages are derived from real Vanilla, Paper and Forge log messages', () => {
  const tracker = new StartupProgressTracker();
  assert.deepEqual(tracker.snapshot(), { stage: 'Starting server', percent: null, isReady: false });
  tracker.observe(line('Loading libraries, please wait...'));
  assert.equal(tracker.snapshot().stage, 'Loading server libraries');
  tracker.observe(line('[10:00:00 INFO]: Starting minecraft server version 1.21.4'));
  assert.equal(tracker.snapshot().stage, 'Starting Minecraft');
  tracker.observe(line('[10:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Loaded 1442 recipes'));
  assert.equal(tracker.snapshot().stage, 'Loading game data');
  tracker.observe(line('[10:00:00] [Server thread/INFO]: Preparing level "world"'));
  assert.equal(tracker.snapshot().stage, 'Loading worlds');
  assert.equal(tracker.snapshot().percent, null, 'Stages never invent an overall percentage.');
});

test('spawn progress exposes only Minecraft-reported percentages and is monotonic within one dimension', () => {
  const tracker = new StartupProgressTracker();
  tracker.observe(line('[10:00:00 INFO]: Preparing start region for dimension minecraft:overworld'));
  tracker.observe(line('\x1b[32m[10:00:00 INFO]: Preparing spawn area: 23.5%\x1b[0m'));
  assert.deepEqual(tracker.snapshot(), { stage: 'Preparing spawn area (minecraft:overworld)', percent: 23.5, isReady: false });
  tracker.observe(line('[10:00:00 INFO]: Preparing spawn area: 12%'));
  assert.equal(tracker.snapshot().percent, 23.5);
  tracker.observe(line('[10:00:00 INFO]: Preparing spawn area: 100 %'));
  assert.equal(tracker.snapshot().percent, 100);
  assert.equal(tracker.snapshot().isReady, false, 'A completed spawn area does not mean the server is accepting players.');
});

test('a new dimension starts a separate real spawn progress stage', () => {
  const tracker = new StartupProgressTracker();
  tracker.observe(line('Preparing start region for dimension minecraft:overworld'));
  tracker.observe(line('Preparing spawn area: 100%'));
  tracker.observe(line('Preparing start region for dimension forge:custom_world'));
  assert.equal(tracker.snapshot().percent, null);
  tracker.observe(line('Preparing spawn area: 5%'));
  assert.deepEqual(tracker.snapshot(), { stage: 'Preparing spawn area (forge:custom_world)', percent: 5, isReady: false });
  tracker.observe(line('Preparing start region for level -1'));
  tracker.observe(line('Preparing spawn area: 0%'));
  assert.deepEqual(tracker.snapshot(), { stage: 'Preparing spawn area (level -1)', percent: 0, isReady: false });
});

test('invalid, oversized and arbitrary output never creates a percentage', () => {
  const tracker = new StartupProgressTracker();
  for (const message of ['Preparing spawn area: -1%', 'Preparing spawn area: 101%', 'Preparing spawn area: Infinity%',
    'Preparing spawn area: NaN%', 'Downloaded mods 70%', 'Preparing spawn area: 10% extra text', 'A plugin says Preparing spawn area: 42%']) {
    tracker.observe(line(message));
    assert.equal(tracker.snapshot().percent, null, message);
  }
});

test('chat and echoed console commands cannot masquerade as startup completion', () => {
  const tracker = new StartupProgressTracker();
  for (const message of ['<Player> Done (1.0s)! For help, type "help"', '[Server thread/INFO]: [Not Secure] <Player> Done (1.0s)! For help, type "help"',
    '[Player] Done (1.0s)! For help, type "help"', '[10:00:01 INFO]: [Plugin] Done (1.0s)! For help, type "help"',
    'Done!', 'A plugin is Done (1.0s)! For help, type "help"', 'Done (1.0s)!']) {
    tracker.observe(line(message));
    assert.equal(tracker.snapshot().isReady, false, message);
  }
  tracker.observe(line('> say Done (1.0s)! For help, type "help"', 'system'));
  assert.equal(tracker.snapshot().isReady, false);
});

test('Done marks finishing startup and does not invent network readiness or an overall percentage', () => {
  const tracker = new StartupProgressTracker();
  tracker.observe(line(done));
  assert.deepEqual(tracker.snapshot(), { stage: 'Finishing startup', percent: null, isReady: true });
  tracker.observe(line('Loaded 123 recipes'));
  assert.equal(tracker.snapshot().isReady, true, 'Later plugin/reload output cannot rewind a completed launch.');
});

test('explicit reset and a new runtime launch clear old completion and dimension progress', () => {
  const tracker = new StartupProgressTracker();
  tracker.observe(line(done));
  tracker.reset();
  assert.equal(tracker.snapshot().isReady, false);
  tracker.observe(line('Preparing start region for dimension minecraft:the_end'));
  tracker.observe(line('Preparing spawn area: 99%'));
  tracker.observe(launch());
  assert.deepEqual(tracker.snapshot(), { stage: 'Starting server', percent: null, isReady: false });
  tracker.observe(line(done));
  tracker.observe(line('Starting Bedrock Dedicated Server (bedrock_server.exe)...', 'system'));
  assert.equal(tracker.snapshot().isReady, false);
});

test('reconstruction filters logs to the current launch timestamp', () => {
  const logs = [launch('2026-11-05T09:00:00.000Z'), line(done, 'stdout', '2026-11-05T09:00:05.000Z'),
    line('Loaded 1550 recipes', 'stdout', time), line(done, 'stdout', 'invalid')];
  assert.deepEqual(startupProgressFromLogs(logs, time), { stage: 'Loading game data', percent: null, isReady: false });
});

test('without a timestamp reconstruction uses only the last launch marker and never trusts an unowned old log tail', () => {
  assert.deepEqual(startupProgressFromLogs([line(done)]), { stage: 'Starting server', percent: null, isReady: false });
  const logs = [launch(), line(done), launch(), line('Preparing level "new-world"')];
  assert.deepEqual(startupProgressFromLogs(logs), { stage: 'Loading worlds', percent: null, isReady: false });
  assert.deepEqual(startupProgressFromLogs(logs, 'invalid'), { stage: 'Loading worlds', percent: null, isReady: false });
});

test('snapshots are immutable copies and repeated reads never fabricate elapsed progress', () => {
  const tracker = new StartupProgressTracker();
  const snapshot = tracker.snapshot();
  snapshot.percent = 50; snapshot.isReady = true;
  assert.deepEqual(tracker.snapshot(), { stage: 'Starting server', percent: null, isReady: false });
  tracker.observe(line('Preparing spawn area: 38%'));
  assert.deepEqual(tracker.snapshot(), tracker.snapshot());
});
