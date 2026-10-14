import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

export function openDatabase(databasePath: string): SqliteDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  database.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      directory TEXT NOT NULL UNIQUE,
      game TEXT NOT NULL DEFAULT 'minecraft-java',
      flavor TEXT NOT NULL CHECK (flavor IN ('vanilla', 'paper')),
      software TEXT NOT NULL DEFAULT 'unknown',
      version TEXT NOT NULL,
      loader_version TEXT,
      startup_config TEXT NOT NULL DEFAULT '{"mode":"jar","jarPath":"server.jar","gameArguments":["nogui"]}',
      required_java_major INTEGER,
      port INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1 AND 65535),
      memory_mb INTEGER NOT NULL CHECK (memory_mb BETWEEN 256 AND 65536),
      eula_accepted INTEGER NOT NULL DEFAULT 0 CHECK (eula_accepted IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'offline',
      install_state TEXT NOT NULL DEFAULT 'installing' CHECK (install_state IN ('installing', 'ready', 'failed')),
      java_path TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_started_at TEXT,
      last_stopped_at TEXT
    );

    CREATE INDEX IF NOT EXISTS servers_status_idx ON servers(status);

    CREATE TABLE IF NOT EXISTS metadata_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);

  // Keep development databases created by pre-release builds forwards compatible.
  const columns = database.prepare('PRAGMA table_info(servers)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'required_java_major')) {
    database.exec('ALTER TABLE servers ADD COLUMN required_java_major INTEGER');
  }
  if (!columns.some((column) => column.name === 'machine_id')) {
    database.exec("ALTER TABLE servers ADD COLUMN machine_id TEXT NOT NULL DEFAULT 'local'");
  }
  if (!columns.some((column) => column.name === 'software')) {
    database.exec("ALTER TABLE servers ADD COLUMN software TEXT NOT NULL DEFAULT 'unknown'");
    database.exec("UPDATE servers SET software = flavor WHERE software = 'unknown'");
  }
  if (!columns.some((column) => column.name === 'loader_version')) {
    database.exec('ALTER TABLE servers ADD COLUMN loader_version TEXT');
  }
  if (!columns.some((column) => column.name === 'startup_config')) {
    database.exec(
      `ALTER TABLE servers ADD COLUMN startup_config TEXT NOT NULL DEFAULT '{"mode":"jar","jarPath":"server.jar","gameArguments":["nogui"]}'`,
    );
  }

  if (!columns.some((column) => column.name === 'auto_start')) {
    database.exec("ALTER TABLE servers ADD COLUMN auto_start TEXT NOT NULL DEFAULT 'disabled'");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS addon_installs (
      server_id TEXT NOT NULL,
      addon_type TEXT NOT NULL CHECK (addon_type IN ('plugin', 'mod')),
      file_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('modrinth', 'hangar', 'upload', 'import')),
      project_id TEXT,
      version_id TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (server_id, addon_type, file_name),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS addon_installs_server_idx ON addon_installs(server_id);

    CREATE TABLE IF NOT EXISTS bridge_credentials (
      server_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS host_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return database;
}
