import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { openDatabase } from '../db.js';
import { BrowserIdentityRepository } from '../repositories/browser-identity-repository.js';
import { ServerRepository } from '../repositories/server-repository.js';

const firstServer = '11111111-1111-4111-8111-111111111111';
const secondServer = '22222222-2222-4222-8222-222222222222';

function fixture(t: TestContext) {
  const database = openDatabase(':memory:');
  const servers = new ServerRepository(database);
  for (const [index, id] of [firstServer, secondServer].entries()) {
    servers.create({ id, machineId: 'local', name: 'Browser fixture', directory: `browser-fixture-${index}`,
      software: 'paper', version: '26.3', port: 25565 + index, memoryMb: 1024, eulaAccepted: true });
  }
  t.after(() => database.close());
  return database;
}

test('browser profiles join using their chosen name and keep their UUID across reconnects and restarts', (t) => {
  const database = fixture(t);
  const identities = new BrowserIdentityRepository(database);
  const player = identities.resolve(firstServer, 'Player1234567890');
  assert.ok(player);
  assert.equal(player.name, 'Player1234567890');
  assert.match(player.uuid, /^[0-9a-f-]{36}$/);
  const restarted = new BrowserIdentityRepository(database);
  assert.deepEqual(restarted.resolve(firstServer, 'PLAYER1234567890'), player);
  const other = restarted.resolve(secondServer, player.name);
  assert.ok(other);
  assert.notEqual(other.uuid, player.uuid);
  for (const name of ['', 'two words', '../Player', 'Player12345678901']) {
    assert.equal(identities.resolve(firstServer, name), null);
  }
});

test('browser profile resolution rejects conflicting Java players and operator identities', (t) => {
  const identities = new BrowserIdentityRepository(fixture(t));
  const player = identities.resolve(firstServer, 'Alex');
  assert.ok(player);
  assert.deepEqual(identities.resolve(firstServer, 'Alex', [player]), player);
  assert.equal(identities.resolve(firstServer, 'Alex', [{ name: 'alex', operator: true, uuid: player.uuid }]), null);
  assert.equal(identities.resolve(firstServer, 'Alex', [{ name: 'SomeoneElse', operator: true, uuid: player.uuid }]), null);
  assert.equal(identities.resolve(firstServer, 'Alex', [{ name: 'aLeX', uuid: '33333333-3333-4333-8333-333333333333' }]), null);
  assert.equal(identities.resolve(firstServer, 'Owner', [{ name: 'OWNER', operator: true }]), null);
});

test('legacy named accounts and open players retain saved UUIDs, progress and canonical spelling', (t) => {
  const database = fixture(t);
  const existing = { name: 'np_River', uuid: '33333333-3333-4333-8333-333333333333' };
  const revoked = { name: 'np_Sky', uuid: '44444444-4444-4444-8444-444444444444' };
  const open = { name: 'np_Lake', uuid: '55555555-5555-4555-8555-555555555555' };
  database.exec(`
    CREATE TABLE browser_accounts (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE, uuid TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, revoked_at TEXT, UNIQUE (server_id, name)
    );
    CREATE TABLE browser_open_identities (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE,
      uuid TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY (server_id, name)
    );
  `);
  const insert = database.prepare('INSERT INTO browser_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  insert.run('legacy-active', firstServer, existing.name, existing.uuid, 'unused', 'unused', now, now, null);
  insert.run('legacy-revoked', firstServer, revoked.name, revoked.uuid, 'unused', 'unused', now, now, now);
  database.prepare('INSERT INTO browser_open_identities VALUES (?, ?, ?, ?)').run(firstServer, open.name, open.uuid, now);
  const identities = new BrowserIdentityRepository(database);
  for (const profile of [existing, revoked, open]) {
    assert.deepEqual(identities.resolve(firstServer, profile.name), profile);
    assert.deepEqual(identities.resolve(firstServer, profile.name.slice(3)), profile);
    assert.equal(identities.resolve(firstServer, profile.name.slice(3), [{ ...profile, operator: true }]), null);
  }
});
