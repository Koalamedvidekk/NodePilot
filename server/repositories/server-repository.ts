import type { SqliteDatabase } from '../db.js';
import {
  defaultServerStartupConfig,
  type InstallState,
  type ServerFlavor,
  type ServerRecord,
  type ServerSoftware,
  type ServerStartupConfig,
  type ServerStatus,
} from '../types.js';

type DatabaseServer = {
  id: string;
  machine_id: string;
  name: string;
  directory: string;
  game: 'minecraft-java';
  flavor: ServerFlavor;
  software: ServerSoftware;
  version: string;
  loader_version: string | null;
  startup_config: string | null;
  required_java_major: number | null;
  port: number;
  memory_mb: number;
  eula_accepted: number;
  status: ServerStatus;
  install_state: InstallState;
  java_path: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_started_at: string | null;
  last_stopped_at: string | null;
};

export interface CreateServerRow {
  id: string;
  machineId: string;
  name: string;
  directory: string;
  flavor: ServerFlavor;
  software?: ServerSoftware;
  version: string;
  loaderVersion?: string | null;
  startupConfig?: ServerStartupConfig;
  requiredJavaMajor: number | null;
  port: number;
  memoryMb: number;
  eulaAccepted: boolean;
}

export interface UpdateServerInput {
  name?: string;
  port?: number;
  memoryMb?: number;
  javaPath?: string | null;
  software?: ServerSoftware;
  loaderVersion?: string | null;
  startupConfig?: ServerStartupConfig;
}

export interface RuntimeConfigurationInput {
  software?: ServerSoftware;
  loaderVersion?: string | null;
  startupConfig: ServerStartupConfig;
}

const validSoftware = new Set<ServerSoftware>([
  'vanilla',
  'paper',
  'spigot',
  'purpur',
  'fabric',
  'forge',
  'neoforge',
  'quilt',
  'unknown',
]);

function cloneDefaultStartupConfig(): ServerStartupConfig {
  return {
    mode: 'jar',
    jarPath: defaultServerStartupConfig.mode === 'jar' ? defaultServerStartupConfig.jarPath : 'server.jar',
    gameArguments: [...defaultServerStartupConfig.gameArguments],
  };
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && !normalized.split('/').some((part) => part === '..');
}

function isSafeArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && !value.includes('\r') && !value.includes('\n');
}

function parseStartupConfig(value: unknown): ServerStartupConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const gameArguments = Array.isArray(candidate.gameArguments) && candidate.gameArguments.every(isSafeArgument)
    ? [...candidate.gameArguments]
    : null;
  if (!gameArguments) return null;

  if (candidate.mode === 'jar' && isSafeRelativePath(candidate.jarPath)) {
    return { mode: 'jar', jarPath: candidate.jarPath, gameArguments };
  }
  if (
    candidate.mode === 'arg-files' &&
    isSafeRelativePath(candidate.windowsArgFile) &&
    isSafeRelativePath(candidate.linuxArgFile) &&
    Array.isArray(candidate.jvmArgFiles) &&
    candidate.jvmArgFiles.every(isSafeRelativePath)
  ) {
    return {
      mode: 'arg-files',
      windowsArgFile: candidate.windowsArgFile,
      linuxArgFile: candidate.linuxArgFile,
      jvmArgFiles: [...candidate.jvmArgFiles],
      gameArguments,
    };
  }
  return null;
}

function readStartupConfig(value: string | null): ServerStartupConfig {
  if (!value) return cloneDefaultStartupConfig();
  try {
    return parseStartupConfig(JSON.parse(value)) ?? cloneDefaultStartupConfig();
  } catch {
    return cloneDefaultStartupConfig();
  }
}

function assertStartupConfig(value: ServerStartupConfig): ServerStartupConfig {
  const parsed = parseStartupConfig(value);
  if (!parsed) throw new Error('Invalid server startup configuration.');
  return parsed;
}

function serverFlavorForSoftware(software: ServerSoftware): ServerFlavor {
  // The original column intentionally remains a compact compatibility field until a future
  // schema migration can safely rebuild its historical CHECK constraint.
  return software === 'paper' ? 'paper' : 'vanilla';
}

function mapServer(row: DatabaseServer): ServerRecord {
  const software = validSoftware.has(row.software) ? row.software : row.flavor;
  return {
    id: row.id,
    machineId: row.machine_id,
    name: row.name,
    directory: row.directory,
    game: row.game,
    flavor: row.flavor,
    software,
    version: row.version,
    loaderVersion: row.loader_version,
    startupConfig: readStartupConfig(row.startup_config),
    requiredJavaMajor: row.required_java_major,
    port: row.port,
    memoryMb: row.memory_mb,
    eulaAccepted: row.eula_accepted === 1,
    status: row.status,
    installState: row.install_state,
    javaPath: row.java_path,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
  };
}

