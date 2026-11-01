import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerVersionRepository } from '../repositories/server-version-repository.js';
import type { InstalledServerRuntime } from '../services/minecraft-service.js';
import { compareMinecraftVersions, isStableMinecraftVersion, ServerVersionService } from '../services/server-version-service.js';
import type { MinecraftVersion, ServerRecord } from '../types.js';

const release = (id: string): MinecraftVersion => ({ id, type: 'release', available: true, releaseTime: null });

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-version-test-'));
  const serversDirectory = path.join(temporary, 'servers');
  const backupsDirectory = path.join(temporary, 'backups');
  const directory = path.join(serversDirectory, 'test-world');
  await mkdir(path.join(directory, 'custom-world', 'playerdata'), { recursive: true });
  await mkdir(path.join(directory, 'plugins'), { recursive: true });
  await mkdir(path.join(directory, 'config'), { recursive: true });
  await writeFile(path.join(directory, 'server.jar'), 'old runtime');
  await writeFile(path.join(directory, 'server.properties'), 'level-name=custom-world\nserver-port=25572\nmotd=Keep me\n');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(directory, 'ops.json'), '[{"name":"Owner"}]');
  await writeFile(path.join(directory, 'custom-world', 'playerdata', 'owner.dat'), 'player inventory');
  await writeFile(path.join(directory, 'config', 'settings.yml'), 'custom: true');
  const db = openDatabase(path.join(temporary, 'database.sqlite'));
  const servers = new ServerRepository(db);
  const settings = new ServerVersionRepository(db);
  const server = servers.create({
    id: 'versions-test-server', machineId: 'local', name: 'Version test', directory: 'test-world',
    software: 'paper', version: '1.21.4', port: 25572, memoryMb: 2048, eulaAccepted: true, requiredJavaMajor: 21,
  });
  servers.markReady(server.id);
  const state = { active: false, pause: false, missingJava: false, stages: 0, metadataRequests: 0, metadataError: false };
  let versions = [release('1.21.4'), release('1.21.5')];
  let stage: (server: ServerRecord, staging: string) => Promise<InstalledServerRuntime> = async (target, staging) => {
    await writeFile(path.join(staging, 'server.jar'), 'runtime ' + target.version);
    return { software: 'paper', loaderVersion: null, startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] } };
  };
  const service = new ServerVersionService(
    { serversDirectory, backupsDirectory }, servers,
    {
      async getVersions() {
        state.metadataRequests += 1;
        if (state.metadataError) throw new Error('Publisher unavailable');
        return versions;
      },
      async assertVersionAvailable(_software, version) { assert.ok(versions.some((entry) => entry.id === version && entry.available)); },
      async getRequiredJavaMajor() { return 21; },
      async stageRuntime(target, staging) { state.stages += 1; return stage(target, staging); },
    },
    { async findUsable() { return state.missingJava ? null : { installation: { path: 'test-java', version: '21', major: 21, vendor: null, compatible: true } }; } },
    { isProcessActive() { return state.active; } }, settings, () => state.pause,
  );
  t.after(async () => {
    await service.stop();
    db.close();
    assert.ok(path.basename(temporary).startsWith('nodepilot-version-test-'));
    assert.equal(path.dirname(temporary).toLowerCase(), os.tmpdir().toLowerCase());
    await rm(temporary, { recursive: true, force: true });
  });
  return {
    temporary, serversDirectory, backupsDirectory, directory, db, servers, settings, server, service, state,
    setVersions(value: MinecraftVersion[]) { versions = value; },
    setStage(value: typeof stage) { stage = value; },
  };
}

test('stable release ordering supports Minecraft year versions and excludes snapshots', () => {
  assert.equal(compareMinecraftVersions('26.3', '1.21.11'), 1);
  assert.equal(compareMinecraftVersions('1.21.10', '1.21.9'), 1);
  assert.equal(compareMinecraftVersions('1.21', '1.21.0'), 0);
  assert.equal(isStableMinecraftVersion('26.3-pre1'), false);
  assert.equal(isStableMinecraftVersion('../1.21'), false);
});

test('metadata lists only available stable releases and persists opt-in preferences', async (t) => {
  const f = await fixture(t);
  f.setVersions([
    release('1.21.4'), release('26.3'), { ...release('26.4'), available: false },
    { ...release('26w01a'), type: 'snapshot' }, release('26.3-pre1'),
  ]);
  const status = await f.service.check(f.server.id);
  assert.deepEqual(status.versions.map((version) => version.id), ['26.3', '1.21.4']);
  assert.equal(status.latestVersion, '26.3');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.autoUpdate, false);
  f.state.active = true;
  await f.service.setAutoUpdate(f.server.id, true);
  assert.equal(new ServerVersionRepository(f.db).find(f.server.id)?.autoUpdate, true);
});

