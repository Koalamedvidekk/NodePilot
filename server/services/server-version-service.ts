import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError, errorMessage } from '../lib/errors.js';
import { isInside, resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import { ServerVersionRepository } from '../repositories/server-version-repository.js';
import type { MinecraftVersion, ServerRecord } from '../types.js';
import type { JavaService } from './java-service.js';
import type { InstalledServerRuntime } from './minecraft-service.js';

const CHECK_INTERVAL_MS = 60 * 60_000;
const RUN_INTERVAL_MS = 60_000;
const MAX_COPY_FILES = 250_000;
const MAX_COPY_BYTES = 64 * 1024 * 1024 * 1024;
const SUPPORTED = new Set(['vanilla', 'paper', 'spigot', 'purpur', 'fabric', 'quilt', 'forge', 'neoforge', 'bedrock']);
const USER_FILES = new Set(['server.properties', 'eula.txt', 'ops.json', 'whitelist.json', 'allowlist.json', 'permissions.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'user_jvm_args.txt']);
const USER_DIRECTORIES = new Set(['world', 'world_nether', 'world_the_end', 'worlds', 'plugins', 'mods', 'config', 'defaultconfigs', 'logs', 'crash-reports']);

interface VersionMinecraftService {
  getVersions(software: ServerRecord['software']): Promise<MinecraftVersion[]>;
  getRequiredJavaMajor(software: ServerRecord['software'], version: string): Promise<number | null>;
  assertVersionAvailable(software: ServerRecord['software'], version: string): Promise<void>;
  stageRuntime(server: ServerRecord, directory: string): Promise<InstalledServerRuntime>;
}

export interface ServerVersionStatus {
  serverId: string;
  currentVersion: string;
  software: ServerRecord['software'];
  versions: MinecraftVersion[];
  latestVersion: string | null;
  updateAvailable: boolean;
  autoUpdate: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastBackupPath: string | null;
  busy: boolean;
  phase: string | null;
  automaticUpdateBlockedReason: string | null;
  warnings: string[];
  supported: boolean;
  unsupportedReason: string | null;
}

export function isStableMinecraftVersion(value: string): boolean {
  return value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
}

export function compareMinecraftVersions(left: string, right: string): number {
  if (!isStableMinecraftVersion(left) || !isStableMinecraftVersion(right)) throw new Error('Minecraft release versions must be numeric.');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? 0n;
    const second = b[index] ?? 0n;
    if (first !== second) return first > second ? 1 : -1;
  }
  return 0;
}

async function checkedTree(root: string): Promise<Array<{ relative: string; directory: boolean; mode: number }>> {
  const base = await realpath(root);
  const result: Array<{ relative: string; directory: boolean; mode: number }> = [];
  let bytes = 0;
  const walk = async (relative: string) => {
    for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      const absolute = path.join(base, next);
      const details = await lstat(absolute);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
        throw new AppError(409, 'unsafe_version_file', 'Version changes refuse symbolic links, junctions, and special files. Remove the linked file before retrying.');
      }
      if (!isInside(base, await realpath(absolute))) throw new AppError(409, 'unsafe_version_file', 'A server file escapes its directory.');
      result.push({ relative: next, directory: details.isDirectory(), mode: details.mode });
      bytes += details.isFile() ? details.size : 0;
      if (result.length > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
        throw new AppError(413, 'version_backup_too_large', 'The server exceeds the version-change backup limit of 250,000 entries or 64 GB.');
      }
      if (details.isDirectory()) await walk(next);
    }
  };
  await walk('');
  return result;
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await checkedTree(source);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    const target = path.join(destination, entry.relative);
    if (entry.directory) await mkdir(target, { recursive: false });
    else {
      await copyFile(path.join(source, entry.relative), target, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') await chmod(target, entry.mode & 0o777);
    }
  }
}

async function hasAddons(root: string): Promise<boolean> {
  for (const folder of ['plugins', 'mods']) {
    const target = path.join(root, folder);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) return true;
    if ((await checkedTree(target)).some((entry) => !entry.directory && entry.relative.toLowerCase().endsWith('.jar'))) return true;
  }
  return false;
}

async function overlayRuntime(runtimeRoot: string, candidateRoot: string, worldName: string | undefined): Promise<void> {
  const runtime = await checkedTree(runtimeRoot);
  for (const entry of runtime) {
    const normalized = entry.relative.replaceAll('\\', '/');
    const top = normalized.split('/')[0];
    if (USER_DIRECTORIES.has(top) || (worldName && top === worldName)) continue;
    const protectedFile = USER_FILES.has(normalized);
    const target = path.join(candidateRoot, entry.relative);
    if (protectedFile && await lstat(target).then(() => true, () => false)) continue;
    if (entry.directory) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(runtimeRoot, entry.relative), target);
      if (process.platform !== 'win32') await chmod(target, entry.mode & 0o777);
    }
  }
}

