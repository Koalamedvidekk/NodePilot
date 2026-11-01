import type { SqliteDatabase } from '../db.js';

export interface ServerVersionSettings {
  serverId: string;
  autoUpdate: boolean;
  lastCheckedAt: string | null;
  latestVersion: string | null;
  lastError: string | null;
  lastBackupPath: string | null;
  updatedAt: string;
}

type Row = {
  server_id: string;
  auto_update: number;
  last_checked_at: string | null;
  latest_version: string | null;
  last_error: string | null;
  last_backup_path: string | null;
  updated_at: string;
};

function mapRow(row: Row): ServerVersionSettings {
  return {
    serverId: row.server_id,
    autoUpdate: row.auto_update === 1,
    lastCheckedAt: row.last_checked_at,
    latestVersion: row.latest_version,
    lastError: row.last_error,
    lastBackupPath: row.last_backup_path,
    updatedAt: row.updated_at,
  };
}

export class ServerVersionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  find(serverId: string): ServerVersionSettings | null {
    const row = this.database.prepare('SELECT * FROM server_version_settings WHERE server_id = ?').get(serverId) as Row | undefined;
    return row ? mapRow(row) : null;
  }

  getOrCreate(serverId: string): ServerVersionSettings {
    this.database.prepare(`
      INSERT INTO server_version_settings (server_id, auto_update, updated_at)
      VALUES (?, 0, ?) ON CONFLICT(server_id) DO NOTHING
    `).run(serverId, new Date().toISOString());
    return this.find(serverId)!;
  }

  save(serverId: string, input: Partial<Omit<ServerVersionSettings, 'serverId' | 'updatedAt'>>): ServerVersionSettings {
    const current = this.getOrCreate(serverId);
    const pick = <K extends keyof typeof input>(key: K) => input[key] === undefined ? current[key as keyof ServerVersionSettings] : input[key];
    this.database.prepare(`
      UPDATE server_version_settings SET auto_update = ?, last_checked_at = ?, latest_version = ?,
      last_error = ?, last_backup_path = ?, updated_at = ? WHERE server_id = ?
    `).run(
      (input.autoUpdate ?? current.autoUpdate) ? 1 : 0,
      pick('lastCheckedAt'), pick('latestVersion'), pick('lastError'), pick('lastBackupPath'),
      new Date().toISOString(), serverId,
    );
    return this.find(serverId)!;
  }

  enabledServerIds(): string[] {
    return (this.database.prepare('SELECT server_id FROM server_version_settings WHERE auto_update = 1').all() as Array<{ server_id: string }>).map((row) => row.server_id);
  }
}
