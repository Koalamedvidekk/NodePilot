import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { ZipFile } from 'yazl';
import YAML from 'yaml';
import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { TemplateBundleRepository } from '../repositories/template-bundle-repository.js';
import { AddonService } from '../services/addon-service.js';
import { MinecraftService } from '../services/minecraft-service.js';
import { TemplateBundleResolver } from '../services/template-bundle-resolver.js';
import { TemplateInstallationService } from '../services/template-installation-service.js';
import type { BundleInput, BundleOperation, BundleSelection } from '../template-bundle-types.js';
import type { ServerRecord } from '../types.js';

const selection = (projectId: string): BundleSelection => ({ source: 'modrinth', projectId });
const sha = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex');
async function jar(name: string, mod = false): Promise<Buffer> {
  const zip = new ZipFile();
  if (mod) zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, id: name.toLowerCase(), name, version: '1.0', environment: '*' })), 'fabric.mod.json');
  else zip.addBuffer(Buffer.from(`name: ${name}\nversion: '1.0'\nmain: test.Main\napi-version: '1.21'\n`), 'plugin.yml');
  const parts: Buffer[] = []; zip.outputStream.on('data', part => parts.push(part));
  const result = new Promise<Buffer>((resolve, reject) => { zip.outputStream.once('end', () => resolve(Buffer.concat(parts))); zip.outputStream.once('error', reject); });
  zip.end(); return result;
}
function catalogue(bytes: Buffer) {
  const versions = new Map<string, any[]>();
  const projects = new Map<string, { id: string; title: string; client_side: string; server_side: string }>();
  const add = (id: string, options: { client?: string; server?: string; loaders?: string[]; games?: string[]; dependencies?: any[]; release?: string; filename?: string; fixed?: string; hashes?: Record<string,string> } = {}) => {
    projects.set(id, { id, title: id, client_side: options.client ?? 'unsupported', server_side: options.server ?? 'required' });
    const version = { id: options.fixed ?? id + '-v1', project_id: id, version_type: options.release ?? 'release', date_published: '2026-11-01T00:00:00Z', name: '1.0', version_number: '1.0',
      game_versions: options.games ?? ['1.21.4'], loaders: options.loaders ?? ['paper'], dependencies: options.dependencies ?? [],
      files: [{ primary: true, filename: options.filename ?? id + '.jar', url: 'https://cdn.modrinth.com/data/' + id + '/test.jar', size: bytes.length, hashes: options.hashes ?? { sha512: sha(bytes) } }] };
    versions.set(id, [version]); return version;
  };
  const json = async <T>(url: string): Promise<T> => {
    const pathname = new URL(url).pathname.replace('/v2/', '');
    if (pathname.startsWith('version/')) {
      const id = pathname.slice(8); const version = [...versions.values()].flat().find(item => item.id === id);
      if (!version) throw new Error('Missing fixture version ' + id); return structuredClone(version) as T;
    }
    const [, id, suffix] = pathname.split('/');
    const data = suffix === 'version' ? versions.get(id) : projects.get(id);
    if (!data) throw new Error('Missing fixture project ' + id);
    return structuredClone(data) as T;
  };
  return { add, json, versions, projects, resolver: new TemplateBundleResolver(json) };
}

test('bundle resolution pins stable files, exact dependencies, and meaningful compatibility intersections', async () => {
  const bytes = await jar('Dependency'); const cat = catalogue(bytes);
  cat.add('parent', { games: ['1.21.4', '26.3'], dependencies: [{ project_id: 'dependency', version_id: 'dependency-fixed', dependency_type: 'required' }] });
  cat.add('dependency', { fixed: 'dependency-fixed' });
  const pinned = await cat.resolver.resolve('purpur', '1.21.4', [selection('parent')]);
  assert.deepEqual(pinned.map(file => file.projectId), ['parent', 'dependency']);
  assert.equal(pinned[1].versionId, 'dependency-fixed'); assert.deepEqual(pinned[1].requiredBy, ['parent']);
  assert.equal(pinned[0].checksum.value, sha(bytes));
  assert.deepEqual(await cat.resolver.compatibleVersions('paper', ['26.3', '1.21.4', '1.8.8'], [selection('parent')]), ['1.21.4']);
});

