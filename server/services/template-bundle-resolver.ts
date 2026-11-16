import { AppError } from '../lib/errors.js';
import { readAddonJson, safeAddonFileName } from './addon-service.js';
import type { BundleArtifact, BundleSelection } from '../template-bundle-types.js';
import type { ProvisionableServerSoftware } from '../types.js';

type Dependency = { source: 'modrinth' | 'hangar'; projectId?: string; versionId?: string; incompatible?: boolean };
type Release = { id: string; name: string; date: string; games: string[]; loaders: string[];
  file: { url: string; name: string; size: number; checksum: BundleArtifact['checksum'] }; dependencies: Dependency[] };
type Project = BundleSelection & { name: string; clientSide: string; serverSide: string; versions: Release[] };
type RawVersion = { id: string; project_id: string; name: string; version_number: string; version_type: string; date_published: string;
  game_versions: string[]; loaders: string[]; files: Array<{ filename: string; url: string; primary: boolean; size: number; hashes: Record<string, string> }>;
  dependencies?: Array<{ project_id?: string | null; version_id?: string | null; dependency_type: string }> };
const modrinth = 'https://api.modrinth.com/v2';
const hangar = 'https://hangar.papermc.io/api/v1';
const identity = (selection: BundleSelection) => selection.source + ':' + selection.projectId;
export const bundleType = (software: string): 'plugin' | 'mod' | null =>
  ['paper', 'purpur'].includes(software) ? 'plugin' : ['fabric', 'neoforge'].includes(software) ? 'mod' : null;
const loader = (software: string) => ['paper', 'purpur'].includes(software) ? 'paper' : software;
function checksum(hashes: Record<string, string> = {}): BundleArtifact['checksum'] | null {
  for (const algorithm of ['sha512', 'sha256', 'sha1'] as const) {
    const value = hashes[algorithm];
    if (value && new RegExp(`^[a-f0-9]{${algorithm === 'sha512' ? 128 : algorithm === 'sha256' ? 64 : 40}}$`, 'i').test(value)) return { algorithm, value: value.toLowerCase() };
  }
  return null;
}

export class TemplateBundleResolver {
  private readonly cache = new Map<string, { expires: number; task: Promise<Project> }>();
  constructor(private readonly json: <T>(url: string, hosts: Set<string>) => Promise<T> = readAddonJson) {}

