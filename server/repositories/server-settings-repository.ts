import type { SqliteDatabase } from '../db.js';
import type { ServerSettingsRecord, ServerSettingsInput } from '../types.js';

interface DatabaseServerSettings {
  server_id: string;
  auto_wake: number;
  wake_proxy_port: number | null;
  auto_sleep: number;
  idle_timeout_minutes: number;
  min_memory_mb: number | null;
  custom_jvm_args: string | null;
  shutdown_timeout_seconds: number;
  created_at: string;
  updated_at: string;
}

function parseCustomJvmArgs(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function mapRow(row: DatabaseServerSettings): ServerSettingsRecord {
  return {
    serverId: row.server_id,
    autoWake: row.auto_wake === 1,
    wakeProxyPort: row.wake_proxy_port,
    autoSleep: row.auto_sleep === 1,
    idleTimeoutMinutes: row.idle_timeout_minutes,
    minMemoryMb: row.min_memory_mb,
    customJvmArgs: parseCustomJvmArgs(row.custom_jvm_args),
    shutdownTimeoutSeconds: row.shutdown_timeout_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ServerSettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  find(serverId: string): ServerSettingsRecord | null {
    const row = this.database
      .prepare('SELECT * FROM server_settings WHERE server_id = ?')
      .get(serverId) as DatabaseServerSettings | undefined;
    return row ? mapRow(row) : null;
  }

  getOrCreate(serverId: string): ServerSettingsRecord {
    const existing = this.find(serverId);
    if (existing) return existing;

    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO server_settings (
          server_id, auto_wake, wake_proxy_port, auto_sleep, idle_timeout_minutes,
          min_memory_mb, custom_jvm_args, shutdown_timeout_seconds, created_at, updated_at
        ) VALUES (?, 0, NULL, 0, 15, NULL, '[]', 20, ?, ?)
        ON CONFLICT(server_id) DO NOTHING
      `)
      .run(serverId, now, now);

    return this.find(serverId) ?? {
      serverId,
      autoWake: false,
      wakeProxyPort: null,
      autoSleep: false,
      idleTimeoutMinutes: 15,
      minMemoryMb: null,
      customJvmArgs: [],
      shutdownTimeoutSeconds: 20,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(serverId: string, input: Partial<ServerSettingsInput>): ServerSettingsRecord {
    const current = this.getOrCreate(serverId);
    const now = new Date().toISOString();

    const autoWake = input.autoWake !== undefined ? (input.autoWake ? 1 : 0) : current.autoWake ? 1 : 0;
    const wakeProxyPort = input.wakeProxyPort !== undefined ? input.wakeProxyPort : current.wakeProxyPort;
    const autoSleep = input.autoSleep !== undefined ? (input.autoSleep ? 1 : 0) : current.autoSleep ? 1 : 0;
    const idleTimeoutMinutes =
      input.idleTimeoutMinutes !== undefined ? input.idleTimeoutMinutes : current.idleTimeoutMinutes;
    const minMemoryMb = input.minMemoryMb !== undefined ? input.minMemoryMb : current.minMemoryMb;
    const customJvmArgs =
      input.customJvmArgs !== undefined
        ? JSON.stringify(input.customJvmArgs)
        : JSON.stringify(current.customJvmArgs);
    const shutdownTimeoutSeconds =
      input.shutdownTimeoutSeconds !== undefined
        ? input.shutdownTimeoutSeconds
        : current.shutdownTimeoutSeconds;

    this.database
      .prepare(`
        UPDATE server_settings
        SET auto_wake = ?, wake_proxy_port = ?, auto_sleep = ?, idle_timeout_minutes = ?,
            min_memory_mb = ?, custom_jvm_args = ?, shutdown_timeout_seconds = ?, updated_at = ?
        WHERE server_id = ?
      `)
      .run(
        autoWake,
        wakeProxyPort,
        autoSleep,
        idleTimeoutMinutes,
        minMemoryMb,
        customJvmArgs,
        shutdownTimeoutSeconds,
        now,
        serverId,
      );

    return this.getOrCreate(serverId);
  }

  resetSection(serverId: string, section: 'auto-wake' | 'auto-sleep' | 'java' | 'startup'): ServerSettingsRecord {
    const current = this.getOrCreate(serverId);
    const patch: Partial<ServerSettingsInput> = {};

    switch (section) {
      case 'auto-wake':
        patch.autoWake = false;
        patch.wakeProxyPort = null;
        break;
      case 'auto-sleep':
        patch.autoSleep = false;
        patch.idleTimeoutMinutes = 15;
        break;
      case 'java':
        patch.minMemoryMb = null;
        patch.customJvmArgs = [];
        break;
      case 'startup':
        patch.shutdownTimeoutSeconds = 20;
        break;
    }

    return this.update(serverId, patch);
  }

  delete(serverId: string): void {
    this.database.prepare('DELETE FROM server_settings WHERE server_id = ?').run(serverId);
  }
}