test('manual version change backs up everything and preserves worlds, settings and add-ons', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'plugins', 'example.jar'), 'existing plugin');
  f.setStage(async (_target, staging) => {
    await mkdir(path.join(staging, 'custom-world'), { recursive: true });
    await mkdir(path.join(staging, 'plugins'), { recursive: true });
    await writeFile(path.join(staging, 'server.jar'), 'updated runtime');
    await writeFile(path.join(staging, 'server.properties'), 'motd=Do not replace');
    await writeFile(path.join(staging, 'eula.txt'), 'eula=false');
    await writeFile(path.join(staging, 'ops.json'), '[]');
    await writeFile(path.join(staging, 'custom-world', 'replacement.txt'), 'do not install world');
    await writeFile(path.join(staging, 'plugins', 'unexpected.jar'), 'do not install plugin');
    return { software: 'paper', loaderVersion: 'new-build', startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] } };
  });
  const status = await f.service.changeVersion(f.server.id, '1.21.5', { confirm: true });
  const record = f.servers.require(f.server.id);
  assert.equal(record.version, '1.21.5');
  assert.equal(record.software, 'paper');
  assert.equal(record.loaderVersion, 'new-build');
  assert.equal(record.javaPath, 'test-java');
  assert.equal(record.requiredJavaMajor, 21);
  assert.equal(record.port, 25572);
  assert.equal(record.memoryMb, 2048);
  assert.equal(record.eulaAccepted, true);
  assert.equal(record.status, 'offline');
  assert.equal(status.busy, false);
  assert.equal(f.service.isBusy(f.server.id), false);
  assert.equal(await readFile(path.join(f.directory, 'server.jar'), 'utf8'), 'updated runtime');
  const backup = status.lastBackupPath!;
  assert.ok(backup.startsWith(f.backupsDirectory + path.sep));
  assert.equal(await readFile(path.join(backup, 'server.jar'), 'utf8'), 'old runtime');
  for (const file of ['server.properties', 'eula.txt', 'ops.json', 'custom-world/playerdata/owner.dat', 'plugins/example.jar', 'config/settings.yml']) {
    assert.deepEqual(await readFile(path.join(f.directory, file)), await readFile(path.join(backup, file)));
  }
  assert.deepEqual(await readdir(path.join(f.directory, 'custom-world')), ['playerdata']);
  assert.deepEqual(await readdir(path.join(f.directory, 'plugins')), ['example.jar']);
  assert.deepEqual(await readdir(f.serversDirectory), ['test-world']);
  assert.equal(JSON.parse(await readFile(backup + '.json', 'utf8')).version, '1.21.4');
});

test('download failure leaves original files and version untouched and retains completed backup', async (t) => {
  const f = await fixture(t);
  f.setStage(async () => { throw new Error('Download checksum mismatch'); });
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /checksum mismatch/);
  assert.equal(f.servers.require(f.server.id).version, '1.21.4');
  assert.equal(await readFile(path.join(f.directory, 'server.jar'), 'utf8'), 'old runtime');
  assert.equal(await readFile(path.join(f.settings.find(f.server.id)!.lastBackupPath!, 'server.jar'), 'utf8'), 'old runtime');
  assert.deepEqual(await readdir(f.serversDirectory), ['test-world']);
  assert.equal((await f.service.getStatus(f.server.id)).lastError, 'Download checksum mismatch');
  assert.equal((await f.service.check(f.server.id)).lastError, null);
});

test('database commit failure restores the original runtime after directory swap', async (t) => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER refuse_version_change BEFORE UPDATE OF version ON servers BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END");
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /simulated commit failure/);
  assert.equal(f.servers.require(f.server.id).version, '1.21.4');
  assert.equal(f.servers.require(f.server.id).installState, 'ready');
  assert.equal(await readFile(path.join(f.directory, 'server.jar'), 'utf8'), 'old runtime');
  assert.equal(await readFile(path.join(f.directory, 'custom-world', 'playerdata', 'owner.dat'), 'utf8'), 'player inventory');
  assert.deepEqual(await readdir(f.serversDirectory), ['test-world']);
  assert.ok(f.settings.find(f.server.id)!.lastBackupPath);
});

