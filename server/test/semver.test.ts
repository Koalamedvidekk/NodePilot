import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanVersion, compareSemVer, isNewerVersion, parseSemVer } from '../lib/semver.js';

test('parseSemVer parses valid semantic versions and rejects invalid', () => {
  assert.deepEqual(parseSemVer('1.2.3'), {
    raw: '1.2.3',
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: [],
  });

  assert.deepEqual(parseSemVer('v2.0.1-beta.2+20261022'), {
    raw: 'v2.0.1-beta.2+20261022',
    major: 2,
    minor: 0,
    patch: 1,
    prerelease: ['beta', '2'],
    build: ['20261022'],
  });

  assert.equal(parseSemVer('invalid'), null);
  assert.equal(parseSemVer('1.0'), null);
  assert.equal(parseSemVer('1.0.0.0'), null);
  assert.equal(parseSemVer('01.0.0'), null);
  assert.equal(parseSemVer('1.0.0-01'), null);
  assert.equal(parseSemVer('1.0.0-alpha..1'), null);
  assert.equal(parseSemVer(''), null);
});

test('compareSemVer correctly orders versions', () => {
  // Major, minor, patch ordering
  assert.ok(compareSemVer('1.0.0', '0.9.9') > 0);
  assert.ok(compareSemVer('1.1.0', '1.0.9') > 0);
  assert.ok(compareSemVer('1.0.1', '1.0.0') > 0);
  assert.equal(compareSemVer('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemVer('v1.0.0', '1.0.0'), 0);

  // Prerelease comparison
  assert.ok(compareSemVer('1.0.0', '1.0.0-beta') > 0, 'Release is higher than prerelease');
  assert.ok(compareSemVer('1.0.0-beta.2', '1.0.0-beta.1') > 0);
  assert.ok(compareSemVer('1.0.0-beta', '1.0.0-alpha') > 0);
  assert.ok(compareSemVer('1.0.0-alpha.1', '1.0.0-alpha') > 0);
  assert.ok(compareSemVer('1.0.0-999999999999999999999', '1.0.0-2') > 0);
});

test('isNewerVersion checks candidate against current version', () => {
  assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false);
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.2.0'), false);
  assert.equal(isNewerVersion('0.2.0', '0.2.0-beta.1'), true);
});

test('cleanVersion formats clean version strings', () => {
  assert.equal(cleanVersion('v1.2.3'), '1.2.3');
  assert.equal(cleanVersion('  1.2.3  '), '1.2.3');
  assert.equal(cleanVersion('v2.0.0-rc.1'), '2.0.0-rc.1');
});