export class ServerVersionService {
  private readonly phases = new Map<string, string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly automaticAttempts = new Map<string, number>();
  private automaticRun: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly config: { serversDirectory: string; backupsDirectory: string },
    private readonly servers: ServerRepository,
    private readonly minecraft: VersionMinecraftService,
    private readonly java: Pick<JavaService, 'findUsable'>,
    private readonly runtime: { isProcessActive(id: string): boolean },
    private readonly settings: ServerVersionRepository,
    private readonly shouldPause: () => boolean = () => false,
  ) {}

  isBusy(serverId: string): boolean { return this.phases.has(serverId); }
  anyBusy(): boolean { return this.phases.size > 0; }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.startupTimer = setTimeout(() => void this.runAutomaticChecks(), 15_000);
    this.startupTimer.unref();
    this.timer = setInterval(() => void this.runAutomaticChecks(), RUN_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    await this.automaticRun;
    await Promise.allSettled([...this.tasks]);
  }

  private requireServer(id: string): ServerRecord {
    const server = this.servers.find(id);
    if (!server) throw new AppError(404, 'server_not_found', 'The server does not exist.');
    return server;
  }

  private supported(server: ServerRecord): boolean { return SUPPORTED.has(server.software); }

  private assertStopped(server: ServerRecord): void {
    if (this.runtime.isProcessActive(server.id) || ['starting', 'running', 'stopping', 'installing'].includes(server.status)) {
      throw new AppError(409, 'server_active', 'Stop the server before changing its Minecraft version. Automatic updates wait until it is stopped.');
    }
    if (server.installState !== 'ready') throw new AppError(409, 'server_not_ready', 'Only successfully installed servers can change versions.');
    if (this.shouldPause()) throw new AppError(409, 'panel_update_in_progress', 'Wait for the NodePilot application update to finish before changing a game server version.');
  }

  private async status(id: string, versions: MinecraftVersion[] = []): Promise<ServerVersionStatus> {
    const server = this.requireServer(id);
    const settings = this.settings.getOrCreate(id);
    const supported = this.supported(server);
    let blockedReason: string | null = null;
    let addons = false;
    try {
      const root = await resolveManagedServerRoot(this.config.serversDirectory, server.directory);
      addons = await hasAddons(root);
      if (addons) blockedReason = 'Automatic Minecraft upgrades are paused because this server has plugins or mods. Check add-on compatibility and change the version manually.';
    } catch (error) { blockedReason = errorMessage(error); }
    if (!isStableMinecraftVersion(server.version)) blockedReason = 'Automatic updates require a normal numeric Minecraft release version.';
    if (!supported) blockedReason = 'This imported or unknown server software does not have a supported installer.';
    return {
      serverId: id, currentVersion: server.version, software: server.software, versions,
      latestVersion: settings.latestVersion,
      updateAvailable: Boolean(settings.latestVersion && isStableMinecraftVersion(server.version) && compareMinecraftVersions(settings.latestVersion, server.version) > 0),
      autoUpdate: settings.autoUpdate, lastCheckedAt: settings.lastCheckedAt, lastError: settings.lastError,
      lastBackupPath: settings.lastBackupPath, busy: this.isBusy(id), phase: this.phases.get(id) ?? null,
      automaticUpdateBlockedReason: blockedReason,
      warnings: [
        'A full backup is made before switching versions. Newer worlds may not work in older Minecraft versions; a downgrade does not convert the world.',
        ...(addons ? ['Existing plugins and mods are preserved, but may need different versions for the selected Minecraft release.'] : []),
        'Automatic updates use stable Minecraft releases and apply only while the server is stopped; NodePilot never stops an active server to update it.',
      ],
      supported, unsupportedReason: supported ? null : 'Version management is unavailable for unknown server software. Confirm its software implementation before changing versions.',
    };
  }

  async getStatus(id: string): Promise<ServerVersionStatus> { return this.loadStatus(id, false); }

  async check(id: string): Promise<ServerVersionStatus> { return this.loadStatus(id, true); }

  private async loadStatus(id: string, clearPreviousError: boolean): Promise<ServerVersionStatus> {
    const server = this.requireServer(id);
    if (!this.supported(server)) return this.status(id);
    let versions: MinecraftVersion[] = [];
    try {
      versions = (await this.minecraft.getVersions(server.software))
        .filter((version) => version.available && version.type === 'release' && isStableMinecraftVersion(version.id))
        .sort((left, right) => compareMinecraftVersions(right.id, left.id));
      this.settings.save(id, { lastCheckedAt: new Date().toISOString(), latestVersion: versions[0]?.id ?? null, ...(clearPreviousError ? { lastError: null } : {}) });
    } catch (error) {
      this.settings.save(id, { lastCheckedAt: new Date().toISOString(), lastError: errorMessage(error) });
    }
    return this.status(id, versions);
  }

  async setAutoUpdate(id: string, enabled: boolean): Promise<ServerVersionStatus> {
    const server = this.requireServer(id);
    if (enabled && !this.supported(server)) throw new AppError(422, 'version_updates_unsupported', 'Automatic version updates are unavailable for this server software.');
    this.settings.save(id, { autoUpdate: enabled });
    if (enabled) this.automaticAttempts.delete(id);
    const status = await this.check(id);
    if (enabled) setTimeout(() => void this.runAutomaticChecks(), 0).unref();
    return status;
  }

  changeVersion(id: string, version: string, options: { confirm: true; automatic?: boolean }): Promise<ServerVersionStatus> {
    if (this.isBusy(id)) return Promise.reject(new AppError(409, 'version_change_in_progress', 'A version change is already running for this server.'));
    if (options.confirm !== true) return Promise.reject(new AppError(400, 'version_confirmation_required', 'Confirm the version change and backup before continuing.'));
    this.phases.set(id, 'checking');
    const task = this.applyVersion(id, version, options.automatic === true).then((status) => ({ ...status, busy: false, phase: null })).finally(() => {
      this.phases.delete(id);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return task;
  }

  private async applyVersion(id: string, version: string, automatic: boolean): Promise<ServerVersionStatus> {
    let work: string | undefined;
    let originalRoot: string | undefined;
    let movedOriginal: string | undefined;
    let committed = false;
    let incompleteBackup: string | undefined;
    try {
      const server = this.requireServer(id);
      if (!this.supported(server)) throw new AppError(422, 'version_updates_unsupported', 'This server software has no supported version installer.');
      if (!isStableMinecraftVersion(version)) throw new AppError(400, 'invalid_minecraft_version', 'Choose a stable Minecraft release version from the available list.');
      this.assertStopped(server);
      if (version === server.version) return this.status(id);
      if (automatic && (!isStableMinecraftVersion(server.version) || compareMinecraftVersions(version, server.version) <= 0)) {
        throw new AppError(409, 'automatic_downgrade_refused', 'Automatic updates never downgrade a Minecraft server.');
      }
      originalRoot = await resolveManagedServerRoot(this.config.serversDirectory, server.directory);
      if (automatic && await hasAddons(originalRoot)) throw new AppError(409, 'addon_compatibility_required', 'Check plugin and mod compatibility, then change this Minecraft version manually.');
      await this.minecraft.assertVersionAvailable(server.software, version);
      const requiredJavaMajor = await this.minecraft.getRequiredJavaMajor(server.software, version);
      const usableJava = server.software === 'bedrock' ? null : await this.java.findUsable(requiredJavaMajor, server.javaPath);
      if (server.software !== 'bedrock' && !usableJava) {
        throw new AppError(422, 'java_missing', 'Minecraft ' + version + ' requires a compatible Java runtime' + (requiredJavaMajor ? ' (Java ' + requiredJavaMajor + ')' : '') + '. Install it before changing versions.');
      }
      this.assertStopped(this.requireServer(id));
      const token = Date.now().toString(36) + '-' + randomUUID();
      const serverBase = await realpath(this.config.serversDirectory);
      work = path.join(serverBase, '.nodepilot-version-' + token);
      await mkdir(work, { recursive: false, mode: 0o700 });
      await mkdir(this.config.backupsDirectory, { recursive: true });
      const backupBase = await realpath(this.config.backupsDirectory);
      const backup = path.join(backupBase, server.directory + '-minecraft-' + token);
      this.phases.set(id, 'backing_up');
      incompleteBackup = backup;
      await copyTree(originalRoot, backup);
      incompleteBackup = undefined;
      this.settings.save(id, { lastBackupPath: backup, lastError: null });
      await writeFile(backup + '.json', JSON.stringify({ serverId: id, version: server.version, startupConfig: server.startupConfig, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });

      this.phases.set(id, 'downloading');
      const runtimeRoot = path.join(work, 'runtime');
      await mkdir(runtimeRoot, { recursive: false });
      const javaPath = usableJava?.installation.path ?? null;
      const installed = await this.minecraft.stageRuntime({ ...server, version, requiredJavaMajor, javaPath }, runtimeRoot);
      const candidate = path.join(work, 'candidate');
      this.phases.set(id, 'preparing');
      await copyTree(originalRoot, candidate);
      const propertyText = await readFile(path.join(originalRoot, 'server.properties'), 'utf8').catch(() => '');
      const worldName = propertyText.match(/^\s*level-name\s*=\s*(.+)\s*$/m)?.[1]?.trim();
      await overlayRuntime(runtimeRoot, candidate, worldName);
      this.assertStopped(this.requireServer(id));
      // Re-resolve just before the swap: a directory replaced by a local junction
      // during a long installer must never become a rename/delete target.
      const resolvedAgain = await resolveManagedServerRoot(this.config.serversDirectory, server.directory);
      if (resolvedAgain !== originalRoot) throw new AppError(409, 'server_directory_changed', 'The server directory changed during version installation.');
      this.phases.set(id, 'applying');
      const previous = path.join(work, 'previous');
      await rename(originalRoot, previous);
      movedOriginal = previous;
      try {
        await rename(candidate, originalRoot);
      } catch (error) {
        await rename(movedOriginal, originalRoot);
        movedOriginal = undefined;
        throw error;
      }
      this.servers.updateVersion(id, {
        version, requiredJavaMajor, javaPath, software: installed.software,
        loaderVersion: installed.loaderVersion, startupConfig: installed.startupConfig,
      });
      committed = true;
      this.settings.save(id, { lastError: null });
      return this.status(id);
    } catch (error) {
      if (!committed && movedOriginal && originalRoot) {
        const failedCandidate = path.join(work!, 'failed-candidate');
        try {
          if (await lstat(originalRoot).then(() => true, () => false)) await rename(originalRoot, failedCandidate);
          await rename(movedOriginal, originalRoot);
          movedOriginal = undefined;
        } catch (rollbackError) {
          // Keep all work directories when restoration is blocked (e.g. antivirus)
          // so the user's original files remain recoverable alongside the backup.
          work = undefined;
          const message = 'Version change failed and automatic rollback could not finish: ' + errorMessage(rollbackError) + '. Restore the recorded full backup before starting the server.';
          this.servers.markInstallFailed(id, message);
          this.settings.save(id, { lastError: message });
          throw new AppError(500, 'version_rollback_failed', message);
        }
      }
      this.settings.save(id, { lastError: errorMessage(error) });
      throw error;
    } finally {
      if (incompleteBackup) await rm(incompleteBackup, { recursive: true, force: true }).catch(() => undefined);
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async runAutomaticChecks(): Promise<void> {
    if (this.automaticRun) return this.automaticRun;
    if (this.stopping || this.shouldPause()) return;
    const task = this.automaticChecksInternal().catch(() => undefined).finally(() => { if (this.automaticRun === task) this.automaticRun = null; });
    this.automaticRun = task;
    return task;
  }

  private async automaticChecksInternal(): Promise<void> {
    for (const id of this.settings.enabledServerIds()) {
      if (this.stopping || this.shouldPause()) return;
      if (this.isBusy(id)) continue;
      const lastAttempt = this.automaticAttempts.get(id);
      if (lastAttempt && Date.now() - lastAttempt < CHECK_INTERVAL_MS) continue;
      try {
        let settings = this.settings.find(id)!;
        if (!settings.lastCheckedAt || Date.now() - Date.parse(settings.lastCheckedAt) >= CHECK_INTERVAL_MS) {
          await this.check(id);
          settings = this.settings.find(id)!;
          if (settings.lastError) {
            this.automaticAttempts.set(id, Date.now());
            continue;
          }
        }
        const server = this.requireServer(id);
        if (!settings.autoUpdate || !settings.latestVersion || !isStableMinecraftVersion(server.version) || compareMinecraftVersions(settings.latestVersion, server.version) <= 0) continue;
        if (this.runtime.isProcessActive(id) || ['running', 'starting', 'stopping', 'installing'].includes(server.status)) continue;
        const status = await this.status(id);
        if (status.automaticUpdateBlockedReason) continue;
        // Bound installer retries independently of status-page polling. A failed
        // attempt must not copy another full world backup on every minute tick.
        this.automaticAttempts.set(id, Date.now());
        await this.changeVersion(id, settings.latestVersion, { confirm: true, automatic: true });
      } catch (error) {
        try { this.settings.save(id, { lastError: errorMessage(error) }); } catch { /* A deleted server needs no background retry record. */ }
      }
    }
  }
}