  private async project(selection: BundleSelection): Promise<Project> {
    const valid = selection.source === 'modrinth' ? /^[A-Za-z0-9_-]{3,96}$/ : /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,96}$/;
    if (!valid.test(selection.projectId)) throw new AppError(400, 'invalid_project_id', 'Choose a valid catalogue project.');
    const key = identity(selection), existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.task;
    const task = selection.source === 'modrinth' ? this.modrinthProject(selection.projectId) : this.hangarProject(selection.projectId);
    this.cache.set(key, { task, expires: Date.now() + 10 * 60_000 });
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
    try { return await task; } catch (error) { this.cache.delete(key); throw error; }
  }

  private async modrinthProject(id: string): Promise<Project> {
    const hosts = new Set(['api.modrinth.com']);
    const project = await this.json<{ id: string; title: string; client_side: string; server_side: string }>(`${modrinth}/project/${encodeURIComponent(id)}`, hosts);
    const versions = await this.json<RawVersion[]>(`${modrinth}/project/${encodeURIComponent(project.id)}/version?include_changelog=false`, hosts);
    if (!Array.isArray(versions) || versions.length > 5000) throw new AppError(502, 'bundle_metadata_invalid', 'The catalogue returned an invalid release list.');
    const releases: Release[] = [];
    for (const version of versions) {
      if (version.version_type !== 'release') continue;
      const file = version.files?.find(item => item.primary && /\.jar$/i.test(item.filename)) ?? version.files?.find(item => /\.jar$/i.test(item.filename));
      const digest = file && checksum(file.hashes);
      if (!file || !digest || !version.id || !Array.isArray(version.game_versions) || !Array.isArray(version.loaders)) continue;
      releases.push({ id: version.id, name: version.version_number, date: version.date_published, games: version.game_versions,
        loaders: version.loaders, file: { url: file.url, name: safeAddonFileName(file.filename), size: file.size, checksum: digest },
        dependencies: (version.dependencies ?? []).filter(item => ['required', 'incompatible'].includes(item.dependency_type))
          .map(item => ({ source: 'modrinth', projectId: item.project_id ?? undefined, versionId: item.version_id ?? undefined, incompatible: item.dependency_type === 'incompatible' })) });
    }
    return { source: 'modrinth', projectId: project.id, name: project.title, clientSide: project.client_side, serverSide: project.server_side,
      versions: releases.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.name.localeCompare(a.name, undefined, { numeric: true })) };
  }

  private async hangarProject(id: string): Promise<Project> {
    const hosts = new Set(['hangar.papermc.io']);
    const project = await this.json<{ name: string; namespace: { owner: string; slug: string } }>(`${hangar}/projects/${id}`, hosts);
    const releases: Release[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const data = await this.json<{ result: Array<{ name: string; createdAt: string; channel?: { name: string };
        platformDependencies?: { PAPER?: string[] }; downloads?: { PAPER?: { downloadUrl?: string; fileInfo?: { name?: string; size?: number; sizeBytes?: number; sha256Hash?: string; hashes?: Record<string, string> } } };
        pluginDependencies?: { PAPER?: Array<{ projectId?: number; name: string; required: boolean }> } }> }>(`${hangar}/projects/${id}/versions?limit=100&offset=${offset}`, hosts);
      if (!Array.isArray(data.result)) throw new AppError(502, 'bundle_metadata_invalid', 'Hangar returned an invalid release list.');
      for (const version of data.result) {
        const file = version.downloads?.PAPER, digest = checksum({ ...file?.fileInfo?.hashes, ...(file?.fileInfo?.sha256Hash ? { sha256: file.fileInfo.sha256Hash } : {}) });
        if (!/^(release|stable)$/i.test(version.channel?.name ?? '') || !file?.downloadUrl || !digest) continue;
        const dependencies: Dependency[] = [];
        for (const item of version.pluginDependencies?.PAPER ?? []) if (item.required) {
          if (!item.projectId) throw new AppError(422, 'bundle_dependency_unresolved', `${project.name} has a required dependency without a downloadable catalogue identity.`);
          const dependency = await this.json<{ namespace: { owner: string; slug: string } }>(`${hangar}/projects/${item.projectId}`, hosts);
          dependencies.push({ source: 'hangar', projectId: `${dependency.namespace.owner}/${dependency.namespace.slug}` });
        }
        releases.push({ id: version.name, name: version.name, date: version.createdAt, games: version.platformDependencies?.PAPER ?? [], loaders: ['paper'], dependencies,
          file: { url: file.downloadUrl, name: safeAddonFileName(file.fileInfo?.name ?? new URL(file.downloadUrl).pathname.split('/').pop()!), size: file.fileInfo?.sizeBytes ?? file.fileInfo?.size ?? 0, checksum: digest } });
      }
      if (data.result.length < 100) break;
      if (offset === 900) throw new AppError(422, 'bundle_catalogue_limit', 'This Hangar project has too many releases for safe automatic template resolution.');
    }
    return { source: 'hangar', projectId: `${project.namespace.owner}/${project.namespace.slug}`, name: project.name, clientSide: 'unsupported', serverSide: 'required', versions: releases.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.name.localeCompare(a.name, undefined, { numeric: true })) };
  }

  async resolve(software: ProvisionableServerSoftware, game: string, selections: BundleSelection[]): Promise<BundleArtifact[]> {
    const type = bundleType(software);
    if (!selections.length) return [];
    if (!type) throw new AppError(422, 'bundle_software_unsupported', 'Choose Paper/Purpur for plugins or Fabric/NeoForge for these server-only mod bundles.');
    if (selections.length > 32) throw new AppError(413, 'bundle_too_large', 'Choose at most 32 add-ons.');
    type Chosen = { project: Project; release: Release; parents: Set<string> };
    let attempts = 0;
    const solve = async (queue: Array<Dependency & { parents: string[]; trail: string[] }>, chosen: Map<string, Chosen>): Promise<Map<string, Chosen>> => {
      if (++attempts > 500 || chosen.size > 64) throw new AppError(422, 'bundle_dependency_limit', 'The dependency graph is too large or ambiguous. Choose a smaller bundle.');
      if (!queue.length) {
        for (const node of chosen.values()) for (const dependency of node.release.dependencies.filter(item => item.incompatible)) {
          let projectId = dependency.projectId;
          if (!projectId && dependency.versionId) projectId = (await this.json<RawVersion>(`${modrinth}/version/${encodeURIComponent(dependency.versionId)}`, new Set(['api.modrinth.com']))).project_id;
          if (!projectId) throw new AppError(422, 'bundle_dependency_unresolved', 'A declared incompatibility has no catalogue identity and cannot be verified.');
          const conflict = projectId && chosen.get(identity({ source: dependency.source, projectId }));
          if (conflict && (!dependency.versionId || conflict.release.id === dependency.versionId)) throw new AppError(422, 'bundle_conflict', `${node.project.name} conflicts with ${conflict.project.name}.`);
        }
        return chosen;
      }
      const [item, ...rest] = queue;
      let projectId = item.projectId;
      if (!projectId && item.versionId && item.source === 'modrinth') projectId = (await this.json<RawVersion>(`${modrinth}/version/${encodeURIComponent(item.versionId)}`, new Set(['api.modrinth.com']))).project_id;
      if (!projectId) throw new AppError(422, 'bundle_dependency_unresolved', 'A required dependency has no catalogue identity.');
      const project = await this.project({ source: item.source, projectId }), key = identity(project);
      if (item.trail.includes(key)) throw new AppError(422, 'bundle_dependency_cycle', `Circular dependency involving ${project.name}.`);
      if (type === 'mod' && (!['optional', 'unsupported'].includes(project.clientSide) || !['optional', 'required'].includes(project.serverSide))) {
        throw new AppError(422, 'bundle_client_requirement', `${project.name} is not verified by its publisher as a server mod with optional client installation.`);
      }
      if (type === 'plugin' && project.source === 'hangar' && loader(software) !== 'paper') throw new AppError(422, 'bundle_type_incompatible', 'Hangar plugins cannot be installed as mods.');
      const previous = chosen.get(key);
      if (previous) {
        if (item.versionId && previous.release.id !== item.versionId) throw new AppError(422, 'bundle_dependency_conflict', `${project.name} requires conflicting exact versions.`);
        item.parents.forEach(parent => previous.parents.add(parent));
        return solve(rest, chosen);
      }
      const candidates = project.versions.filter(version => version.games.includes(game) && version.loaders.includes(loader(software)) && (!item.versionId || version.id === item.versionId));
      if (!candidates.length) throw new AppError(422, 'bundle_version_unavailable', `${project.name} has no stable checksum-verified ${loader(software)} release for Minecraft ${game}.`);
      let failure: unknown;
      for (const release of candidates.slice(0, 24)) {
        const next = new Map([...chosen].map(([id, value]) => [id, { ...value, parents: new Set(value.parents) }]));
        next.set(key, { project, release, parents: new Set(item.parents) });
        const required = release.dependencies.filter(dependency => !dependency.incompatible).map(dependency => ({ ...dependency, parents: [project.name], trail: [...item.trail, key] }));
        try { return await solve([...required, ...rest], next); } catch (error) {
          if (!(error instanceof AppError) || !error.code.startsWith('bundle_')) throw error;
          failure = error;
        }
      }
      throw failure;
    };
    const chosen = await solve(selections.map(selection => ({ ...selection, parents: [], trail: [] })), new Map());
    const names = new Set<string>();
    return [...chosen.values()].map(({ project, release, parents }) => {
      const name = release.file.name.normalize('NFKC').toLowerCase();
      if (names.has(name)) throw new AppError(422, 'bundle_filename_collision', 'Selected add-ons have colliding filenames.');
      names.add(name);
      if (!Number.isSafeInteger(release.file.size) || release.file.size <= 0 || release.file.size > 256 * 1024 * 1024) throw new AppError(422, 'bundle_file_size', `${project.name} has no safe download size.`);
      return { source: project.source, projectId: project.projectId, name: project.name, type, versionId: release.id, versionName: release.name,
        fileName: release.file.name, downloadUrl: release.file.url, checksum: release.file.checksum, size: release.file.size, requiredBy: [...parents], clientRequired: false as const };
    });
  }

  async compatibleVersions(software: ProvisionableServerSoftware, games: string[], selections: BundleSelection[]): Promise<string[]> {
    if (!selections.length) return games;
    const roots = await Promise.all(selections.map(selection => this.project(selection)));
    const candidates = games.filter(game => roots.every(project => project.versions.some(version => version.games.includes(game) && version.loaders.includes(loader(software)))));
    const results: string[] = [];
    for (const game of candidates) {
      try { await this.resolve(software, game, selections); results.push(game); }
      catch (error) { if (!(error instanceof AppError) || error.statusCode !== 422) throw error; }
    }
    return results;
  }
}
