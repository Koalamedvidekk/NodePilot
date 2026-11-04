import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test, { type TestContext } from 'node:test';

import * as yazl from 'yazl';

import { openDatabase } from '../db.js';
import { AddonPendingRepository, type AddonChangeJournal } from '../repositories/addon-pending-repository.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { AddonChangeService } from '../services/addon-change-service.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-addon-change-test-'));
  const data = path.join(root, 'data');
  const serversDirectory = path.join(data, 'servers');
  const backupsDirectory = path.join(data, 'backups');
  const serverDirectory = path.join(serversDirectory, 'fixture-server');
  const plugins = path.join(serverDirectory, 'plugins');
  await mkdir(plugins, { recursive: true });
  const database = openDatabase(path.join(data, 'nodepilot.sqlite'));
  const servers = new ServerRepository(database);
  const pending = new AddonPendingRepository(database);
  const id = randomUUID();
  servers.create({ id, machineId: 'local', name: 'Fixture', directory: 'fixture-server', software: 'paper',
    version: '1.20.1', port: 25565, memoryMb: 1024, eulaAccepted: true });
  servers.markReady(id);
  servers.setStatus(id, 'running');
  let processActive = true;
  const options = { dataDirectory: data, getServer: (serverId: string) => servers.find(serverId), isProcessActive: () => processActive };
  const service = new AddonChangeService(serversDirectory, backupsDirectory, database, options);
  const services = [service];
  t.after(async () => {
    for (const current of services) await current.stop();
    database.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('nodepilot-addon-change-test-'));
    await rm(root, { recursive: true, force: true });
  });
  async function jar(version: string): Promise<string> {
    const destination = path.join(root, randomUUID() + '.jar');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`name: Fixture\nversion: ${version}\napi-version: '1.20'\nmain: test.Fixture\n`), 'plugin.yml');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(destination, { flags: 'wx' }));
    return destination;
  }
  async function install(fileName: string, version: string) {
    const source = await jar(version);
    await copyFile(source, path.join(plugins, fileName));
    const now = new Date().toISOString();
    database.prepare('INSERT INTO addon_installs(server_id,addon_type,file_name,source,project_id,version_id,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 'plugin', fileName, 'modrinth', 'fixture-project', version, now, now);
    return readFile(source);
  }
  async function queue(fileName: string, version: string, originalFileName?: string) {
    const source = await jar(version);
    const result = await service.mutate(servers.require(id), current => service.submit(current, 'plugin', source, fileName, 'upload', undefined, undefined, originalFileName));
    assert.equal(result.queued, true);
    assert.ok(result.pendingChange);
    return { change: pending.list(id).find(change => change.id === result.pendingChange!.id)!, bytes: await readFile(source) };
  }
  const stopped = () => { processActive = false; return servers.setStatus(id, 'offline'); };
  const reopen = () => { const current = new AddonChangeService(serversDirectory, backupsDirectory, database, options); services.push(current); return current; };
  const artifact = (changeId: string) => path.join(data, 'addon-changes', 'artifacts', changeId + '.jar');
  return { root, data, backupsDirectory, serverDirectory, plugins, database, servers, pending, id, service, jar, install, queue, stopped, reopen, artifact };
}

test('queued install, rename update, and removal preserve running JARs and apply together with full backups', async t => {
  const f = await fixture(t);
  const old = await f.install('Old.jar', '1.0');
  const removed = await f.install('Remove.jar', '1.0');
  const update = await f.queue('New.jar', '2.0', 'Old.jar');
  const addition = await f.queue('Addition.jar', '1.0');
  const removal = await f.service.mutate(f.servers.require(f.id), current => f.service.remove(current, 'plugin', 'Remove.jar'));
  assert.equal(removal.queued, true);
  assert.deepEqual((await readdir(f.plugins)).sort(), ['Old.jar', 'Remove.jar']);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Old.jar')), old);
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), { code: 'server_active' });
  f.stopped();
  const afterPanelRestart = f.reopen();
  assert.equal(afterPanelRestart.list(f.id).length, 3);
  await afterPanelRestart.applyPending(f.servers.require(f.id));
  assert.deepEqual((await readdir(f.plugins)).sort(), ['Addition.jar', 'New.jar']);
  assert.deepEqual(await readFile(path.join(f.plugins, 'New.jar')), update.bytes);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Addition.jar')), addition.bytes);
  assert.equal(afterPanelRestart.hasPending(f.id), false);
  assert.equal(afterPanelRestart.hasRecoveryBlock(f.id), false);
  const journals = await readdir(path.join(f.backupsDirectory, f.id, 'addon-changes'));
  assert.equal(journals.length, 1);
  const backupFiles = await readdir(path.join(f.backupsDirectory, f.id, 'addon-changes', journals[0]));
  const hashes = await Promise.all(backupFiles.map(async name => sha(await readFile(path.join(f.backupsDirectory, f.id, 'addon-changes', journals[0], name)))));
  assert.deepEqual(hashes.sort(), [sha(old), sha(removed)].sort());
  const rows = f.database.prepare('SELECT file_name FROM addon_installs WHERE server_id=? ORDER BY file_name').all(f.id);
  assert.deepEqual(rows, [{ file_name: 'Addition.jar' }, { file_name: 'New.jar' }]);
});

