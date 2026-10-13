import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeTokenHash } from '../services/player-bridge.js';
import { canonicalUuid } from '../services/player-service.js';

test('canonicalUuid normalizes Minecraft UUID formats and refuses arbitrary player input', () => {
  assert.equal(canonicalUuid('069a79f4-44e9-4726-a5be-fca90e38aaf5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(canonicalUuid('069A79F444E94726A5BEFCA90E38AAF5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(canonicalUuid('../../not-a-player'), undefined);
  assert.equal(canonicalUuid(undefined), undefined);
});

test('bridge credentials are represented by deterministic non-plaintext hashes', () => {
  const token = 'example-local-bridge-token';
  assert.equal(bridgeTokenHash(token), bridgeTokenHash(token));
  assert.notEqual(bridgeTokenHash(token), token);
  assert.notEqual(bridgeTokenHash(token), bridgeTokenHash(`${token}-other`));
});
