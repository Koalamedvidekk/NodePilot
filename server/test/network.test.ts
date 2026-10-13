import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAccessUrls, isAllowedOrigin, isPrivateOrLoopbackIp } from '../lib/network.js';

test('isPrivateOrLoopbackIp detects private subnets and loopback', () => {
  assert.equal(isPrivateOrLoopbackIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('localhost'), true);
  assert.equal(isPrivateOrLoopbackIp('192.168.1.150'), true);
  assert.equal(isPrivateOrLoopbackIp('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopbackIp('172.20.10.4'), true);
  assert.equal(isPrivateOrLoopbackIp('169.254.1.2'), true);

  assert.equal(isPrivateOrLoopbackIp('8.8.8.8'), false);
  assert.equal(isPrivateOrLoopbackIp('1.1.1.1'), false);
  assert.equal(isPrivateOrLoopbackIp('evil-site.com'), false);
});

test('isAllowedOrigin handles loopback and LAN modes correctly', () => {
  const localIps = ['192.168.1.150'];

  // Local only mode (127.0.0.1): allows localhost, rejects LAN IP origin
  assert.equal(isAllowedOrigin('http://localhost:7420', '127.0.0.1', localIps), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:7420', '127.0.0.1', localIps), true);
  assert.equal(isAllowedOrigin('http://192.168.1.150:7420', '127.0.0.1', localIps), false);
  assert.equal(isAllowedOrigin('http://attacker.com', '127.0.0.1', localIps), false);

  // LAN mode (0.0.0.0): allows localhost, LAN IP, and private subnets; rejects external public origins
  assert.equal(isAllowedOrigin('http://localhost:7420', '0.0.0.0', localIps), true);
  assert.equal(isAllowedOrigin('http://192.168.1.150:7420', '0.0.0.0', localIps), true);
  assert.equal(isAllowedOrigin('http://192.168.1.200:7420', '0.0.0.0', localIps), true);
  assert.equal(isAllowedOrigin('http://laptop.local:7420', '0.0.0.0', localIps), true);
  assert.equal(isAllowedOrigin('http://attacker.com', '0.0.0.0', localIps), false);
  assert.equal(isAllowedOrigin(undefined, '0.0.0.0', localIps), true);
});

test('formatAccessUrls formats URLs depending on host binding', () => {
  const localUrls = formatAccessUrls('127.0.0.1', 7420, ['192.168.1.150']);
  assert.equal(localUrls.local, 'http://localhost:7420');
  assert.deepEqual(localUrls.network, []);

  const lanUrls = formatAccessUrls('0.0.0.0', 7420, ['192.168.1.150']);
  assert.equal(lanUrls.local, 'http://localhost:7420');
  assert.deepEqual(lanUrls.network, ['http://192.168.1.150:7420']);
});
