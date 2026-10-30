import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

import { AppError } from '../lib/errors.js';
import { cleanVersion, compareSemVer, isNewerVersion, parseSemVer } from '../lib/semver.js';
import type { HostSettingsRepository } from '../repositories/host-settings-repository.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import type {
  ParsedChangelog,
  ReleaseAssetInfo,
  UpdateInstallStatus,
  UpdateReleaseInfo,
  UpdateStatusState,
} from '../types.js';

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const CACHE_TTL_MS = 15 * 60 * 1_000;
const MIN_CHECK_COOLDOWN_MS = 10 * 1_000;
const REQUEST_TIMEOUT_MS = 20 * 1_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_GITHUB_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1 * 1024 * 1024;
const MAX_UPDATE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 25_000;
const MAX_COMPRESSION_RATIO = 100;
const MIN_FREE_DISK_BYTES = 1_024 * 1_024 * 1_024;
const UPDATE_REMINDER_SNOOZE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REPOSITORY = 'Koalamedvidekk/NodePilot';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const TRUSTED_GITHUB_ASSET_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const PROTECTED_PACKAGE_PATH_SEGMENTS = new Set(['.nodepilot', '.git', 'node_modules', '.env']);

export interface UpdateAssetCandidate {
  name: string;
  apiUrl: string;
  browserDownloadUrl: string;
  size: number;
  contentType: string;
}

interface GitHubRelease {
  tagName: string;
  name: string | null;
  publishedAt: string;
  isPrerelease: boolean;
  isDraft: boolean;
  htmlUrl: string;
  body: string;
  assets: UpdateAssetCandidate[];
}

interface PreparedUpdate {
  version: string;
  workspaceDirectory: string;
  sourceDirectory: string;
  archivePath: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  files: string[];
}

interface AutoInstallAvailability {
  canAutoInstall: boolean;
  reason: string | null;
}

/** Wait for the helper's own initialization before allowing the panel to exit. */
export async function waitForUpdateHelper(child: ChildProcess, readyFile: string, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null) => finish(new Error('The update helper exited before it was ready (exit ' + code + '). NodePilot was kept running.'));
    const inspect = async () => {
      try {
        const status = JSON.parse(await readFile(readyFile, 'utf8')) as { ready?: boolean; pid?: number };
        if (status.ready === true && status.pid === child.pid) finish();
      } catch {
        // The helper may not yet have created or finished writing its marker.
      }
    };
    const poll = setInterval(() => void inspect(), 100);
    const deadline = setTimeout(() => finish(new Error('The update helper did not become ready. NodePilot was kept running; inspect .nodepilot/updates/helper.log.')), timeoutMs);
    child.once('error', failed);
    child.once('exit', exited);
    if (child.exitCode !== null) exited(child.exitCode);
    else void inspect();
  });
}

function assetInfo(asset: UpdateAssetCandidate): ReleaseAssetInfo {
  // The GitHub API asset URL is deliberately retained instead of an arbitrary browser URL.
  // Downloads are followed manually through a narrow GitHub-owned host allowlist.
  return {
    name: asset.name,
    downloadUrl: asset.apiUrl,
    size: asset.size,
    contentType: asset.contentType,
  };
}

export function parseChangelog(bodyText: string): ParsedChangelog {
  const features: string[] = [];
  const improvements: string[] = [];
  const bugFixes: string[] = [];
  if (!bodyText || typeof bodyText !== 'string') {
    return { features, improvements, bugFixes, rawNotes: '' };
  }

  let section: 'features' | 'improvements' | 'fixes' | 'other' = 'other';
  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#{1,4}\s+/i.test(line)) {
      const heading = line.replace(/^#{1,4}\s+/i, '').toLowerCase();
      if (heading.includes('feature') || heading.includes('added') || heading.includes("what's new")) {
        section = 'features';
      } else if (heading.includes('fix') || heading.includes('bug')) {
        section = 'fixes';
      } else if (heading.includes('improve') || heading.includes('change') || heading.includes('update')) {
        section = 'improvements';
      } else {
        section = 'other';
      }
      continue;
    }

    const item = line.match(/^[-*+]\s+(.*)$/)?.[1]
      ?.replace(/\s+in\s+https:\/\/github\.com\/[^\s]+/gi, '')
      .replace(/\s+by\s+@[a-zA-Z0-9_-]+/gi, '')
      .trim();
    if (!item) continue;

    if (section === 'features') features.push(item);
    else if (section === 'fixes') bugFixes.push(item);
    else if (section === 'improvements') improvements.push(item);
    else {
      const lower = item.toLowerCase();
      if (lower.startsWith('add') || lower.startsWith('feat') || lower.includes('support')) features.push(item);
      else if (lower.startsWith('fix') || lower.includes('bug') || lower.includes('resolve')) bugFixes.push(item);
      else improvements.push(item);
    }
  }

  return { features, improvements, bugFixes, rawNotes: bodyText.trim() };
}