test('case aliases cannot queue overlapping changes; cancelling deletes only the selected staged artifact', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('fixture.jar', '2.0');
  assert.equal(queued.change.fileName, 'Fixture.jar');
  const source = await f.jar('3.0');
  await assert.rejects(() => f.service.mutate(f.servers.require(f.id), current => f.service.submit(current, 'plugin', source, 'FIXTURE.jar', 'upload')), { code: 'addon_change_already_queued' });
  const other = await f.queue('Other.jar', '1.0');
  await f.service.cancelPending(f.servers.require(f.id), queued.change.id);
  await assert.rejects(() => readFile(f.artifact(queued.change.id)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.artifact(other.change.id)), other.bytes);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), original);
  assert.deepEqual(f.service.list(f.id).map(change => change.id), [other.change.id]);
  await assert.rejects(() => f.service.cancelPending(f.servers.require(f.id), queued.change.id), { code: 'addon_change_not_found' });
});

test('stale installed files, changed software/version, and tampered staged checksums block the whole batch', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('Fixture.jar', '2.0');
  const addition = await f.queue('Addition.jar', '1.0');
  f.stopped();
  await writeFile(path.join(f.plugins, 'Fixture.jar'), 'external edit');
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), { code: 'addon_pending_failed' });
  assert.equal(await readFile(path.join(f.plugins, 'Fixture.jar'), 'utf8'), 'external edit');
  assert.equal((await readdir(f.plugins)).includes('Addition.jar'), false);
  await writeFile(path.join(f.plugins, 'Fixture.jar'), original);
  f.servers.updateVersion(f.id, { version: '1.20.2', startupConfig: f.servers.require(f.id).startupConfig });
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), /different Minecraft version/);
  f.servers.updateVersion(f.id, { version: '1.20.1', startupConfig: f.servers.require(f.id).startupConfig });
  await writeFile(f.artifact(addition.change.id), 'tampered artifact');
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), /queued JAR is missing or changed/);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), original);
  assert.equal(f.service.list(f.id).length, 2);
  assert.match(f.service.pendingError(f.id) ?? '', /missing or changed/);
  await writeFile(f.artifact(addition.change.id), addition.bytes);
  await f.service.applyPending(f.servers.require(f.id));
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), queued.bytes);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Addition.jar')), addition.bytes);
});

test('startup recovery restores interrupted multi-file writes and stale temporary files, retaining the queue for retry', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('Fixture.jar', '2.0');
  const addition = await f.queue('Addition.jar', '1.0');
  f.stopped();
  const journal: AddonChangeJournal = { id: randomUUID(), serverId: f.id, state: 'applying', createdAt: new Date().toISOString(),
    targets: [
      { type: 'plugin', fileName: 'Fixture.jar', beforeHash: sha(original), afterHash: sha(queued.bytes), backupIndex: 0 },
      { type: 'plugin', fileName: 'Addition.jar', beforeHash: null, afterHash: sha(addition.bytes), backupIndex: 1 },
    ], beforeRows: f.database.prepare('SELECT * FROM addon_installs WHERE server_id=?').all(f.id) as AddonChangeJournal['beforeRows'] };
  const backup = path.join(f.backupsDirectory, f.id, 'addon-changes', journal.id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, '0.jar'), original);
  f.pending.saveJournal(journal);
  await writeFile(path.join(f.plugins, 'Fixture.jar'), queued.bytes);
  await writeFile(path.join(f.plugins, 'Addition.jar'), addition.bytes);
  await writeFile(path.join(f.plugins, '.nodepilot-addon-' + journal.id + '-Fixture.jar.tmp'), 'interrupted copy');
  f.database.prepare('DELETE FROM addon_installs WHERE server_id=?').run(f.id);
  const recovered = f.reopen();
  await recovered.recover();
  assert.equal(recovered.hasRecoveryBlock(f.id), false);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), original);
  assert.deepEqual(await readdir(f.plugins), ['Fixture.jar']);
  const restoredRow = f.database.prepare('SELECT version_id FROM addon_installs WHERE server_id=?').get(f.id) as { version_id: string };
  assert.equal(restoredRow.version_id, '1.0');
  assert.equal(recovered.list(f.id).length, 2);
  assert.match(recovered.pendingError(f.id) ?? '', /Original JARs were restored/);
  await recovered.applyPending(f.servers.require(f.id));
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), queued.bytes);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Addition.jar')), addition.bytes);
  assert.equal(recovered.hasPending(f.id), false);
});

