import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateCpuPercent,
  parseJcmdHeap,
  parseLinuxIo,
  parseLinuxProcStat,
  parseLinuxStatusRss,
} from '../services/process-metrics-service.js';

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

test('parseJcmdHeap parses Java 21/25 G1GC heap output correctly', () => {
  const g1Java25 = [
    '19760:',
    'garbage-first heap   total reserved 4194304K, committed 1048576K, used 661053K [0x0000000700000000, 0x0000000800000000)',
    ' region size 2048K, 189 young (387072K), 13 survivors (26624K)',
  ].join('\n');

  const heap = parseJcmdHeap(g1Java25, 4 * 1024 * 1024 * 1024);
  assert.equal(heap.available, true);
  assert.equal(heap.usedBytes, 661053 * 1024);
  assert.equal(heap.committedBytes, 1048576 * 1024);
  assert.equal(heap.maxBytes, 4194304 * 1024);
});

test('parseJcmdHeap parses older Java G1GC heap output', () => {
  const olderG1 = [
    '1234:',
    'garbage-first heap   total 1048576K, used 524288K [0x0000000780000000, 0x0000000800000000)',
    ' region size 2048K, 256 young (524288K), 0 survivors (0K)',
  ].join('\n');

  const heap = parseJcmdHeap(olderG1, 2 * 1024 * 1024 * 1024);
  assert.equal(heap.available, true);
  assert.equal(heap.usedBytes, 524288 * 1024);
  assert.equal(heap.committedBytes, 1048576 * 1024);
  assert.equal(heap.maxBytes, 2 * 1024 * 1024 * 1024);
});

test('parseJcmdHeap parses ZGC and capacity-style heap output', () => {
  const zgc = [
    '5678:',
    'ZHeap           used 256M, capacity 512M, max capacity 2048M',
  ].join('\n');

  const heap = parseJcmdHeap(zgc, 2 * 1024 * 1024 * 1024);
  assert.equal(heap.available, true);
  assert.equal(heap.usedBytes, 256 * 1024 * 1024);
  assert.equal(heap.committedBytes, 512 * 1024 * 1024);
  assert.equal(heap.maxBytes, 2048 * 1024 * 1024);
});

test('parseJcmdHeap returns unavailable on invalid or failed jcmd output', () => {
  assert.equal(parseJcmdHeap('', 1024).available, false);
  assert.equal(parseJcmdHeap('Exception in thread: process not found', 1024).available, false);
});
