import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db.js';

interface BrowserIdentity {
  name: string;
  uuid: string;
}

export interface ReservedBrowserIdentity {
  name: string;
  uuid?: string;
  operator?: boolean;
}

/** Persistent game profiles for guest players. NodePilot stores no new credentials. */
export class BrowserIdentityRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        uuid TEXT NOT NULL UNIQUE,
        PRIMARY KEY (server_id, name)
      );
      CREATE TABLE IF NOT EXISTS browser_profile_aliases (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        alias TEXT NOT NULL COLLATE NOCASE,
        profile_uuid TEXT NOT NULL REFERENCES browser_profiles(uuid) ON DELETE CASCADE,
        PRIMARY KEY (server_id, alias)
      );
    `);
    this.database.transaction(() => {
      // Only legacy profiles received the np_ prefix automatically. Preserve their
      // old alias without treating a new user's chosen np_ name as an alias.
      for (const table of ['browser_accounts', 'browser_open_identities']) {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        database.exec(`
          INSERT OR IGNORE INTO browser_profiles (server_id, name, uuid)
            SELECT server_id, name, uuid FROM ${table};
          INSERT OR IGNORE INTO browser_profile_aliases (server_id, alias, profile_uuid)
            SELECT legacy.server_id, substr(legacy.name, 4), profile.uuid
            FROM ${table} AS legacy
            JOIN browser_profiles AS profile ON profile.server_id = legacy.server_id AND profile.name = legacy.name
            WHERE lower(substr(legacy.name, 1, 3)) = 'np_';
        `);
      }
    })();
  }

  resolve(serverId: string, name: string, reserved: ReservedBrowserIdentity[] = []): BrowserIdentity | null {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return null;
    const existing = this.database.prepare(`
      SELECT name, uuid FROM browser_profiles WHERE server_id = ? AND name = ?
      UNION ALL
      SELECT profile.name, profile.uuid FROM browser_profile_aliases alias
      JOIN browser_profiles profile ON profile.uuid = alias.profile_uuid AND profile.server_id = alias.server_id
      WHERE alias.server_id = ? AND alias.alias = ? LIMIT 1
    `).get(serverId, name, serverId, name) as BrowserIdentity | undefined;
    const profile = existing ?? { name, uuid: randomUUID() };
    const uuid = profile.uuid.replaceAll('-', '').toLowerCase();
    for (const entry of reserved) {
      const sameName = entry.name.toLowerCase() === profile.name.toLowerCase();
      const sameUuid = entry.uuid?.replaceAll('-', '').toLowerCase() === uuid;
      if (!sameName && !sameUuid) continue;
      // A reconnect to a cached guest is expected. Never hand out an operator
      // identity or a conflicting Java player's name/UUID on an unverified join.
      if (entry.operator || !existing || !sameName || !sameUuid) return null;
    }
    if (!existing) {
      this.database.prepare('INSERT INTO browser_profiles (server_id, name, uuid) VALUES (?, ?, ?)')
        .run(serverId, profile.name, profile.uuid);
    }
    return profile;
  }
}