test('a database failure after JAR replacement rolls back the entire batch and keeps it retryable', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('Fixture.jar', '2.0');
  const addition = await f.queue('Addition.jar', '1.0');
  f.stopped();
  f.database.exec(`CREATE TRIGGER fail_addon_metadata BEFORE INSERT ON addon_installs
    WHEN NEW.file_name='Addition.jar' BEGIN SELECT RAISE(ABORT,'injected metadata write failure'); END;`);
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), /injected metadata write failure/);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), original);
  assert.deepEqual(await readdir(f.plugins), ['Fixture.jar']);
  assert.equal(f.service.hasRecoveryBlock(f.id), false);
  assert.equal(f.service.list(f.id).length, 2);
  assert.match(f.service.pendingError(f.id) ?? '', /injected metadata write failure/);
  const rows = f.database.prepare('SELECT file_name,version_id FROM addon_installs WHERE server_id=?').all(f.id);
  assert.deepEqual(rows, [{ file_name: 'Fixture.jar', version_id: '1.0' }]);
  f.database.exec('DROP TRIGGER fail_addon_metadata');
  await f.service.applyPending(f.servers.require(f.id));
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), queued.bytes);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Addition.jar')), addition.bytes);
  assert.equal(f.service.hasPending(f.id), false);
});

for (const action of ['replace', 'remove'] as const) {
  test(`an external JAR edit after durable backups is preserved before queued ${action}`, async t => {
    const f = await fixture(t);
    const original = await f.install('Fixture.jar', '1.0');
    let replacement: Buffer | undefined;
    if (action === 'replace') replacement = (await f.queue('Fixture.jar', '2.0')).bytes;
    else await f.service.mutate(f.servers.require(f.id), current => f.service.remove(current, 'plugin', 'Fixture.jar'));
    f.stopped();
    // The journal is persisted only after every backup has been copied and synced.
    // Inject an external editor at precisely that boundary, before any live write.
    f.database.function('external_edit', () => {
      writeFileSync(path.join(f.plugins, 'Fixture.jar'), 'external edit after backup');
      return 1;
    });
    f.database.exec('CREATE TRIGGER change_after_backup AFTER INSERT ON addon_change_journals BEGIN SELECT external_edit(); END;');
    await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), /refused to overwrite the external change/);
    assert.equal(await readFile(path.join(f.plugins, 'Fixture.jar'), 'utf8'), 'external edit after backup');
    assert.equal(f.service.hasRecoveryBlock(f.id), true);
    assert.equal(f.service.list(f.id).length, 1);
    const journal = f.pending.journal(f.id)!;
    assert.equal(journal.state, 'recovery_required');
    assert.deepEqual(await readFile(path.join(f.backupsDirectory, f.id, 'addon-changes', journal.id, '0.jar')), original);
    await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), { code: 'addon_recovery_required' });
    f.database.exec('DROP TRIGGER change_after_backup');
    // The user resolves the external edit deliberately; automatic recovery never
    // makes this decision or overwrites that file on their behalf.
    await writeFile(path.join(f.plugins, 'Fixture.jar'), original);
    await f.service.recover();
    assert.equal(f.service.hasRecoveryBlock(f.id), false);
    await f.service.applyPending(f.servers.require(f.id));
    if (replacement) assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), replacement);
    else await assert.rejects(() => readFile(path.join(f.plugins, 'Fixture.jar')), { code: 'ENOENT' });
  });
}

