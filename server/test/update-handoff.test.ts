import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { waitForUpdateHelper } from '../services/update-service.js';

test('update handoff waits for the launched helper to confirm readiness', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-handoff-'));
  const marker = path.join(directory, 'ready.json');
  const child = spawn(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ready:true,pid:process.pid}));setTimeout(()=>{},5000)',
    marker,
  ], { stdio: 'ignore' });
  try {
    await waitForUpdateHelper(child, marker, 3_000);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('update handoff rejects an exited helper instead of shutting down the panel', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-handoff-exit-'));
  const child = spawn(process.execPath, ['-e', 'process.exit(17)'], { stdio: 'ignore' });
  try {
    await assert.rejects(waitForUpdateHelper(child, path.join(directory, 'ready.json'), 3_000), /exited before it was ready/);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('update handoff reports spawn failures without an unhandled process error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-handoff-spawn-'));
  const child = spawn(path.join(directory, 'missing-updater'), [], { stdio: 'ignore' });
  try {
    await assert.rejects(waitForUpdateHelper(child, path.join(directory, 'ready.json'), 1_000), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('update handoff refuses a readiness marker from another PID', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-handoff-pid-'));
  const marker = path.join(directory, 'ready.json');
  const child = spawn(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ready:true,pid:process.pid+1}));setTimeout(()=>{},5000)',
    marker,
  ], { stdio: 'ignore' });
  try {
    await assert.rejects(waitForUpdateHelper(child, marker, 600), /did not become ready/);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
