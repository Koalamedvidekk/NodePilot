import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateCpuPercent, parseLinuxIo, parseLinuxProcStat, parseLinuxStatusRss } from '../services/process-metrics-service.js';

test('process CPU is normalized against the whole logical machine capacity', () => {
  assert.equal(
    calculateCpuPercent({ sampledAt: 1_000, cpuTimeMs: 500 }, { sampledAt: 2_000, cpuTimeMs: 1_000 }, 4),
    12.5,
  );
  assert.equal(calculateCpuPercent({ sampledAt: 2_000, cpuTimeMs: 1_000 }, { sampledAt: 2_000, cpuTimeMs: 1_100 }, 4), undefined);
});

test('Linux process parsers retain process-only values', () => {
  const stat = parseLinuxProcStat('1234 (java worker) S 0 0 0 0 0 0 0 0 0 0 17 8 0 0');
  assert.deepEqual(stat, { cpuTicks: 25 });
  assert.equal(parseLinuxStatusRss('Name:\tjava\nVmRSS:\t 12345 kB\n'), 12_641_280);
  assert.deepEqual(parseLinuxIo('read_bytes: 128\nwrite_bytes: 256\n'), { readBytes: 128, writeBytes: 256 });
});