test('bundle resolution refuses conflicts, cycles, client requirements, missing hashes and case collisions', async () => {
  const bytes = await jar('Dependency');
  for (const scenario of ['conflict', 'cycle', 'client', 'hash', 'collision', 'missing-version']) {
    const cat = catalogue(bytes);
    cat.add('alpha', scenario === 'conflict' ? { dependencies: [{ project_id: 'bravo', dependency_type: 'incompatible' }] }
      : scenario === 'cycle' ? { dependencies: [{ project_id: 'bravo', dependency_type: 'required' }] }
      : scenario === 'client' ? { client: 'required', loaders: ['fabric'] }
      : scenario === 'hash' ? { hashes: {} }
      : scenario === 'collision' ? { filename: 'Same.jar' }
      : { dependencies: [{ version_id: 'unavailable-exact', project_id: 'bravo', dependency_type: 'required' }] });
    cat.add('bravo', scenario === 'cycle' ? { dependencies: [{ project_id: 'alpha', dependency_type: 'required' }] } : scenario === 'collision' ? { filename: 'same.jar' } : {});
    await assert.rejects(cat.resolver.resolve(scenario === 'client' ? 'fabric' : 'paper', '1.21.4',
      scenario === 'conflict' || scenario === 'collision' ? [selection('alpha'), selection('bravo')] : [selection('alpha')]));
  }
});

test('Hangar previews use publisher sizeBytes and sha256Hash fields and refuse external-only downloads', async () => {
  const bytes = await jar('Chunky');
  const resolver = new TemplateBundleResolver(async <T>(url: string): Promise<T> => {
    if (!new URL(url).pathname.endsWith('/versions')) return { name: 'Chunky', namespace: { owner: 'pop4959', slug: 'Chunky' } } as T;
    return { result: [{ name: '1.0', createdAt: '2026-11-01T00:00:00Z', channel: { name: 'Release' }, platformDependencies: { PAPER: ['1.21.4'] },
      downloads: { PAPER: { downloadUrl: 'https://hangarcdn.papermc.io/plugins/test/Chunky.jar', fileInfo: { name: 'Chunky.jar', sizeBytes: bytes.length, sha256Hash: createHash('sha256').update(bytes).digest('hex') } } } }] } as T;
  });
  const files = await resolver.resolve('paper', '1.21.4', [{ source: 'hangar', projectId: 'pop4959/Chunky' }]);
  assert.equal(files[0].size, bytes.length); assert.equal(files[0].checksum.algorithm, 'sha256');
  const external = new TemplateBundleResolver(async <T>(url: string): Promise<T> => new URL(url).pathname.endsWith('/versions')
    ? { result: [{ name: '1.0', createdAt: '2026-11-01', channel: { name: 'Release' }, platformDependencies: { PAPER: ['1.21.4'] }, downloads: { PAPER: { externalUrl: 'https://example.com/manual-download' } } }] } as T
    : { name: 'External', namespace: { owner: 'publisher', slug: 'External' } } as T);
  await assert.rejects(external.resolve('paper', '1.21.4', [{ source: 'hangar', projectId: 'publisher/External' }]), /no stable checksum/);
});

