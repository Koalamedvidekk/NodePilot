import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { AppError, errorMessage } from '../lib/errors.js';
import { resolveManagedServerRoot } from '../lib/paths.js';
import { filterTemplateVersions, requireServerTemplate, resolveServerTemplate } from '../lib/server-templates.js';
import { TemplateBundleRepository } from '../repositories/template-bundle-repository.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import type { BundleInput, BundleInstallation, BundleJournalTarget, BundleOperation, BundlePlan, BundlePreview } from '../template-bundle-types.js';
import type { ServerRecord } from '../types.js';
import { downloadToFile, type AddonService } from './addon-service.js';
import { safeAddonStoragePath } from './addon-change-service.js';
import { bundleType, TemplateBundleResolver } from './template-bundle-resolver.js';
import type { MinecraftService } from './minecraft-service.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const publicOperation = ({ plan: _plan, runtime: _runtime, journal: _journal, enablePlayit: _playit, ...status }: BundleOperation): BundleInstallation => status;
const smpNodes = ['home', 'sethome', 'delhome', 'msg', 'reply', 'tpa', 'tpaccept', 'tpdeny'];
const exists = (file: string) => lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
async function fileHash(file: string, algorithm = 'sha256'): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AppError(409, 'unsafe_bundle_file', 'Template files must be ordinary files, never links.');
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function fingerprint(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let count = 0;
  const visit = async (relative = ''): Promise<void> => {
    for (const entry of await readdir(relative ? await safeAddonStoragePath(root, relative) : root, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const target = await safeAddonStoragePath(root, name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result[name] = await fileHash(target);
      else throw new AppError(409, 'unsafe_bundle_runtime', 'A linked or special runtime file prevents safe installation.');
      if (++count > 40_000) throw new AppError(413, 'bundle_runtime_too_large', 'The runtime contains too many files.');
    }
  };
  await visit();
  return result;
}
function equalFingerprint(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

export class TemplateInstallationService {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private stopping = false;
  constructor(private readonly records: TemplateBundleRepository, private readonly servers: ServerRepository,
    private readonly minecraft: MinecraftService, private readonly addons: AddonService,
    private readonly config: { dataDirectory: string; serversDirectory: string },
    private readonly resolver = new TemplateBundleResolver(),
    private readonly onReady?: (server: ServerRecord) => Promise<unknown>) {}

  isBlocked(id: string): boolean { const operation = this.records.find(id); return Boolean(operation && operation.state !== 'succeeded'); }
  anyBusy(): boolean { return this.tasks.size > 0 || this.records.list().some(operation => operation.state === 'running' || Boolean(operation.journal)); }
  assertAvailable(id: string): void {
    if (this.isBlocked(id)) throw new AppError(409, 'template_installation_incomplete', 'Finish, retry or delete this template installation before changing or starting the server.');
  }
  canDelete(id: string): boolean { const operation = this.records.find(id); return !operation || operation.state !== 'running' && !operation.journal; }
  status(id: string): BundleInstallation | null { const operation = this.records.find(id); return operation ? publicOperation(operation) : null; }
  async discard(id: string): Promise<void> {
    const operation = this.records.find(id);
    if (!operation) return;
    if (!this.canDelete(id) || this.tasks.has(id)) throw new AppError(409, 'template_installation_busy', 'Finish or cancel template installation before deleting this server.');
    const directory = await this.storage(operation);
    await fingerprint(directory);
    await rm(directory, { recursive: true });
  }

  async preview(input: BundleInput): Promise<BundlePreview> {
    const template = requireServerTemplate(input.templateId, input.software);
    const resolved = resolveServerTemplate(input.templateId, input.software, input.version, input.templateSettings)!;
    if (template.id === 'pure-vanilla' && input.selections.length) throw new AppError(422, 'vanilla_addons_unavailable', 'Pure Vanilla never installs plugins or mods.');
    const choices = filterTemplateVersions(template, await this.minecraft.getVersions(input.software));
    const versions = await this.resolver.compatibleVersions(input.software, choices.map(item => item.id), input.selections);
    let artifacts;
    try { artifacts = await this.resolver.resolve(input.software, input.version, input.selections); }
    catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 422) throw error;
      return { compatible: false, reason: error.message, versions, artifacts: [], configurationChanges: [], planId: null, expiresAt: null };
    }
    if (!versions.includes(input.version)) return { compatible: false, reason: 'Choose a Minecraft version supported by this template and its selected add-ons.', versions, artifacts: [], configurationChanges: [], planId: null, expiresAt: null };
    const config: Record<string, string> = {};
    const essentials = artifacts.some(item => item.source === 'modrinth' && item.projectId === 'hXiIvTyT');
    if (template.id === 'smp' && essentials) config['permissions.yml'] = YAML.stringify({ 'nodepilot.template.smp': { description: 'Basic SMP utility commands', default: true,
      children: Object.fromEntries(smpNodes.map(node => ['essentials.' + node, true])) } });
    if (artifacts.some(item => item.type === 'plugin' && ['hXiIvTyT', 'Vebnzrzj'].includes(item.projectId))) config['plugins/bStats/config.yml'] = YAML.stringify({ enabled: false });
    const plan: BundlePlan = { ...input, templateSettings: resolved.settings, id: randomUUID(), serverId: null,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), artifacts, config };
    this.records.savePlan(plan);
    return { compatible: true, reason: null, versions, artifacts, planId: plan.id, expiresAt: plan.expiresAt,
      configurationChanges: Object.keys(config).map(file => ({ file, description: file === 'permissions.yml' ? 'Enable /home, /sethome, /delhome, /msg, /reply, /tpa, /tpaccept and /tpdeny for ordinary players. No administrative permissions.' : 'Disable supported plugin metrics.' })) };
  }

  validatePlan(id: string, input: Pick<BundleInput, 'templateId' | 'software' | 'version' | 'templateSettings'>): BundlePlan {
    const plan = this.records.plan(id);
    if (!plan) throw new AppError(404, 'template_plan_missing', 'This preview is unavailable. Preview the template again.');
    if (!plan.serverId && Date.parse(plan.expiresAt) <= Date.now()) throw new AppError(409, 'template_plan_expired', 'This preview expired. Refresh it before creating the server.');
    const settings = resolveServerTemplate(input.templateId, input.software, input.version, input.templateSettings)?.settings;
    if (plan.templateId !== input.templateId || plan.software !== input.software || plan.version !== input.version || JSON.stringify(plan.templateSettings) !== JSON.stringify(settings)) {
      throw new AppError(409, 'template_plan_changed', 'The software, Minecraft version or settings changed. Preview the template again.');
    }
    return plan;
  }

  create(server: ServerRecord, plan: BundlePlan, enablePlayit: boolean): BundleInstallation {
    if (!this.records.claim(plan.id, server.id)) throw new AppError(409, 'template_plan_used', 'This preview has already created a server. Refresh it to create another.');
    const operation: BundleOperation = { id: randomUUID(), serverId: server.id, plan: { ...plan, serverId: server.id }, enablePlayit,
      state: 'running', phase: 'Waiting to install', error: null, completedFiles: 0, totalFiles: plan.artifacts.length,
      downloadedBytes: 0, totalBytes: plan.artifacts.reduce((sum, file) => sum + file.size, 0), updatedAt: new Date().toISOString(), runtime: null, journal: null };
    this.records.save(operation);
    return publicOperation(operation);
  }
  begin(id: string): void {
    if (this.stopping || this.tasks.has(id)) return;
    const operation = this.records.find(id);
    if (!operation || operation.state !== 'running') return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = Promise.resolve().then(() => this.install(operation, controller.signal)).finally(() => { this.tasks.delete(id); this.controllers.delete(id); });
    this.tasks.set(id, task);
    void task.catch(() => undefined);
  }
  async retry(id: string): Promise<BundleInstallation> {
    const operation = this.records.find(id);
    if (!operation) throw new AppError(404, 'template_installation_missing', 'No template installation exists for this server.');
    if (this.stopping || this.tasks.has(id) || operation.state === 'running' || operation.state === 'succeeded') throw new AppError(409, 'template_installation_busy', 'This installation cannot be retried now.');
    if (operation.journal) await this.rollback(operation);
    this.servers.setStatus(id, 'installing', { installState: 'installing', lastError: null });
    operation.state = 'running'; operation.error = null; operation.phase = 'Verifying retained downloads'; this.records.save(operation); this.begin(id);
    return publicOperation(operation);
  }
  async cancel(id: string): Promise<BundleInstallation> {
    const operation = this.records.find(id);
    if (!operation) throw new AppError(404, 'template_installation_missing', 'No template installation exists.');
    if (operation.phase === 'Applying the complete bundle') throw new AppError(409, 'template_committing', 'The complete bundle is being committed. Wait for this short operation to finish.');
    this.controllers.get(id)?.abort(new Error('Template installation cancelled.'));
    await this.tasks.get(id);
    return this.status(id)!;
  }
  async stop(): Promise<void> { this.stopping = true; for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(this.tasks.values()); }
  async recover(): Promise<void> {
    for (const operation of this.records.list()) {
      if (operation.state === 'succeeded') continue;
      try { if (operation.journal) await this.rollback(operation); }
      catch (error) { operation.error = 'Recovery blocked by changed files: ' + errorMessage(error); }
      if (operation.state === 'running') { operation.state = 'failed'; operation.phase = 'Interrupted; retry available'; operation.error ??= 'NodePilot restarted during installation. Verified downloads were retained.'; }
      this.records.save(operation);
      this.servers.markInstallFailed(operation.serverId, operation.error ?? 'Template installation is incomplete.');
    }
  }

  private async storage(operation: BundleOperation): Promise<string> {
    await mkdir(this.config.dataDirectory, { recursive: true });
    const root = await safeAddonStoragePath(this.config.dataDirectory, 'template-installations', true);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await safeAddonStoragePath(root, operation.id, true);
    await mkdir(directory, { mode: 0o700, recursive: true });
    return safeAddonStoragePath(root, operation.id);
  }
  private update(operation: BundleOperation, phase: string): void { operation.phase = phase; this.records.save(operation); }
  private async install(operation: BundleOperation, signal: AbortSignal): Promise<void> {
    try {
      const server = this.servers.require(operation.serverId), storage = await this.storage(operation);
      const space = await statfs(storage), required = operation.totalBytes * 3 + 512 * 1024 * 1024;
      if (Number(space.bavail) * Number(space.bsize) < required) throw new AppError(507, 'insufficient_disk_space', 'Free disk space before installing this template.');
      operation.completedFiles = 0; operation.downloadedBytes = 0;
      const artifacts: Array<{ path: string; type: 'plugin' | 'mod'; fileName: string; source: 'modrinth' | 'hangar'; projectId: string; versionId: string }> = [];
      for (const [index, artifact] of operation.plan.artifacts.entries()) {
        signal.throwIfAborted();
        this.update(operation, `Downloading ${artifact.name} ${artifact.versionName}`);
        const file = await safeAddonStoragePath(storage, index + '.jar', true);
        const valid = await exists(file) && (await lstat(file)).size === artifact.size && await fileHash(file, artifact.checksum.algorithm) === artifact.checksum.value;
        if (!valid) {
          if (await exists(file)) await rm(file);
          const temporary = await safeAddonStoragePath(storage, index + '.part', true);
          if (await exists(temporary)) await rm(temporary);
          const baseline = operation.downloadedBytes; let last = 0;
          await downloadToFile(artifact.downloadUrl, temporary, artifact.checksum, { signal, onProgress: bytes => {
            operation.downloadedBytes = baseline + bytes;
            if (Date.now() - last > 300) { last = Date.now(); this.records.save(operation); }
          } });
          if ((await lstat(temporary)).size !== artifact.size) { await rm(temporary); throw new AppError(502, 'bundle_download_size', 'The downloaded file size differs from the preview. Refresh the preview or retry.'); }
          await rename(temporary, file);
          operation.downloadedBytes = baseline + artifact.size;
        } else operation.downloadedBytes += artifact.size;
        operation.completedFiles += 1;
        artifacts.push({ path: file, ...artifact });
        this.records.save(operation);
      }
      signal.throwIfAborted();
      const target = await this.prepareRuntime(operation, server, storage, signal);
      signal.throwIfAborted();
      this.update(operation, 'Preparing verified add-ons and initial settings');
      const journal: BundleJournalTarget[] = [];
      for (const file of artifacts) {
        const relative = (file.type === 'plugin' ? 'plugins/' : 'mods/') + file.fileName;
        const destination = await safeAddonStoragePath(target, relative, true);
        if (await exists(destination)) throw new AppError(409, 'bundle_existing_addon', 'An existing add-on conflicts with this new installation. NodePilot preserved it.');
        journal.push({ file: relative, before: null, beforeHash: null, afterHash: await fileHash(file.path) });
      }
      const patches: Array<{ file: string; text: string }> = [];
      for (const [file, fragment] of Object.entries(operation.plan.config)) {
        const destination = await safeAddonStoragePath(target, file, true);
        const before = await exists(destination) ? await this.configBytes(destination) : null;
        const document = YAML.parseDocument(before?.toString('utf8') ?? '');
        if (document.errors.length) throw new AppError(409, 'bundle_config_invalid', 'An existing configuration file is invalid; it was preserved.');
        const values = YAML.parse(fragment) as Record<string, unknown>;
        for (const [key, value] of Object.entries(values)) {
          if (file === 'permissions.yml' && document.has(key)) throw new AppError(409, 'bundle_config_changed', 'The template permission name already exists.');
          document.set(key, value);
        }
        const text = document.toString();
        patches.push({ file, text });
        journal.push({ file, before: before?.toString('base64') ?? null, beforeHash: before ? digest(before) : null, afterHash: digest(text) });
      }
      operation.journal = journal; this.records.save(operation);
      signal.throwIfAborted();
      this.update(operation, 'Applying the complete bundle');
      await this.addons.installFreshBundle(this.servers.require(server.id), artifacts);
      for (const patch of patches) {
        const expected = journal.find(item => item.file === patch.file)!;
        await this.atomicConfig(target, patch.file, patch.text, expected.beforeHash);
      }
      const completed: BundleOperation = { ...operation, state: 'succeeded', phase: 'Installed; start the server when ready', journal: null, error: null, runtime: null };
      this.records.database.transaction(() => { this.servers.markReady(server.id); this.records.save(completed); })();
      Object.assign(operation, completed);
      if (operation.enablePlayit && this.onReady) {
        // Tunnel coordination is separate from the committed Minecraft install.
        void this.onReady(this.servers.require(server.id)).catch(error => console.warn('[Templates] Playit coordination: ' + errorMessage(error)));
      }
    } catch (error) {
      let message = (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'Not enough disk space to finish the template.' : errorMessage(error);
      try { if (operation.journal) await this.rollback(operation); }
      catch (recoveryError) { message += ' Recovery requires attention: ' + errorMessage(recoveryError); }
      operation.state = signal.aborted ? 'cancelled' : 'failed'; operation.error = message; operation.phase = operation.journal ? 'Recovery required' : signal.aborted ? 'Cancelled; downloads retained' : 'Failed; retry available';
      this.servers.markInstallFailed(operation.serverId, message); this.records.save(operation);
    }
  }

  private async prepareRuntime(operation: BundleOperation, server: ServerRecord, storage: string, signal: AbortSignal): Promise<string> {
    this.update(operation, 'Installing Minecraft server files');
    const staging = await safeAddonStoragePath(storage, 'runtime', true);
    if (!operation.runtime) {
      if (await exists(staging)) { await fingerprint(staging); await rm(staging, { recursive: true }); }
      await mkdir(staging);
      const configuration = await this.minecraft.stageRuntime(server, staging, signal);
      const template = resolveServerTemplate(operation.plan.templateId, server.software, server.version, operation.plan.templateSettings);
      await this.minecraft.writeStarterConfiguration(server, staging, template);
      signal.throwIfAborted();
      operation.runtime = { configuration, fingerprint: await fingerprint(staging), promoted: false }; this.records.save(operation);
    }
    let target = await resolveManagedServerRoot(this.config.serversDirectory, server.directory, true);
    if (!operation.runtime.promoted) {
      if ((await readdir(target)).length) {
        if (!equalFingerprint(operation.runtime.fingerprint, await fingerprint(target))) throw new AppError(409, 'bundle_runtime_changed', 'Existing server files differ from the staged runtime. They were preserved.');
      } else {
        if (!equalFingerprint(operation.runtime.fingerprint, await fingerprint(staging))) throw new AppError(409, 'bundle_runtime_changed', 'The staged runtime changed. It was preserved for inspection.');
        await rmdir(target); await rename(staging, target);
      }
      this.records.database.transaction(() => { this.servers.setRuntimeConfiguration(server.id, operation.runtime!.configuration); operation.runtime!.promoted = true; this.records.save(operation); })();
    } else if (!equalFingerprint(operation.runtime.fingerprint, await fingerprint(target))) throw new AppError(409, 'bundle_runtime_changed', 'Files changed after runtime installation. Retry will not overwrite them.');
    return target;
  }

  private async configBytes(file: string): Promise<Buffer> {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw new AppError(409, 'unsafe_bundle_config', 'A linked or oversized configuration file prevents template changes.');
    return readFile(file);
  }
  private async atomicConfig(root: string, relative: string, text: Buffer | string, expected: string | null): Promise<void> {
    let target = await safeAddonStoragePath(root, relative, true);
    await mkdir(path.dirname(target), { recursive: true }); target = await safeAddonStoragePath(root, relative, true);
    if ((await exists(target) ? await fileHash(target) : null) !== expected) throw new AppError(409, 'bundle_config_changed', 'A configuration file changed during installation. It was preserved.');
    const temporary = await safeAddonStoragePath(root, relative + '.nodepilot-' + randomUUID() + '.tmp', true);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      if ((await exists(target) ? await fileHash(target) : null) !== expected) throw new AppError(409, 'bundle_config_changed', 'A configuration changed before replacement.');
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  private async rollback(operation: BundleOperation): Promise<void> {
    const server = this.servers.require(operation.serverId);
    await this.addons.discardFreshBundle(server);
    const root = await resolveManagedServerRoot(this.config.serversDirectory, server.directory);
    for (const item of [...(operation.journal ?? [])].reverse()) {
      const target = await safeAddonStoragePath(root, item.file, true);
      const current = await exists(target) ? await fileHash(target) : null;
      if (current === item.beforeHash) continue;
      if (current !== item.afterHash) throw new AppError(409, 'bundle_recovery_conflict', `Changed ${item.file} prevents automatic recovery. No external edits were overwritten.`);
      if (item.before === null) await rm(target);
      else await this.atomicConfig(root, item.file, Buffer.from(item.before, 'base64'), item.afterHash);
    }
    this.records.database.transaction(() => {
      for (const artifact of operation.plan.artifacts) this.records.database.prepare('DELETE FROM addon_installs WHERE server_id=? AND addon_type=? AND file_name=? AND project_id=? AND version_id=?')
        .run(server.id, artifact.type, artifact.fileName, artifact.projectId, artifact.versionId);
      operation.journal = null; this.records.save(operation);
    })();
  }
}
