import assert from 'node:assert/strict';
import test from 'node:test';

import { initialHeapMb } from '../services/server-runtime.js';

test('initialHeapMb avoids committing a server maximum heap at startup', () => {
  assert.equal(initialHeapMb(4_096), 1_024);
  assert.equal(initialHeapMb(2_048), 512);
  assert.equal(initialHeapMb(1_024), 512);
  assert.equal(initialHeapMb(256), 256);
});