export class ServerRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(): ServerRecord[] {
    return (this.database
      .prepare('SELECT * FROM servers ORDER BY created_at DESC')
      .all() as DatabaseServer[]).map(mapServer);
  }

  find(id: string): ServerRecord | null {
    const row = this.database.prepare('SELECT * FROM servers WHERE id = ?').get(id) as
      | DatabaseServer
      | undefined;
    return row ? mapServer(row) : null;
  }

  create(input: CreateServerRow): ServerRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO servers (
          id, machine_id, name, directory, flavor, software, version, loader_version, startup_config, required_java_major, port, memory_mb, eula_accepted,
          status, install_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', 'installing', ?, ?)
      `)
      .run(
        input.id,
        input.machineId,
        input.name,
        input.directory,
        serverFlavorForSoftware(input.software ?? input.flavor),
        input.software ?? input.flavor,
        input.version,
        input.loaderVersion ?? null,
        JSON.stringify(assertStartupConfig(input.startupConfig ?? cloneDefaultStartupConfig())),
        input.requiredJavaMajor,
        input.port,
        input.memoryMb,
        input.eulaAccepted ? 1 : 0,
        now,
        now,
      );
    return this.require(input.id);
  }

  update(id: string, input: UpdateServerInput): ServerRecord {
    const current = this.require(id);
    const now = new Date().toISOString();
    const software = input.software ?? current.software;
    if (!validSoftware.has(software)) throw new Error('Invalid server software.');
    const startupConfig = input.startupConfig === undefined ? current.startupConfig : assertStartupConfig(input.startupConfig);
    this.database
      .prepare(`
        UPDATE servers
        SET name = ?, port = ?, memory_mb = ?, java_path = ?, flavor = ?, software = ?, loader_version = ?, startup_config = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.name ?? current.name,
        input.port ?? current.port,
        input.memoryMb ?? current.memoryMb,
        input.javaPath === undefined ? current.javaPath : input.javaPath,
        serverFlavorForSoftware(software),
        software,
        input.loaderVersion === undefined ? current.loaderVersion : input.loaderVersion,
        JSON.stringify(startupConfig),
        now,
        id,
      );
    return this.require(id);
  }

  setRuntimeConfiguration(id: string, input: RuntimeConfigurationInput): ServerRecord {
    const current = this.require(id);
    const software = input.software ?? current.software;
    if (!validSoftware.has(software)) throw new Error('Invalid server software.');
    const startupConfig = assertStartupConfig(input.startupConfig);
    this.database
      .prepare(`
        UPDATE servers
        SET flavor = ?, software = ?, loader_version = ?, startup_config = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        serverFlavorForSoftware(software),
        software,
        input.loaderVersion === undefined ? current.loaderVersion : input.loaderVersion,
        JSON.stringify(startupConfig),
        new Date().toISOString(),
        id,
      );
    return this.require(id);
  }

  setStatus(
    id: string,
    status: ServerStatus,
    options: {
      installState?: InstallState;
      lastError?: string | null;
      lastStartedAt?: string | null;
      lastStoppedAt?: string | null;
    } = {},
  ): ServerRecord {
    const current = this.require(id);
    this.database
      .prepare(`
        UPDATE servers
        SET status = ?, install_state = ?, last_error = ?, last_started_at = ?, last_stopped_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        options.installState ?? current.installState,
        options.lastError === undefined ? current.lastError : options.lastError,
        options.lastStartedAt === undefined ? current.lastStartedAt : options.lastStartedAt,
        options.lastStoppedAt === undefined ? current.lastStoppedAt : options.lastStoppedAt,
        new Date().toISOString(),
        id,
      );
    return this.require(id);
  }

  markReady(id: string): ServerRecord {
    return this.setStatus(id, 'offline', { installState: 'ready', lastError: null });
  }

  markInstallFailed(id: string, error: string): ServerRecord {
    return this.setStatus(id, 'error', { installState: 'failed', lastError: error });
  }

  markInterruptedProcessesOffline(): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE servers
         SET status = 'offline', updated_at = ?, last_error = CASE
           WHEN status IN ('running', 'starting', 'stopping') THEN 'NodePilot restarted; the previous process is no longer managed.'
           ELSE last_error
         END
         WHERE status IN ('running', 'starting', 'stopping')`,
      )
      .run(now);
  }

  portIsAssigned(port: number, exceptId?: string): boolean {
    const row = exceptId
      ? this.database.prepare('SELECT id FROM servers WHERE port = ? AND id != ?').get(port, exceptId)
      : this.database.prepare('SELECT id FROM servers WHERE port = ?').get(port);
    return Boolean(row);
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM servers WHERE id = ?').run(id);
  }

  getCache<T>(cacheKey: string, maxAgeMs: number): T | null {
    const row = this.database
      .prepare('SELECT payload, fetched_at FROM metadata_cache WHERE cache_key = ?')
      .get(cacheKey) as { payload: string; fetched_at: string } | undefined;
    if (!row || Date.now() - Date.parse(row.fetched_at) > maxAgeMs) return null;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  setCache(cacheKey: string, value: unknown): void {
    this.database
      .prepare(`
        INSERT INTO metadata_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
      `)
      .run(cacheKey, JSON.stringify(value), new Date().toISOString());
  }

  private require(id: string): ServerRecord {
    const result = this.find(id);
    if (!result) throw new Error(`Server ${id} does not exist.`);
    return result;
  }
}
