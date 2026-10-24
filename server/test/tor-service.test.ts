import assert from 'node:assert/strict';
import test from 'node:test';

import { createTorConfiguration, isTorOnionAddress } from '../services/tor-service.js';

test('Tor Onion address validation accepts only v3 Onion hostnames', () => {
  const valid = `${'a'.repeat(56)}.onion`;
  assert.equal(isTorOnionAddress(valid), true);
  assert.equal(isTorOnionAddress(valid.toUpperCase()), true);
  assert.equal(isTorOnionAddress('short.onion'), false);
  assert.equal(isTorOnionAddress(`${'a'.repeat(55)}.onion`), false);
  assert.equal(isTorOnionAddress(`${'0'.repeat(56)}.onion`), false);
  assert.equal(isTorOnionAddress(`${'a'.repeat(56)}.onion.example.com`), false);
});

test('Tor configuration binds only the panel loopback port and has no SOCKS listener', () => {
  const config = createTorConfiguration('C:\\NodePilot Data\\tor\\runtime', 'C:\\NodePilot Data\\tor\\onion-service', 7420);
  assert.match(config, /DataDirectory "C:\/NodePilot Data\/tor\/runtime"/);
  assert.match(config, /HiddenServiceDir "C:\/NodePilot Data\/tor\/onion-service"/);
  assert.match(config, /HiddenServicePort 80 127\.0\.0\.1:7420/);
  assert.match(config, /^SocksPort 0$/m);
  assert.match(config, /^ClientOnly 1$/m);
});

test('Tor configuration rejects unsafe paths and invalid ports', () => {
  assert.throws(() => createTorConfiguration('relative', '/tmp/onion', 7420));
  assert.throws(() => createTorConfiguration('/tmp/runtime', '/tmp/onion', 0));
  assert.throws(() => createTorConfiguration('/tmp/runtime', '/tmp/onion', 65_536));
});
