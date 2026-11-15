import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { openDatabase } from '../db.js';
import { AppError } from '../lib/errors.js';
import { BrowserAccountRepository } from '../repositories/browser-account-repository.js';
import { ServerRepository } from '../repositories/server-repository.js';

const firstServer = '11111111-1111-4111-8111-111111111111';
const secondServer = '22222222-2222-4222-8222-222222222222';
const firstPassword = 'correct-browser-password';
const secondPassword = 'replacement-browser-password';

function fixture(t: TestContext) {
  const database = openDatabase(':memory:');
  const servers = new ServerRepository(database);
  for (const [index, id] of [firstServer, secondServer].entries()) {
    servers.create({ id, machineId: 'local', name: 'Browser fixture', directory: `browser-fixture-${index}`,
      software: 'paper', version: '1.21.4', port: 25565 + index, memoryMb: 1024, eulaAccepted: true });
  }
  t.after(() => database.close());
  return { database, accounts: new BrowserAccountRepository(database) };
}

test('browser account identities persist, remain server scoped, and never expose credentials', async (t) => {
  const { database, accounts } = fixture(t);
  const account = await accounts.create(firstServer, { name: 'Alex', password: firstPassword });
  assert.equal(account.name, 'np_Alex');
  assert.match(account.uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(accounts.list(secondServer), []);
  assert.equal(JSON.stringify(account).includes(firstPassword), false);
  assert.equal('password_hash' in account, false);
  assert.equal('password_salt' in accounts.list(firstServer)[0], false);
  const persisted = new BrowserAccountRepository(database);
  assert.equal(persisted.list(firstServer)[0].uuid, account.uuid);
  assert.deepEqual(await persisted.verify(firstServer, 'NP_ALEX', firstPassword), { name: account.name, uuid: account.uuid });
  assert.equal(await persisted.verify(secondServer, account.name, firstPassword), null);
  assert.equal(await persisted.verify(firstServer, account.name, secondPassword), null);
  const other = await accounts.create(secondServer, { name: 'Alex', password: firstPassword });
  assert.notEqual(other.uuid, account.uuid);
  const stored = database.prepare('SELECT password_salt, password_hash FROM browser_accounts WHERE id = ?').get(account.id) as { password_salt: string; password_hash: string };
  assert.match(stored.password_salt, /^[a-f0-9]{64}$/);
  assert.match(stored.password_hash, /^[a-f0-9]{128}$/);
  assert.equal(stored.password_hash.includes(firstPassword), false);
});

test('invalid browser names, weak passwords, reserved identities and concurrent duplicates are rejected', async (t) => {
  const { accounts } = fixture(t);
  await assert.rejects(accounts.create(firstServer, { name: '../Alex', password: firstPassword }), { code: 'invalid_browser_name' });
  await assert.rejects(accounts.create(firstServer, { name: 'abcdefghijklmn', password: firstPassword }), { code: 'invalid_browser_name' });
  for (const password of ['short', ' '.repeat(10), 'x'.repeat(128), 'invalid-surrogate-\ud800']) {
    await assert.rejects(accounts.create(firstServer, { name: 'Alex', password }), { code: 'invalid_browser_password' });
  }
  await assert.rejects(accounts.create(firstServer, { name: 'Alex', password: firstPassword }, [{ name: 'NP_ALEX' }]), { code: 'browser_identity_reserved' });
  const results = await Promise.allSettled([
    accounts.create(firstServer, { name: 'Alex', password: firstPassword }),
    accounts.create(firstServer, { name: 'alex', password: secondPassword }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as AppError).code, 'browser_account_exists');
  assert.equal(accounts.list(firstServer).length, 1);
});

test('browser passwords fit the client packet boundary and preserve Unicode', async (t) => {
  const { accounts } = fixture(t);
  const password = '界'.repeat(83) + '😀';
  assert.equal(Buffer.byteLength(password, 'utf8'), 253);
  const account = await accounts.create(firstServer, { name: 'Unicode', password });
  assert.deepEqual(await accounts.verify(firstServer, account.name, password), { name: account.name, uuid: account.uuid });
  await assert.rejects(accounts.resetPassword(firstServer, account.id, '界'.repeat(86)), { code: 'invalid_browser_password' });
  const longest = 'x'.repeat(127);
  await accounts.resetPassword(firstServer, account.id, longest);
  assert.ok(await accounts.verify(firstServer, account.name, longest));
});

test('password resets and revocation preserve UUIDs and cannot cross server boundaries', async (t) => {
  const { accounts } = fixture(t);
  const account = await accounts.create(firstServer, { name: 'Alex', password: firstPassword });
  await assert.rejects(accounts.resetPassword(secondServer, account.id, secondPassword), { code: 'browser_account_not_found' });
  assert.throws(() => accounts.revoke(secondServer, account.id), { code: 'browser_account_not_found' });
  const updated = await accounts.resetPassword(firstServer, account.id, secondPassword);
  assert.equal(updated.uuid, account.uuid);
  assert.equal(await accounts.verify(firstServer, account.name, firstPassword), null);
  assert.deepEqual(await accounts.verify(firstServer, account.name, secondPassword), { name: account.name, uuid: account.uuid });
  const pendingVerification = accounts.verify(firstServer, account.name, secondPassword);
  const revoked = accounts.revoke(firstServer, account.id);
  assert.ok(revoked.revokedAt);
  assert.equal(await pendingVerification, null);
  assert.equal(await accounts.verify(firstServer, account.name, secondPassword), null);
  await assert.rejects(accounts.resetPassword(firstServer, account.id, firstPassword), { code: 'browser_account_revoked' });
});

test('a concurrent revocation wins over an in-flight password reset', async (t) => {
  const { accounts } = fixture(t);
  const account = await accounts.create(firstServer, { name: 'Alex', password: firstPassword });
  const resetting = accounts.resetPassword(firstServer, account.id, secondPassword);
  accounts.revoke(firstServer, account.id);
  await assert.rejects(resetting, { code: 'browser_account_changed' });
});

test('failed browser logins are throttled and password hashing has a bounded concurrency budget', async (t) => {
  const { accounts } = fixture(t);
  const attempts = Array.from({ length: 5 }, () => accounts.verify(firstServer, 'np_missing', firstPassword));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value === null).length, 4);
  const busy = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal((busy.reason as AppError).code, 'browser_auth_busy');
  for (let index = 0; index < 5; index += 1) assert.equal(await accounts.verify(firstServer, 'np_missing', firstPassword), null);
  await assert.rejects(accounts.verify(firstServer, 'np_missing', firstPassword), { code: 'browser_auth_rate_limited' });
  assert.equal(await accounts.verify(secondServer, 'np_missing', firstPassword), null);
});