test('running servers, missing Java and an application update are refused before backup', async (t) => {
  const f = await fixture(t);
  f.state.active = true;
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /Stop the server/);
  f.state.active = false;
  f.state.missingJava = true;
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /Java 21/);
  f.state.missingJava = false;
  f.state.pause = true;
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /application update/);
  assert.equal(f.state.stages, 0);
  assert.equal(f.settings.find(f.server.id)!.lastBackupPath, null);
});

test('concurrent changes are refused and a newly active server is not swapped', async (t) => {
  const f = await fixture(t);
  let finishStage!: () => void;
  let enteredStage!: () => void;
  const entered = new Promise<void>((resolve) => { enteredStage = resolve; });
  const resume = new Promise<void>((resolve) => { finishStage = resolve; });
  f.setStage(async (_target, staging) => {
    enteredStage();
    await resume;
    await writeFile(path.join(staging, 'server.jar'), 'new runtime');
    return { software: 'paper', loaderVersion: null, startupConfig: { mode: 'jar', jarPath: 'server.jar', gameArguments: ['nogui'] } };
  });
  const changing = f.service.changeVersion(f.server.id, '1.21.5', { confirm: true });
  await entered;
  assert.equal(f.service.isBusy(f.server.id), true);
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /already running/);
  f.state.active = true;
  finishStage();
  await assert.rejects(changing, /Stop the server/);
  assert.equal(f.servers.require(f.server.id).version, '1.21.4');
  assert.equal(await readFile(path.join(f.directory, 'server.jar'), 'utf8'), 'old runtime');
});

test('automatic update waits for stopped server and then installs pending stable release', async (t) => {
  const f = await fixture(t);
  f.settings.save(f.server.id, { autoUpdate: true });
  f.state.active = true;
  await f.service.runAutomaticChecks();
  assert.equal(f.state.stages, 0);
  assert.equal(f.settings.find(f.server.id)?.latestVersion, '1.21.5');
  f.state.active = false;
  await f.service.runAutomaticChecks();
  assert.equal(f.state.stages, 1);
  assert.equal(f.servers.require(f.server.id).version, '1.21.5');
  await f.service.runAutomaticChecks();
  assert.equal(f.state.stages, 1);
  assert.equal(f.state.metadataRequests, 1);
});

test('automatic changes refuse add-on compatibility risks and downgrades', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'plugins', 'keep.jar'), 'plugin');
  f.settings.save(f.server.id, { autoUpdate: true });
  await f.service.runAutomaticChecks();
  assert.equal(f.state.stages, 0);
  assert.match((await f.service.getStatus(f.server.id)).automaticUpdateBlockedReason!, /plugins or mods/);
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true, automatic: true }), /compatibility/);
  await assert.rejects(f.service.changeVersion(f.server.id, '1.20.4', { confirm: true, automatic: true }), /never downgrade/);
  assert.equal(f.servers.require(f.server.id).version, '1.21.4');
});

test('failed automatic installs back off despite status polling and preserve failure details', async (t) => {
  const f = await fixture(t);
  f.settings.save(f.server.id, { autoUpdate: true });
  f.setStage(async () => { throw new Error('Publisher download failed'); });
  await f.service.runAutomaticChecks();
  const backup = f.settings.find(f.server.id)!.lastBackupPath;
  assert.equal(f.state.stages, 1);
  assert.equal((await f.service.getStatus(f.server.id)).lastError, 'Publisher download failed');
  await f.service.runAutomaticChecks();
  await f.service.runAutomaticChecks();
  assert.equal(f.state.stages, 1);
  assert.equal(f.settings.find(f.server.id)!.lastBackupPath, backup);
});

test('failed metadata checks are recorded and do not trigger repeated scheduler requests', async (t) => {
  const f = await fixture(t);
  f.state.metadataError = true;
  f.settings.save(f.server.id, { autoUpdate: true });
  await f.service.runAutomaticChecks();
  await f.service.runAutomaticChecks();
  assert.equal(f.state.metadataRequests, 1);
  assert.equal(f.settings.find(f.server.id)!.lastError, 'Publisher unavailable');
  assert.equal(f.state.stages, 0);
});

test('linked files are rejected without copying or modifying their external targets', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.temporary, 'external-world');
  await mkdir(external);
  await writeFile(path.join(external, 'world.dat'), 'external world');
  await symlink(external, path.join(f.directory, 'linked-world'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.changeVersion(f.server.id, '1.21.5', { confirm: true }), /symbolic links, junctions/);
  assert.equal(await readFile(path.join(external, 'world.dat'), 'utf8'), 'external world');
  assert.equal(f.servers.require(f.server.id).version, '1.21.4');
  assert.equal(f.state.stages, 0);
  assert.deepEqual(await readdir(f.backupsDirectory), []);
});