async function fixture(t: TestContext) {
  const temporary = await realpath(os.tmpdir()); const root = await mkdtemp(path.join(temporary, 'nodepilot-bundles-'));
  const database = openDatabase(path.join(root, 'nodepilot.sqlite')); const servers = new ServerRepository(database);
  const records = new TemplateBundleRepository(database); const bytes = await jar('Essentials'); const cat = catalogue(bytes);
  cat.add('hXiIvTyT'); cat.add('Vebnzrzj');
  const config = { dataDirectory: root, serversDirectory: path.join(root, 'servers') };
  const minecraft = new MinecraftService(servers, config.serversDirectory);
  t.mock.method(minecraft, 'getVersions', async () => [{ id: '1.21.4', type: 'release' as const, available: true, releaseTime: null }]);
  const runtime = t.mock.method(minecraft, 'stageRuntime', async (server: ServerRecord, directory: string) => {
    await writeFile(path.join(directory, 'server.jar'), 'trusted Minecraft fixture');
    return { software: server.software as 'paper', loaderVersion: null, startupConfig: { mode: 'jar' as const, jarPath: 'server.jar', gameArguments: ['nogui'] } };
  });
  const addons = new AddonService(config.serversDirectory, path.join(root, 'backups'), database, { dataDirectory: root, getServer: id => servers.require(id), isProcessActive: () => false });
  const service = new TemplateInstallationService(records, servers, minecraft, addons, config, cat.resolver);
  let fail = false, slow = false, requests = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests += 1;
    if (slow) await new Promise<void>((_resolve, reject) => { if (init?.signal?.aborted) reject(new Error('aborted')); else init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    return new Response(fail ? 'corrupt' : bytes);
  });
  const input: BundleInput = { templateId: 'smp', software: 'paper', version: '1.21.4', selections: [selection('hXiIvTyT'), selection('Vebnzrzj')] };
  t.after(async () => { await service.stop(); await addons.stop(); database.close(); assert.equal(path.dirname(root), temporary); assert.ok(path.basename(root).startsWith('nodepilot-bundles-')); await rm(root, { recursive: true, force: true }); });
  async function create() {
    const preview = await service.preview(input); assert.equal(preview.compatible, true);
    const plan = service.validatePlan(preview.planId!, input);
    const server = servers.create({ id: randomUUID(), machineId: 'local', directory: 'bundle-' + randomUUID(), name: 'Bundle fixture', software: 'paper', version: '1.21.4', port: 25565 + servers.list().length, memoryMb: 2048, eulaAccepted: true });
    database.transaction(() => service.create(server, plan, false))(); service.begin(server.id);
    return server;
  }
  async function finish(id: string) {
    const end = Date.now() + 10_000;
    while (service.status(id)?.state === 'running') { if (Date.now() > end) throw new Error('Fixture installation did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
    return service.status(id)!;
  }
  return { root, database, servers, records, service, addons, input, runtime, fetch, create, finish, fail: (value: boolean) => { fail = value; }, slow: (value: boolean) => { slow = value; }, requests: () => requests };
}

test('a template installs an exact complete bundle while blocked, then registers tracked add-ons and restricted defaults', async t => {
  const f = await fixture(t); const server = await f.create(); assert.equal(f.service.isBlocked(server.id), true);
  const status = await f.finish(server.id); assert.equal(status.state, 'succeeded', status.error ?? '');
  assert.equal(f.servers.require(server.id).status, 'offline'); assert.equal(f.service.isBlocked(server.id), false);
  const listing = await f.addons.list(f.servers.require(server.id));
  assert.equal(listing.plugins.length, 2); assert.ok(listing.plugins.every(file => file.source === 'modrinth' && file.versionId));
  const directory = path.join(f.root, 'servers', server.directory);
  const permissions = YAML.parse(await readFile(path.join(directory, 'permissions.yml'), 'utf8'))['nodepilot.template.smp'];
  assert.equal(permissions.default, true); assert.equal(permissions.children['essentials.home'], true); assert.equal(Object.keys(permissions.children).length, 8);
  assert.ok(Object.keys(permissions.children).every(key => !key.includes('*') && !key.includes('admin') && !key.includes('op')));
  assert.equal(YAML.parse(await readFile(path.join(directory, 'plugins/bStats/config.yml'), 'utf8')).enabled, false);
});

test('failed checksums never mark ready and retry reuses the pinned plan instead of choosing newer releases', async t => {
  const f = await fixture(t); f.fail(true); const server = await f.create();
  assert.equal((await f.finish(server.id)).state, 'failed'); assert.equal(f.servers.require(server.id).installState, 'failed');
  assert.equal(f.runtime.mock.callCount(), 0); assert.equal(f.service.isBlocked(server.id), true);
  f.fail(false); await f.service.retry(server.id); assert.equal((await f.finish(server.id)).state, 'succeeded');
  assert.equal(f.runtime.mock.callCount(), 1); assert.equal(f.service.status(server.id)?.completedFiles, 2);
});

test('preview plans reject expiry and stale settings without creating a server', async t => {
  const f = await fixture(t); const preview = await f.service.preview(f.input);
  assert.throws(() => f.service.validatePlan(preview.planId!, { ...f.input, version: '26.3' }), /changed/);
  const plan = f.records.plan(preview.planId!)!; plan.expiresAt = '2000-01-01T00:00:00Z';
  f.database.prepare('UPDATE template_bundle_plans SET payload=? WHERE id=?').run(JSON.stringify(plan), plan.id);
  assert.throws(() => f.service.validatePlan(plan.id, f.input), /expired/);
  assert.deepEqual(f.servers.list(), []);
});

test('a failed commit rolls back the complete bundle and retry reuses verified downloads and the runtime', async t => {
  const f = await fixture(t);
  const original = f.servers.markReady.bind(f.servers);
  const failCommit = t.mock.method(f.servers, 'markReady', () => { throw new Error('simulated database commit failure'); });
  const server = await f.create(); const result = await f.finish(server.id);
  assert.equal(result.state, 'failed'); assert.match(result.error!, /commit failure/);
  assert.equal((await f.addons.list(f.servers.require(server.id))).plugins.length, 0);
  const folder = path.join(f.root, 'servers', server.directory);
  assert.ok(!(await readdir(folder)).includes('permissions.yml'));
  assert.ok(!(await readdir(path.join(folder, 'plugins'))).some(name => name.endsWith('.jar')));
  const requests = f.requests(); failCommit.mock.mockImplementation(original);
  await f.service.retry(server.id);
  assert.equal((await f.finish(server.id)).state, 'succeeded');
  assert.equal(f.requests(), requests); assert.equal(f.runtime.mock.callCount(), 1);
});

test('durable recovery after files commit restores initial configuration and permits an explicit retry', async t => {
  const f = await fixture(t); let interrupted: import('../template-bundle-types.js').BundleOperation | undefined;
  const save = f.records.save.bind(f.records);
  t.mock.method(f.records, 'save', (operation: BundleOperation) => { if (operation.journal && operation.phase === 'Applying the complete bundle') interrupted = structuredClone(operation); save(operation); });
  const server = await f.create(); assert.equal((await f.finish(server.id)).state, 'succeeded'); assert.ok(interrupted?.journal);
  f.servers.setStatus(server.id, 'installing', { installState: 'installing' }); save(interrupted!);
  await f.service.recover();
  assert.equal(f.service.status(server.id)?.state, 'failed'); assert.equal(f.records.find(server.id)?.journal, null);
  assert.equal((await f.addons.list(f.servers.require(server.id))).plugins.length, 0);
  assert.equal(f.servers.require(server.id).installState, 'failed');
  await f.service.retry(server.id); assert.equal((await f.finish(server.id)).state, 'succeeded');
});

test('external configuration edits block recovery and are never overwritten', async t => {
  const f = await fixture(t); const install = f.addons.installFreshBundle.bind(f.addons); let folder = '';
  t.mock.method(f.addons, 'installFreshBundle', async (server: ServerRecord, artifacts: Parameters<AddonService['installFreshBundle']>[1]) => {
    await install(server, artifacts); folder = path.join(f.root, 'servers', server.directory);
    await writeFile(path.join(folder, 'permissions.yml'), 'owner.edit:\n  default: false\n');
  });
  const server = await f.create(); const status = await f.finish(server.id);
  assert.equal(status.state, 'failed'); assert.match(status.error!, /Recovery requires attention/);
  assert.equal(await readFile(path.join(folder, 'permissions.yml'), 'utf8'), 'owner.edit:\n  default: false\n');
  assert.ok(f.records.find(server.id)?.journal); assert.equal(f.service.canDelete(server.id), false);
  await assert.rejects(f.service.retry(server.id), /prevents automatic recovery/);
});

test('cancelling an active transfer leaves an unfinished stopped server and allows a clean retry', async t => {
  const f = await fixture(t); f.slow(true); const server = await f.create();
  while (!f.requests()) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.service.cancel(server.id)).state, 'cancelled');
  assert.equal(f.servers.require(server.id).installState, 'failed'); assert.equal(f.runtime.mock.callCount(), 0);
  f.slow(false); await f.service.retry(server.id); assert.equal((await f.finish(server.id)).state, 'succeeded');
});

test('insufficient disk space fails before downloads or runtime writes', async t => {
  const f = await fixture(t);
  t.mock.method(fsPromises, 'statfs', async () => ({ bavail: 1, bsize: 1 })); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const server = await f.create(); const status = await f.finish(server.id);
  assert.equal(status.state, 'failed'); assert.match(status.error!, /disk space/);
  assert.equal(f.requests(), 0); assert.equal(f.runtime.mock.callCount(), 0);
});
