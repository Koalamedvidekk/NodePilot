import type { SqliteDatabase } from '../db.js';
import type { HostSettings } from '../types.js';

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  systemStartupEnabled: false,
  launchMode: 'headless',
  openBrowserOnStartup: false,
  continueRunningOnClose: true,
  updateIncludePrereleases: false,
  updateDismissedVersion: null,
  updateLastCheckedAt: null,
};

export class HostSettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getSettings(): HostSettings {
    const rows = this.database.prepare('SELECT key, value FROM host_settings').all() as Array<{
      key: string;
      value: string;
    }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.key, row.value);
    }

    return {
      systemStartupEnabled: map.get('system_startup_enabled') === 'true',
      launchMode: map.get('launch_mode') === 'windowed' ? 'windowed' : 'headless',
      openBrowserOnStartup: map.get('open_browser_on_startup') === 'true',
      continueRunningOnClose: map.has('continue_running_on_close')
        ? map.get('continue_running_on_close') === 'true'
        : true,
      updateIncludePrereleases: map.get('update_include_prereleases') === 'true',
      updateDismissedVersion: map.get('update_dismissed_version') || null,
      updateLastCheckedAt: map.get('update_last_checked_at') || null,
    };
  }

  saveSettings(settings: Partial<HostSettings>): HostSettings {
    const now = new Date().toISOString();
    const insertOrReplace = this.database.prepare(`
      INSERT INTO host_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    const transaction = this.database.transaction(() => {
      if (settings.systemStartupEnabled !== undefined) {
        insertOrReplace.run('system_startup_enabled', String(settings.systemStartupEnabled), now);
      }
      if (settings.launchMode !== undefined) {
        insertOrReplace.run('launch_mode', settings.launchMode, now);
      }
      if (settings.openBrowserOnStartup !== undefined) {
        insertOrReplace.run('open_browser_on_startup', String(settings.openBrowserOnStartup), now);
      }
      if (settings.continueRunningOnClose !== undefined) {
        insertOrReplace.run('continue_running_on_close', String(settings.continueRunningOnClose), now);
      }
      if (settings.updateIncludePrereleases !== undefined) {
        insertOrReplace.run('update_include_prereleases', String(settings.updateIncludePrereleases), now);
      }
      if (settings.updateDismissedVersion !== undefined) {
        insertOrReplace.run('update_dismissed_version', settings.updateDismissedVersion ?? '', now);
      }
      if (settings.updateLastCheckedAt !== undefined) {
        insertOrReplace.run('update_last_checked_at', settings.updateLastCheckedAt ?? '', now);
      }
    });

    transaction();
    return this.getSettings();
  }
}