export function normalizeGithubRepository(value: string): string | null {
  const candidate = value.trim();
  const [owner, repository, ...rest] = candidate.split('/');
  if (
    rest.length > 0
    || !owner
    || !repository
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(owner)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)
  ) {
    return null;
  }
  return `${owner}/${repository}`;
}

export function isTrustedGitHubAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && TRUSTED_GITHUB_ASSET_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Converts a ZIP entry into a portable, safe relative path. */
export function safeArchiveRelativePath(fileName: string): string | null {
  if (!fileName || fileName.length > 1_024 || /[\x00-\x1f]/.test(fileName) || fileName.includes('\\')) return null;
  const withoutTrailingSlash = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
  if (!withoutTrailingSlash || withoutTrailingSlash.startsWith('/') || /^[A-Za-z]:/.test(withoutTrailingSlash)) return null;
  const parts = withoutTrailingSlash.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function extractExpectedSha256(
  checksumContent: string,
  archiveName: string,
  allowBareHash = false,
): string | null {
  const bare = checksumContent.trim();
  if (allowBareHash && /^[a-fA-F0-9]{64}$/.test(bare)) return bare.toLowerCase();

  for (const line of checksumContent.split(/\r?\n/)) {
    const standard = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (standard && path.posix.basename(standard[2].trim()) === archiveName) return standard[1].toLowerCase();

    const reversed = line.trim().match(/^(.+?):\s*([a-fA-F0-9]{64})$/);
    if (reversed && path.posix.basename(reversed[1].trim()) === archiveName) return reversed[2].toLowerCase();
  }
  return null;
}

export function selectReleaseAssets(
  version: string,
  assets: UpdateAssetCandidate[],
): { packageAsset?: ReleaseAssetInfo; checksumAsset?: ReleaseAssetInfo } {
  const archiveName = `nodepilot-v${cleanVersion(version)}-universal.zip`;
  const packageAsset = assets.find((asset) =>
    asset.name === archiveName && asset.size > 0 && asset.size <= MAX_UPDATE_ARCHIVE_BYTES,
  );
  if (!packageAsset) return {};

  const checksumAsset = assets.find((asset) => asset.name === `${archiveName}.sha256`)
    ?? assets.find((asset) => asset.name.toLowerCase() === 'sha256sums.txt');
  return {
    packageAsset: assetInfo(packageAsset),
    checksumAsset: checksumAsset ? assetInfo(checksumAsset) : undefined,
  };
}

function isZipSymlink(entry: yauzl.Entry): boolean {
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function assertWithinDirectory(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new AppError(422, 'unsafe_update_archive', message);
  }
}

function isSupportedPlatform(): boolean {
  return process.platform === 'win32' || process.platform === 'linux';
}

export class UpdateService {
  private readonly currentVersion: string;
  private readonly updatesDirectory: string;
  private readonly sourceCheckout: boolean;
  private lastCheckTime = 0;
  private checkPromise: Promise<UpdateStatusState> | null = null;
  private isInstalling = false;
  private restartScheduled = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private preparedUpdate: PreparedUpdate | null = null;
  private statusState: UpdateStatusState;

  constructor(
    private readonly dataDirectory: string,
    private readonly projectRoot: string,
    private readonly hostSettings: HostSettingsRepository,
    private readonly servers: ServerRepository,
  ) {
    this.updatesDirectory = path.join(this.dataDirectory, 'updates');
    this.currentVersion = this.resolveCurrentVersion();
    this.sourceCheckout = existsSync(path.join(this.projectRoot, '.git'));
    const settings = this.hostSettings.getSettings();
    this.statusState = {
      currentVersion: this.currentVersion,
      isUpdateAvailable: false,
      availableRelease: null,
      lastCheckedAt: settings.updateLastCheckedAt ?? null,
      checkError: null,
      status: 'idle',
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      statusMessage: null,
      error: null,
      includePrereleases: Boolean(settings.updateIncludePrereleases),
      canAutoInstall: false,
      unattendedSupported: isSupportedPlatform(),
      dismissedVersion: settings.updateDismissedVersion ?? null,
      snoozedVersion: settings.updateSnoozedVersion ?? null,
      snoozedUntil: settings.updateSnoozedUntil ?? null,
      autoInstallReason: null,
    };
    this.updateAutoInstallAvailability();
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      void this.checkForUpdates(false).catch(() => undefined);
    }, 10_000);
    this.startupTimer.unref();
    this.checkTimer = setInterval(() => {
      void this.checkForUpdates(false).catch(() => undefined);
    }, CHECK_INTERVAL_MS);
    this.checkTimer.unref();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.startupTimer = null;
    this.checkTimer = null;
  }

  getStatus(): UpdateStatusState {
    const settings = this.hostSettings.getSettings();
    this.statusState.includePrereleases = Boolean(settings.updateIncludePrereleases);
    this.statusState.dismissedVersion = settings.updateDismissedVersion ?? null;
    this.statusState.snoozedVersion = settings.updateSnoozedVersion ?? null;
    this.statusState.snoozedUntil = settings.updateSnoozedUntil ?? null;
    this.updateAutoInstallAvailability();
    return { ...this.statusState };
  }

  isRestartScheduled(): boolean {
    return this.restartScheduled;
  }

  dismissAvailableRelease(): void {
    const release = this.statusState.availableRelease;
    if (!release || !this.statusState.isUpdateAvailable) {
      throw new AppError(409, 'no_update_to_dismiss', 'There is no available update to dismiss.');
    }
    this.hostSettings.saveSettings({
      updateDismissedVersion: release.version,
      updateSnoozedVersion: null,
      updateSnoozedUntil: null,
    });
    this.statusState.dismissedVersion = release.version;
    this.statusState.snoozedVersion = null;
    this.statusState.snoozedUntil = null;
    this.statusState.isUpdateAvailable = false;
    this.statusState.statusMessage = `Update v${release.version} was dismissed.`;
    this.updateAutoInstallAvailability();
  }

  /**
   * Keeps an available release visible in Host Settings while silencing only the
   * automatic browser reminder for one day. The version is persisted so a newer
   * release is never hidden behind an old reminder choice.
   */
  snoozeAvailableRelease(): void {
    const release = this.statusState.availableRelease;
    if (!release || !this.statusState.isUpdateAvailable) {
      throw new AppError(409, 'no_update_to_snooze', 'There is no available update to postpone.');
    }

    const until = new Date(Date.now() + UPDATE_REMINDER_SNOOZE_MS).toISOString();
    this.hostSettings.saveSettings({
      updateSnoozedVersion: release.version,
      updateSnoozedUntil: until,
    });
    this.statusState.snoozedVersion = release.version;
    this.statusState.snoozedUntil = until;
    this.statusState.statusMessage = `Update v${release.version} reminder postponed for 24 hours.`;
  }

  setIncludePrereleases(include: boolean): void {
    this.hostSettings.saveSettings({
      updateIncludePrereleases: include,
      updateDismissedVersion: null,
      updateSnoozedVersion: null,
      updateSnoozedUntil: null,
    });
    this.statusState.includePrereleases = include;
    this.statusState.dismissedVersion = null;
    this.statusState.snoozedVersion = null;
    this.statusState.snoozedUntil = null;
    this.lastCheckTime = 0;
  }

  async checkForUpdates(force = false): Promise<UpdateStatusState> {
    if (this.checkPromise) return this.checkPromise;
    const now = Date.now();
    if (!force && now - this.lastCheckTime < CACHE_TTL_MS) return this.getStatus();
    if (force && now - this.lastCheckTime < MIN_CHECK_COOLDOWN_MS) return this.getStatus();

    const checkPromise = this.performUpdateCheck(now);
    this.checkPromise = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (this.checkPromise === checkPromise) this.checkPromise = null;
    }
  }

  private async performUpdateCheck(now: number): Promise<UpdateStatusState> {
    this.statusState.status = 'checking';
    this.statusState.statusMessage = 'Checking GitHub for published releases…';
    this.statusState.checkError = null;
    this.statusState.error = null;

    try {
      const repository = normalizeGithubRepository(process.env.NODEPILOT_REPO ?? DEFAULT_REPOSITORY);
      if (!repository) {
        throw new AppError(400, 'invalid_update_repository', 'NODEPILOT_REPO must use the owner/repository format.');
      }
      const response = await this.fetchGitHubResponse(
        `${GITHUB_API_ORIGIN}/repos/${repository}/releases?per_page=20`,
        'application/vnd.github+json',
        REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) throw await this.githubApiError(response, repository);

      const releases = this.parseReleaseList(await this.readResponseText(response, MAX_GITHUB_JSON_BYTES));
      const includePrereleases = Boolean(this.hostSettings.getSettings().updateIncludePrereleases);
      const eligible = releases
        .filter((release) => !release.isDraft && (includePrereleases || !release.isPrerelease))
        .filter((release) => parseSemVer(release.tagName) !== null)
        .sort((left, right) => compareSemVer(right.tagName, left.tagName));

      const checkedAt = new Date().toISOString();
      this.lastCheckTime = now;
      this.hostSettings.saveSettings({ updateLastCheckedAt: checkedAt });
      this.statusState.lastCheckedAt = checkedAt;
      if (eligible.length === 0) {
        this.statusState.availableRelease = null;
        this.statusState.isUpdateAvailable = false;
        this.statusState.status = 'idle';
        this.statusState.statusMessage = 'No published NodePilot releases were found.';
        return this.getStatus();
      }

      const latest = eligible[0];
      const version = cleanVersion(latest.tagName);
      const selectedAssets = selectReleaseAssets(version, latest.assets);
      const release: UpdateReleaseInfo = {
        version,
        rawTag: latest.tagName,
        name: latest.name || `NodePilot v${version}`,
        publishedAt: latest.publishedAt,
        isPrerelease: latest.isPrerelease,
        htmlUrl: latest.htmlUrl,
        body: latest.body,
        changelog: parseChangelog(latest.body),
        asset: selectedAssets.packageAsset,
        checksumAsset: selectedAssets.checksumAsset,
      };
      const dismissed = this.hostSettings.getSettings().updateDismissedVersion;
      const newer = isNewerVersion(version, this.currentVersion);
      this.statusState.availableRelease = release;
      this.statusState.isUpdateAvailable = newer && dismissed !== version;
      this.statusState.status = 'idle';
      this.statusState.statusMessage = !newer
        ? `NodePilot is up to date (v${this.currentVersion}).`
        : dismissed === version
          ? `Update v${version} was dismissed.`
          : `Update available: v${version}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check for updates.';
      this.statusState.status = 'error';
      this.statusState.error = message;
      this.statusState.checkError = message;
      this.statusState.statusMessage = message;
    } finally {
      this.updateAutoInstallAvailability();
    }
    return this.getStatus();
  }

  /** Downloads, verifies, and extracts a release without restarting the process. */
  async prepareUpdate(): Promise<{ ok: true; status: UpdateInstallStatus; message: string }> {
    if (this.isInstalling || this.restartScheduled) {
      throw new AppError(409, 'update_in_progress', 'An update is already being prepared or applied.');
    }
    if (!this.statusState.availableRelease || !this.statusState.isUpdateAvailable) {
      await this.checkForUpdates(true);
    }
    const release = this.statusState.availableRelease;
    const availability = this.getAutoInstallAvailability();
    if (!release || !this.statusState.isUpdateAvailable) {
      throw new AppError(404, 'no_update_found', 'No newer NodePilot release is available to install.');
    }
    if (!availability.canAutoInstall) {
      throw new AppError(409, 'auto_update_unavailable', availability.reason ?? 'Automatic update is unavailable.');
    }
    if (!release.asset || !release.checksumAsset) {
      throw new AppError(422, 'missing_update_artifacts', 'The release does not include the required package and SHA-256 checksum assets.');
    }

    const activeServers = this.servers.list().filter((server) => ['starting', 'running', 'stopping'].includes(server.status));
    if (activeServers.length > 0) {
      throw new AppError(
        409,
        'active_servers',
        `Stop ${activeServers.length === 1 ? 'the active server' : 'all active servers'} before updating NodePilot. This prevents an updater restart from interrupting game data.`,
      );
    }

    this.isInstalling = true;
    this.preparedUpdate = null;
    const workspaceDirectory = path.join(this.updatesDirectory, 'staged', `${release.version}-${crypto.randomUUID()}`);
    const archivePath = path.join(workspaceDirectory, release.asset.name);
    try {
      await this.ensureSufficientDiskSpace(release.asset.size);
      await mkdir(workspaceDirectory, { recursive: true });

      this.statusState.status = 'verifying';
      this.statusState.statusMessage = 'Reading the release checksum…';
      const expectedHash = await this.downloadExpectedChecksum(release.checksumAsset, release.asset.name);

      this.statusState.status = 'downloading';
      this.statusState.statusMessage = `Downloading NodePilot v${release.version}…`;
      this.statusState.totalBytes = release.asset.size;
      this.statusState.downloadedBytes = 0;
      this.statusState.progressPercent = 0;
      await this.downloadAsset(release.asset, archivePath);

      this.statusState.status = 'verifying';
      this.statusState.statusMessage = 'Verifying the SHA-256 checksum…';
      if (await this.computeSha256(archivePath) !== expectedHash) {
        throw new AppError(422, 'checksum_mismatch', 'The downloaded update does not match its published SHA-256 checksum. Nothing was installed.');
      }

      this.statusState.status = 'extracting';
      this.statusState.statusMessage = 'Inspecting and staging the verified release…';
      const extractedDirectory = path.join(workspaceDirectory, 'payload');
      await this.extractZipSafely(archivePath, extractedDirectory);
      const sourceDirectory = await this.validateStagedRelease(extractedDirectory, release.version);

      this.preparedUpdate = { version: release.version, workspaceDirectory, sourceDirectory, archivePath };
      this.statusState.status = 'ready_to_restart';
      this.statusState.statusMessage = 'Update verified and staged. NodePilot will now restart to apply it.';
      this.statusState.progressPercent = 100;
      return { ok: true, status: 'ready_to_restart', message: this.statusState.statusMessage };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Update preparation failed.';
      this.statusState.status = 'error';
      this.statusState.error = message;
      this.statusState.statusMessage = message;
      this.preparedUpdate = null;
      await rm(workspaceDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.isInstalling = false;
      this.updateAutoInstallAvailability();
    }
  }

  /** Starts the detached helper. The owning Fastify app must close immediately afterwards. */
  async launchPreparedUpdate(): Promise<void> {
    if (!this.preparedUpdate) throw new AppError(409, 'update_not_prepared', 'No verified update is ready to apply.');
    if (this.restartScheduled) return;

    const activeServers = this.servers.list().filter((server) => ['starting', 'running', 'stopping'].includes(server.status));
    if (activeServers.length > 0) {
      throw new AppError(
        409,
        'active_servers',
        `Stop ${activeServers.length === 1 ? 'the active server' : 'all active servers'} before updating NodePilot. This prevents an updater restart from interrupting game data.`,
      );
    }

    const prepared = this.preparedUpdate;
    // Run the helper from the verified stage rather than the installation being
    // replaced. This avoids overwriting a running script on Windows and ensures
    // the helper itself came from the checksum-verified release.
    const helper = path.join(prepared.sourceDirectory, 'scripts', process.platform === 'win32' ? 'apply-update.ps1' : 'apply-update.sh');
    if (!existsSync(helper)) {
      throw new AppError(500, 'updater_missing', 'The verified update helper is missing. Reinstall NodePilot from a verified release.');
    }
    const backupDirectory = path.join(this.updatesDirectory, 'backups', `pre-${this.currentVersion}-${Date.now()}`);
    const readyFile = path.join(this.updatesDirectory, 'helper-ready-' + crypto.randomUUID() + '.json');
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ParentPid', String(process.pid), '-StagedDir', prepared.sourceDirectory, '-TargetDir', this.projectRoot, '-UpdateRoot', this.updatesDirectory, '-BackupDir', backupDirectory, '-ReadyFile', readyFile]
      : [helper, '--parent-pid', String(process.pid), '--staged-dir', prepared.sourceDirectory, '--target-dir', this.projectRoot, '--update-root', this.updatesDirectory, '--backup-dir', backupDirectory, '--ready-file', readyFile];
    const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';

    try {
      this.restartScheduled = true;
      this.statusState.status = 'restarting';
      this.statusState.statusMessage = 'Starting the verified update helper…';
      await mkdir(this.updatesDirectory, { recursive: true });
      const log = await open(path.join(this.updatesDirectory, 'helper.log'), 'a', 0o600);
      try {
        const child = spawn(command, args, { cwd: this.projectRoot, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
        const readiness = waitForUpdateHelper(child, readyFile);
        child.unref();
        await readiness;
        this.statusState.statusMessage = 'Applying the verified update and restarting NodePilot…';
      } finally {
        await log.close();
      }
    } catch (error) {
      this.markRestartFailed(error);
      throw error;
    } finally {
      await unlink(readyFile).catch(() => undefined);
    }
  }

  markRestartFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : 'The update helper could not be started.';
    this.restartScheduled = false;
    this.statusState.status = 'error';
    this.statusState.error = message;
    this.statusState.statusMessage = message;
  }

  private getAutoInstallAvailability(): AutoInstallAvailability {
    if (!isSupportedPlatform()) return { canAutoInstall: false, reason: 'Automatic updates are currently supported on Windows and Linux only.' };
    if (this.sourceCheckout) return { canAutoInstall: false, reason: 'This is a Git checkout. Use Git to update it so local source changes are never overwritten.' };
    if (!this.statusState.isUpdateAvailable) return { canAutoInstall: false, reason: null };
    if (!this.statusState.availableRelease?.asset) return { canAutoInstall: false, reason: 'This release is missing the required universal ZIP package.' };
    if (!this.statusState.availableRelease.checksumAsset) return { canAutoInstall: false, reason: 'This release is missing its required SHA-256 checksum file.' };
    return { canAutoInstall: true, reason: null };
  }

  private updateAutoInstallAvailability(): void {
    const availability = this.getAutoInstallAvailability();
    this.statusState.canAutoInstall = availability.canAutoInstall;
    this.statusState.autoInstallReason = availability.reason;
    this.statusState.unattendedSupported = isSupportedPlatform();
  }

  private async ensureSufficientDiskSpace(archiveSize: number): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const required = Math.max(MIN_FREE_DISK_BYTES, archiveSize * 3);
    try {
      const info = await statfs(this.dataDirectory);
      const free = Number(info.bavail) * Number(info.bsize);
      if (Number.isFinite(free) && free < required) {
        throw new AppError(507, 'insufficient_disk_space', `At least ${(required / 1024 / 1024).toFixed(0)} MB of free space is required to stage this update.`);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // statfs is not available on a few network filesystems. Archive limits still apply.
    }
  }

  private async downloadExpectedChecksum(checksumAsset: ReleaseAssetInfo, archiveName: string): Promise<string> {
    const response = await this.fetchGitHubResponse(checksumAsset.downloadUrl, 'application/octet-stream', REQUEST_TIMEOUT_MS);
    if (!response.ok) throw await this.githubAssetError(response, checksumAsset.name);
    const content = await this.readResponseText(response, MAX_CHECKSUM_BYTES);
    const expected = extractExpectedSha256(content, archiveName, checksumAsset.name.endsWith('.sha256'));
    if (!expected) {
      throw new AppError(422, 'checksum_missing', `The checksum file does not contain a SHA-256 value for ${archiveName}. Nothing was installed.`);
    }
    return expected;
  }

  private async downloadAsset(asset: ReleaseAssetInfo, destination: string): Promise<void> {
    if (asset.size <= 0 || asset.size > MAX_UPDATE_ARCHIVE_BYTES) {
      throw new AppError(422, 'invalid_update_asset', 'The release archive has an unsupported size.');
    }
    const response = await this.fetchGitHubResponse(asset.downloadUrl, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS);
    if (!response.ok || !response.body) throw await this.githubAssetError(response, asset.name);

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_UPDATE_ARCHIVE_BYTES) {
      throw new AppError(413, 'update_too_large', 'The release archive exceeds the maximum supported size.');
    }
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    let downloaded = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        downloaded += chunk.length;
        if (downloaded > MAX_UPDATE_ARCHIVE_BYTES) {
          callback(new AppError(413, 'update_too_large', 'The release archive exceeds the maximum supported size.'));
          return;
        }
        this.statusState.downloadedBytes = downloaded;
        this.statusState.totalBytes = contentLength > 0 ? contentLength : asset.size;
        if (this.statusState.totalBytes > 0) {
          this.statusState.progressPercent = Math.min(99, Math.round((downloaded / this.statusState.totalBytes) * 100));
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      if (downloaded !== asset.size) {
        throw new AppError(422, 'unexpected_update_size', 'The downloaded archive size differs from the published release asset.');
      }
      this.statusState.downloadedBytes = downloaded;
      this.statusState.progressPercent = 100;
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  private async extractZipSafely(archivePath: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const archive = await yauzl.openPromise(archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });

    let entries = 0;
    let extractedBytes = 0;
    const seen = new Set<string>();
    try {
      for await (const entry of archive.eachEntry()) {
        entries += 1;
        if (entries > MAX_ARCHIVE_ENTRIES) throw new AppError(422, 'unsafe_update_archive', 'The update archive contains too many files.');
        if ((entry.generalPurposeBitFlag & 0x1) !== 0 || isZipSymlink(entry)) {
          throw new AppError(422, 'unsafe_update_archive', 'Encrypted archives and symbolic links are not allowed in updates.');
        }
        const relativePath = safeArchiveRelativePath(entry.fileName);
        if (!relativePath) throw new AppError(422, 'unsafe_update_archive', 'The update archive contains an unsafe path.');
        const collisionKey = relativePath.toLocaleLowerCase('en-US');
        if (seen.has(collisionKey)) throw new AppError(422, 'unsafe_update_archive', 'The update archive contains colliding file paths.');
        seen.add(collisionKey);

        const target = path.resolve(destination, ...relativePath.split('/'));
        assertWithinDirectory(destination, target, 'The update archive attempted to write outside its staging directory.');
        if (entry.fileName.endsWith('/')) {
          await mkdir(target, { recursive: true });
          continue;
        }
        const uncompressedSize = Number(entry.uncompressedSize);
        const compressedSize = Number(entry.compressedSize);
        if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
          throw new AppError(422, 'unsafe_update_archive', 'The update archive contains an invalid file size.');
        }
        extractedBytes += uncompressedSize;
        if (extractedBytes > MAX_EXTRACTED_BYTES) throw new AppError(422, 'unsafe_update_archive', 'The update archive expands beyond the allowed size.');
        if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
          throw new AppError(422, 'unsafe_update_archive', 'The update archive has an unsafe compression ratio.');
        }

        await mkdir(path.dirname(target), { recursive: true });
        const source = await archive.openReadStreamPromise(entry);
        await pipeline(source, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      }
    } finally {
      archive.close();
    }
  }

  private async validateStagedRelease(extractedDirectory: string, version: string): Promise<string> {
    const roots = [extractedDirectory];
    for (const entry of await readdir(extractedDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(extractedDirectory, entry.name));
    }
    const candidates: string[] = [];
    for (const root of roots) {
      try {
        await access(path.join(root, 'nodepilot-release.json'));
        candidates.push(root);
      } catch {
        // Not an archive root.
      }
    }
    if (candidates.length !== 1) {
      throw new AppError(422, 'invalid_update_layout', 'The release archive must contain exactly one NodePilot release manifest.');
    }

    const root = candidates[0];
    let manifest: ReleaseManifest;
    try {
      manifest = JSON.parse(await readFile(path.join(root, 'nodepilot-release.json'), 'utf8')) as ReleaseManifest;
    } catch {
      throw new AppError(422, 'invalid_update_manifest', 'The release manifest is invalid.');
    }
    if (manifest.schemaVersion !== 1 || cleanVersion(manifest.version ?? '') !== cleanVersion(version) || !Array.isArray(manifest.files)) {
      throw new AppError(422, 'invalid_update_manifest', 'The release manifest does not match the selected release.');
    }
    if (manifest.files.length === 0 || manifest.files.length > MAX_ARCHIVE_ENTRIES) {
      throw new AppError(422, 'invalid_update_manifest', 'The release manifest contains an invalid file list.');
    }

    const manifestFiles = new Set<string>();
    for (const entry of manifest.files) {
      const safePath = typeof entry === 'string' ? safeArchiveRelativePath(entry) : null;
      const segments = safePath?.split('/');
      if (
        !safePath
        || !segments
        || segments.some((segment) => PROTECTED_PACKAGE_PATH_SEGMENTS.has(segment.toLocaleLowerCase('en-US')))
        || manifestFiles.has(safePath.toLocaleLowerCase('en-US'))
      ) {
        throw new AppError(422, 'invalid_update_manifest', 'The release manifest contains an unsafe or duplicate path.');
      }
      const filePath = path.resolve(root, ...safePath.split('/'));
      assertWithinDirectory(root, filePath, 'The release manifest points outside the staged package.');
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) throw new AppError(422, 'invalid_update_manifest', `The release package is missing ${safePath}.`);
      manifestFiles.add(safePath.toLocaleLowerCase('en-US'));
    }
    for (const required of [
      'package.json',
      'package-lock.json',
      'server/index.ts',
      'scripts/bootstrap.ps1',
      'scripts/bootstrap.sh',
      'scripts/apply-update.ps1',
      'scripts/apply-update.sh',
      'start.bat',
      'start.sh',
    ]) {
      if (!manifestFiles.has(required)) {
        throw new AppError(422, 'invalid_update_manifest', `The release package is missing required file ${required}.`);
      }
    }

    const actualFiles = await this.listStagedFiles(root, root);
    for (const file of actualFiles) {
      if (file === 'nodepilot-release.json') continue;
      if (!manifestFiles.has(file.toLocaleLowerCase('en-US'))) {
        throw new AppError(422, 'invalid_update_manifest', `The release package contains an unlisted file: ${file}.`);
      }
    }
    return root;
  }

  private async listStagedFiles(root: string, directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listStagedFiles(root, child));
      } else if (entry.isFile()) {
        const relative = path.relative(root, child).split(path.sep).join('/');
        const safePath = safeArchiveRelativePath(relative);
        if (!safePath) throw new AppError(422, 'invalid_update_manifest', 'The release package contains an unsafe path.');
        files.push(safePath);
      } else {
        throw new AppError(422, 'invalid_update_manifest', 'The release package contains an unsupported filesystem entry.');
      }
    }
    return files;
  }

  private async fetchGitHubResponse(url: string, accept: string, timeoutMs: number): Promise<Response> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new AppError(400, 'invalid_update_url', 'The release metadata supplied an invalid asset URL.');
    }
    if (!isTrustedGitHubAssetUrl(current.toString())) {
      throw new AppError(400, 'untrusted_update_url', 'The release metadata supplied an untrusted asset URL.');
    }

    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers: Record<string, string> = {
        Accept: accept,
        'User-Agent': 'NodePilot-UpdateService/1.0',
      };
      // Never forward a repository token to a release CDN redirect.
      if (current.hostname.toLowerCase() === 'api.github.com' && process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const response = await this.fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, timeoutMs);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new AppError(502, 'github_redirect_error', 'GitHub returned a redirect without a destination.');
      current = new URL(location, current);
      if (!isTrustedGitHubAssetUrl(current.toString())) {
        throw new AppError(502, 'github_redirect_error', 'GitHub redirected the update download to an untrusted host.');
      }
    }
    throw new AppError(502, 'github_redirect_error', 'GitHub redirected the update download too many times.');
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError(504, 'update_request_timeout', 'GitHub did not respond before the update request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readResponseText(response: Response, maxBytes: number): Promise<string> {
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new AppError(413, 'update_response_too_large', 'GitHub returned more update metadata than NodePilot will accept.');
    }
    if (!response.body) return '';
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buffer.length;
      if (received > maxBytes) {
        stream.destroy();
        throw new AppError(413, 'update_response_too_large', 'GitHub returned more update metadata than NodePilot will accept.');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private parseReleaseList(content: string): GitHubRelease[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError(502, 'github_response_invalid', 'GitHub returned invalid release metadata.');
    }
    if (!Array.isArray(parsed)) throw new AppError(502, 'github_response_invalid', 'GitHub returned unexpected release metadata.');

    return parsed.flatMap((item): GitHubRelease[] => {
      if (!item || typeof item !== 'object') return [];
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.tag_name !== 'string'
        || typeof raw.html_url !== 'string'
        || typeof raw.published_at !== 'string'
        || typeof raw.prerelease !== 'boolean'
        || typeof raw.draft !== 'boolean'
        || !Array.isArray(raw.assets)
      ) return [];

      const assets = raw.assets.flatMap((candidate): UpdateAssetCandidate[] => {
        if (!candidate || typeof candidate !== 'object') return [];
        const asset = candidate as Record<string, unknown>;
        if (
          typeof asset.name !== 'string'
          || typeof asset.url !== 'string'
          || typeof asset.browser_download_url !== 'string'
          || typeof asset.size !== 'number'
          || !Number.isSafeInteger(asset.size)
          || asset.size < 0
        ) return [];
        return [{
          name: asset.name,
          apiUrl: asset.url,
          browserDownloadUrl: asset.browser_download_url,
          size: asset.size,
          contentType: typeof asset.content_type === 'string' ? asset.content_type : 'application/octet-stream',
        }];
      });
      return [{
        tagName: raw.tag_name,
        name: typeof raw.name === 'string' ? raw.name : null,
        publishedAt: raw.published_at,
        isPrerelease: raw.prerelease,
        isDraft: raw.draft,
        htmlUrl: raw.html_url,
        body: typeof raw.body === 'string' ? raw.body : '',
        assets,
      }];
    });
  }

  private async githubApiError(response: Response, repository: string): Promise<AppError> {
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0');
      const minutes = reset > 0 ? Math.max(1, Math.ceil((reset * 1_000 - Date.now()) / 60_000)) : 30;
      return new AppError(429, 'github_rate_limited', `GitHub's API rate limit was reached. Try again in about ${minutes} minute(s).`);
    }
    if (response.status === 404) {
      return new AppError(404, 'update_repository_not_found', `No published releases were found for ${repository}.`);
    }
    return new AppError(502, 'github_api_error', `GitHub could not provide release metadata (HTTP ${response.status}).`);
  }

  private async githubAssetError(response: Response, name: string): Promise<AppError> {
    return new AppError(502, 'github_asset_error', `GitHub could not download ${name} (HTTP ${response.status}).`);
  }

  private computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (data) => hash.update(data));
      stream.once('error', reject);
      stream.once('end', () => resolve(hash.digest('hex')));
    });
  }

  private resolveCurrentVersion(): string {
    for (const packagePath of [path.join(this.projectRoot, 'package.json'), path.join(this.projectRoot, 'server', 'package.json')]) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
        if (typeof parsed.version === 'string' && parseSemVer(parsed.version)) return cleanVersion(parsed.version);
      } catch {
        // Try the next known package location.
      }
    }
    return process.env.NODEPILOT_VERSION && parseSemVer(process.env.NODEPILOT_VERSION)
      ? cleanVersion(process.env.NODEPILOT_VERSION)
      : '0.1.0';
  }
}
