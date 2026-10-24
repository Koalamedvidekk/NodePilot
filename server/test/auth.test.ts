import assert from 'node:assert/strict';
import test from 'node:test';

import { pinMatches, requiresPanelPin } from '../lib/auth.js';

test('panel PIN protects network changes while keeping authentication bootstrap routes available', () => {
  assert.equal(requiresPanelPin('/api/network'), true);
  assert.equal(requiresPanelPin('/api/network?anything=true'), true);
  assert.equal(requiresPanelPin('/api/host/tor/start'), true);
  assert.equal(requiresPanelPin('/api/host/tor/install'), true);
  assert.equal(requiresPanelPin('/api/auth/status'), false);
  assert.equal(requiresPanelPin('/api/auth/verify'), false);
  assert.equal(requiresPanelPin('/api/bridge/connect'), false);
  assert.equal(requiresPanelPin('/'), false);
});

test('panel PIN matching requires the existing exact PIN', () => {
  assert.equal(pinMatches('correct horse battery staple', 'correct horse battery staple'), true);
  assert.equal(pinMatches(' correct horse battery staple ', 'correct horse battery staple'), true);
  assert.equal(pinMatches('wrong', 'correct horse battery staple'), false);
  assert.equal(pinMatches(undefined, 'correct horse battery staple'), false);
  assert.equal(pinMatches('correct horse battery staple', null), false);
});
