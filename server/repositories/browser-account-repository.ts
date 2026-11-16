import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

import type { SqliteDatabase } from '../db.js';
import { AppError } from '../lib/errors.js';

const hashBytes = 64;
const hashOptions = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = randomBytes(32).toString('hex');
const dummyHash = randomBytes(hashBytes);
const maximumConcurrentHashes = 4;
const attemptWindowMs = 60_000;
const maximumAttemptBuckets = 5_000;
let activeHashes = 0;

export interface BrowserAccount {
  id: string;
  serverId: string;
  name: string;
  uuid: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ReservedBrowserIdentity {
  name: string;
  uuid?: string;
}

interface AccountRow {
  id: string;
  server_id: string;
  name: string;
  uuid: string;
  password_salt: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

function summary(row: AccountRow): BrowserAccount {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    uuid: row.uuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function validPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 4 && password.length <= 127
    && Boolean(password.trim()) && Buffer.byteLength(password, 'utf8') <= 255
    && Buffer.from(password, 'utf8').toString('utf8') === password;
}

function validatePassword(password: string): void {
  if (!validPassword(password)) {
    throw new AppError(400, 'invalid_browser_password', 'Use 4–127 characters within the browser client’s 255-byte password limit. Shorten passwords containing many Unicode characters.');
  }
}

async function derivePassword(password: string, salt: string): Promise<Buffer> {
  if (activeHashes >= maximumConcurrentHashes) {
    throw new AppError(503, 'browser_auth_busy', 'Browser account authentication is busy. Try again shortly.');
  }
  activeHashes += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, hashBytes, hashOptions, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  } finally {
    activeHashes -= 1;
  }
}

/** Browser identities have their own stable UUIDs and never inherit a Java account's UUID. */
export class BrowserAccountRepository {
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly database: SqliteDatabase) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_accounts (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        uuid TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (server_id, name)
      );
      CREATE INDEX IF NOT EXISTS browser_accounts_server_idx ON browser_accounts(server_id);
    `);
  }

  list(serverId: string): BrowserAccount[] {
    const rows = this.database.prepare('SELECT * FROM browser_accounts WHERE server_id = ? ORDER BY name COLLATE NOCASE').all(serverId) as AccountRow[];
    return rows.map(summary);
  }

  async create(
    serverId: string,
    input: { name: string; password: string },
    reservedIdentities: ReservedBrowserIdentity[] = [],
  ): Promise<BrowserAccount> {
    if (typeof input.name !== 'string' || !/^[A-Za-z0-9_]{1,13}$/.test(input.name)) {
      throw new AppError(400, 'invalid_browser_name', 'Use 1–13 letters, numbers, or underscores. Browser login names receive the np_ prefix.');
    }
    validatePassword(input.password);
    const name = `np_${input.name}`;
    const uuid = randomUUID();
    if (reservedIdentities.some((identity) => identity.name.toLowerCase() === name.toLowerCase()
      || identity.uuid?.replaceAll('-', '').toLowerCase() === uuid.replaceAll('-', ''))) {
      throw new AppError(409, 'browser_identity_reserved', 'That browser identity conflicts with an existing Java player or operator. Choose another name.');
    }
    this.requireServer(serverId);
    if (this.findByName(serverId, name)) {
      throw new AppError(409, 'browser_account_exists', 'A browser account with that name already exists.');
    }

    const salt = randomBytes(32).toString('hex');
    const hash = await derivePassword(input.password, salt);
    const now = new Date().toISOString();
    const id = randomUUID();
    // Another create can finish hashing first, so check again while holding SQLite's write transaction.
    this.database.transaction(() => {
      this.requireServer(serverId);
      if (this.findByName(serverId, name)) {
        throw new AppError(409, 'browser_account_exists', 'A browser account with that name already exists.');
      }
      this.database.prepare(`INSERT INTO browser_accounts
        (id, server_id, name, uuid, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, serverId, name, uuid, salt, hash.toString('hex'), now, now);
    })();
    return summary(this.requireAccount(serverId, id));
  }

  async resetPassword(serverId: string, accountId: string, password: string): Promise<BrowserAccount> {
    validatePassword(password);
    const account = this.requireAccount(serverId, accountId);
    if (account.revoked_at) throw new AppError(409, 'browser_account_revoked', 'This browser account has been revoked.');
    const salt = randomBytes(32).toString('hex');
    const hash = await derivePassword(password, salt);
    const result = this.database.prepare(`UPDATE browser_accounts SET password_salt = ?, password_hash = ?, updated_at = ?
      WHERE server_id = ? AND id = ? AND password_hash = ? AND revoked_at IS NULL`).run(
      salt, hash.toString('hex'), new Date().toISOString(), serverId, accountId, account.password_hash,
    );
    if (result.changes !== 1) throw new AppError(409, 'browser_account_changed', 'This browser account changed. Refresh and try again.');
    return summary(this.requireAccount(serverId, accountId));
  }

  revoke(serverId: string, accountId: string): BrowserAccount {
    this.requireAccount(serverId, accountId);
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE browser_accounts SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE server_id = ? AND id = ?`).run(now, now, serverId, accountId);
    return summary(this.requireAccount(serverId, accountId));
  }

  async verify(serverId: string, name: string, password: string): Promise<{ name: string; uuid: string } | null> {
    if (typeof name !== 'string' || !/^np_[A-Za-z0-9_]{1,13}$/i.test(name)
      || !validPassword(password)) return null;
    this.consumeAttempt(`server:${serverId}`, 120);
    this.consumeAttempt(`account:${serverId}:${name.toLowerCase()}`, 10);
    const account = this.findByName(serverId, name);
    const salt = account?.password_salt ?? dummySalt;
    const actual = await derivePassword(password, salt);
    const expected = account ? Buffer.from(account.password_hash, 'hex') : dummyHash;
    const valid = expected.length === hashBytes && timingSafeEqual(actual, expected);
    if (!valid || !account || account.revoked_at) return null;
    // Revocation and password reset must take effect even during asynchronous password hashing.
    const fresh = this.findByName(serverId, name);
    if (!fresh || fresh.revoked_at || fresh.password_hash !== account.password_hash) return null;
    return { name: account.name, uuid: account.uuid };
  }

  private consumeAttempt(key: string, maximum: number): void {
    const now = Date.now();
    for (const [entryKey, entry] of this.attempts) if (entry.expiresAt <= now) this.attempts.delete(entryKey);
    let entry = this.attempts.get(key);
    if (!entry) {
      if (this.attempts.size >= maximumAttemptBuckets) {
        throw new AppError(429, 'browser_auth_rate_limited', 'Too many browser login attempts. Try again in a minute.');
      }
      entry = { count: 0, expiresAt: now + attemptWindowMs };
      this.attempts.set(key, entry);
    }
    if (entry.count >= maximum) throw new AppError(429, 'browser_auth_rate_limited', 'Too many browser login attempts. Try again in a minute.');
    entry.count += 1;
  }

  private findByName(serverId: string, name: string): AccountRow | undefined {
    return this.database.prepare('SELECT * FROM browser_accounts WHERE server_id = ? AND name = ? COLLATE NOCASE').get(serverId, name) as AccountRow | undefined;
  }

  private requireAccount(serverId: string, accountId: string): AccountRow {
    const row = this.database.prepare('SELECT * FROM browser_accounts WHERE server_id = ? AND id = ?').get(serverId, accountId) as AccountRow | undefined;
    if (!row) throw new AppError(404, 'browser_account_not_found', 'This browser account was not found.');
    return row;
  }

  private requireServer(serverId: string): void {
    if (!this.database.prepare('SELECT id FROM servers WHERE id = ?').get(serverId)) {
      throw new AppError(404, 'server_not_found', 'This server was not found.');
    }
  }
}
