import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  checksumForTorArchive,
  createTorConfiguration,
  isSafeTorBundleArchivePath,
  isTorOnionAddress,
  selectTorExpertBundle,
} from '../services/tor-service.js';

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
  const dataDirectory = path.resolve('nodepilot-test-data', 'tor', 'runtime');
  const hiddenServiceDirectory = path.resolve('nodepilot-test-data', 'tor', 'onion-service');
  const config = createTorConfiguration(dataDirectory, hiddenServiceDirectory, 7420);

  assert.ok(config.includes(`DataDirectory "${dataDirectory.replace(/\\/g, '/')}"`));
  assert.ok(config.includes(`HiddenServiceDir "${hiddenServiceDirectory.replace(/\\/g, '/')}"`));
  assert.match(config, /HiddenServicePort 80 127\.0\.0\.1:7420/);
  assert.match(config, /^SocksPort 0$/m);
  assert.match(config, /^ClientOnly 1$/m);
});

test('Tor configuration rejects unsafe paths and invalid ports', () => {
  assert.throws(() => createTorConfiguration('relative', '/tmp/onion', 7420));
  assert.throws(() => createTorConfiguration('/tmp/runtime', '/tmp/onion', 0));
  assert.throws(() => createTorConfiguration('/tmp/runtime', '/tmp/onion', 65_536));
});

test('Tor Expert Bundle selection keeps only official stable platform archives', () => {
  const catalog = [
    '<a href="https://dist.torproject.org/torbrowser/15.0.25/tor-expert-bundle-windows-x86_64-15.0.25.tar.gz">old</a>',
    '<a href="https://dist.torproject.org/torbrowser/15.0.26/tor-expert-bundle-windows-x86_64-15.0.26.tar.gz">new</a>',
    '<a href="https://dist.torproject.org/torbrowser/16.0a14/tor-expert-bundle-windows-x86_64-16.0a14.tar.gz">alpha</a>',
    '<a href="https://example.invalid/torbrowser/99.0.0/tor-expert-bundle-windows-x86_64-99.0.0.tar.gz">untrusted</a>',
    '<a href="https://dist.torproject.org/torbrowser/15.0.26/tor-expert-bundle-linux-x86_64-15.0.26.tar.gz">linux</a>',
    '<a href="https://dist.torproject.org/torbrowser/15.0.26/tor-expert-bundle-windows-x86_64-15.0.25.tar.gz">mismatch</a>',
  ].join('\n');

  const release = selectTorExpertBundle(catalog, 'win32');
  assert.equal(release?.version, '15.0.26');
  assert.equal(release?.archiveName, 'tor-expert-bundle-windows-x86_64-15.0.26.tar.gz');
  assert.equal(release?.archiveUrl, 'https://dist.torproject.org/torbrowser/15.0.26/tor-expert-bundle-windows-x86_64-15.0.26.tar.gz');
  assert.equal(selectTorExpertBundle(catalog, 'darwin'), null);
});

test('Tor signed checksum manifest requires one exact archive record', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const name = 'tor-expert-bundle-windows-x86_64-15.0.26.tar.gz';
  assert.equal(checksumForTorArchive(first + '  ' + name + '\n' + second + '  other.tar.gz', name), first);
  assert.equal(checksumForTorArchive(first + '  ' + name + '\n' + second + '  ' + name, name), null);
  assert.equal(checksumForTorArchive(first + '  unrelated.tar.gz', name), null);
});

test('Tor Expert Bundle paths reject traversal and non-portable archive paths', () => {
  assert.equal(isSafeTorBundleArchivePath('tor/tor.exe'), true);
  assert.equal(isSafeTorBundleArchivePath('data/geoip6'), true);
  assert.equal(isSafeTorBundleArchivePath('../tor/tor.exe'), false);
  assert.equal(isSafeTorBundleArchivePath('/tor/tor.exe'), false);
  assert.equal(isSafeTorBundleArchivePath('C:/tor/tor.exe'), false);
  assert.equal(isSafeTorBundleArchivePath('tor\\tor.exe'), false);
  assert.equal(isSafeTorBundleArchivePath('tor//tor.exe'), false);
});