test('server deletion discards only its own queued artifacts after the managed process stops', async t => {
  const f = await fixture(t);
  const queued = await f.queue('Fixture.jar', '1.0');
  const sentinel = f.artifact(randomUUID());
  await writeFile(sentinel, 'another queued artifact');
  await assert.rejects(() => f.service.discardForDeletedServer(f.servers.require(f.id)), { code: 'server_active' });
  assert.deepEqual(await readFile(f.artifact(queued.change.id)), queued.bytes);
  const server = f.stopped();
  await rm(f.serverDirectory, { recursive: true });
  await f.service.discardForDeletedServer(server);
  assert.equal(f.service.hasPending(f.id), false);
  await assert.rejects(() => readFile(f.artifact(queued.change.id)), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'another queued artifact');
  f.servers.delete(f.id);
});

test('corrupt recovery snapshots block both start and cancellation until recovery can safely restore originals', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('Fixture.jar', '2.0');
  f.stopped();
  const journal: AddonChangeJournal = { id: randomUUID(), serverId: f.id, state: 'applying', createdAt: new Date().toISOString(), beforeRows: [],
    targets: [{ type: 'plugin', fileName: 'Fixture.jar', beforeHash: sha(original), afterHash: sha(queued.bytes), backupIndex: 0 }] };
  const backup = path.join(f.backupsDirectory, f.id, 'addon-changes', journal.id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, '0.jar'), 'broken backup');
  await writeFile(path.join(f.plugins, 'Fixture.jar'), queued.bytes);
  f.pending.saveJournal(journal);
  const recovered = f.reopen();
  await recovered.recover();
  assert.equal(recovered.hasRecoveryBlock(f.id), true);
  assert.equal(recovered.capabilities(f.servers.require(f.id)).canMutate, false);
  assert.match(recovered.pendingError(f.id) ?? '', /missing or corrupt/);
  await assert.rejects(() => recovered.applyPending(f.servers.require(f.id)), { code: 'addon_recovery_required' });
  await assert.rejects(() => recovered.cancelPending(f.servers.require(f.id), queued.change.id), { code: 'addon_recovery_required' });
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), queued.bytes);
  await writeFile(path.join(backup, '0.jar'), original);
  await recovered.recover();
  assert.equal(recovered.hasRecoveryBlock(f.id), false);
  assert.deepEqual(await readFile(path.join(f.plugins, 'Fixture.jar')), original);
});

test('recovery never overwrites an externally changed JAR even when its snapshot is valid', async t => {
  const f = await fixture(t);
  const original = await f.install('Fixture.jar', '1.0');
  const queued = await f.queue('Fixture.jar', '2.0');
  f.stopped();
  const journal: AddonChangeJournal = { id: randomUUID(), serverId: f.id, state: 'applying', createdAt: new Date().toISOString(), beforeRows: [],
    targets: [{ type: 'plugin', fileName: 'Fixture.jar', beforeHash: sha(original), afterHash: sha(queued.bytes), backupIndex: 0 }] };
  const backup = path.join(f.backupsDirectory, f.id, 'addon-changes', journal.id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, '0.jar'), original);
  f.pending.saveJournal(journal);
  await writeFile(path.join(f.plugins, 'Fixture.jar'), 'external after crash');
  await f.service.recover();
  assert.equal(f.service.hasRecoveryBlock(f.id), true);
  assert.equal(await readFile(path.join(f.plugins, 'Fixture.jar'), 'utf8'), 'external after crash');
  assert.match(f.service.pendingError(f.id) ?? '', /changed outside NodePilot/);
});

test('maintenance excludes concurrent add-on work and shutdown waits for owned operations', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const work = f.service.mutate(f.servers.require(f.id), async () => { entered(); await gate; return 42; });
  await started;
  assert.equal(f.service.isBusy(f.id), true);
  assert.equal(f.service.anyBusy(), true);
  await assert.rejects(() => f.service.mutate(f.servers.require(f.id), async () => undefined), { code: 'addon_change_in_progress' });
  let didStop = false;
  const stop = f.service.stop().then(() => { didStop = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(didStop, false);
  release();
  assert.equal(await work, 42);
  await stop;
  assert.equal(f.service.anyBusy(), false);
  f.stopped();
  await assert.rejects(() => f.service.applyPending(f.servers.require(f.id)), { code: 'addon_shutdown' });
  await assert.rejects(() => f.service.mutate(f.servers.require(f.id), async () => undefined), { code: 'addon_shutdown' });
});
