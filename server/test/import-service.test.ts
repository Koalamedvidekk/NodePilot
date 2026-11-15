import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as yazl from 'yazl';

import { ImportService, safeArchiveRelative } from '../services/import-service.js';

test('safeArchiveRelative refuses archive traversal, absolute paths, and empty names', () => {
  assert.equal(safeArchiveRelative('world/playerdata/player.dat'), 'world/playerdata/player.dat');
  assert.equal(safeArchiveRelative('source/server.properties', 'source/'), 'server.properties');
  assert.equal(safeArchiveRelative(''), '');
  for (const unsafe of ['../server.jar', '/server.jar', 'C:/Windows/win.ini', 'world/../../server.jar', 'world\\..\\server.jar']) {
    assert.throws(() => safeArchiveRelative(unsafe), { code: 'unsafe_archive_path' });
  }
});

test('Forge argument-file layouts can be imported without a top-level server JAR', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-import-test-'));
  const source = path.join(root, 'source');
  const managed = path.join(root, 'managed');
  const argumentFolder = 'libraries/net/minecraftforge/forge/1.20.1-47.4.0';
  const properties = 'server-port=25565\nlevel-name=world\nmotd=Forge server\n';
  const eula = '# Original EULA file\neula=true\n';
  const files = {
    [`${argumentFolder}/win_args.txt`]: '--launchTarget forgeserver\n',
    [`${argumentFolder}/unix_args.txt`]: '--launchTarget forgeserver\n',
    [`${argumentFolder}/forge-1.20.1-47.4.0-server.jar`]: 'Fixture Forge library',
    'user_jvm_args.txt': '-Dexample=true\n',
    'world/level.dat': 'Fixture world data',
    'world/playerdata/12345678-1234-1234-1234-123456789abc.dat': 'Fixture player data',
    'mods/forge-mod.jar': 'Fixture mod',
    'mods/.cache/library.jar': 'Cached loader library',
    'plugins/.paper-remapped/remap-classpath/server.jar': 'Cached Paper runtime',
    'plugins/ExamplePlugin/lib/library.jar': 'Plugin data library',
    'config/forge-common.toml': 'fixture = true\n',
    'server.properties': properties,
    'eula.txt': eula,
  };
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const file = path.join(source, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }

    const service = new ImportService(managed, path.join(root, 'data'));
    const inspection = await service.inspectDirectory(source);
    assert.equal(inspection.detectedSoftware, 'forge');
    assert.equal(inspection.minecraftVersion, '1.20.1');
    assert.equal(inspection.serverJar, undefined);
    assert.equal(inspection.canImport, true);
    assert.deepEqual(inspection.worlds, ['world']);
    assert.equal(inspection.playerDataFiles, 1);
    assert.deepEqual(inspection.mods, ['forge-mod.jar']);
    assert.deepEqual(inspection.plugins, []);
    assert.deepEqual(inspection.startupConfig, {
      mode: 'arg-files',
      windowsArgFile: `${argumentFolder}/win_args.txt`,
      linuxArgFile: `${argumentFolder}/unix_args.txt`,
      jvmArgFiles: ['user_jvm_args.txt'],
      gameArguments: ['nogui'],
    });

    const prepared = await service.prepare({ type: 'directory', path: source });
    const copied = await service.copyIntoManagedServer(prepared, 'forge-copy', true, 25566);
    assert.equal(copied.loaderVersion, '47.4.0');
    assert.deepEqual(copied.startupConfig, inspection.startupConfig);
    assert.match(copied.warnings.join('\n'), /25565.*25566/);
    for (const [relativePath, content] of Object.entries(files)) {
      assert.equal(await readFile(path.join(source, relativePath), 'utf8'), content, `Original ${relativePath} changed`);
      const expectedCopy = relativePath === 'server.properties'
        ? properties.replace('25565', '25566')
        : relativePath === 'eula.txt' ? 'eula=true\n' : content;
      assert.equal(await readFile(path.join(managed, 'forge-copy', relativePath), 'utf8'), expectedCopy);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('imported Minecraft releases use Java 17 through 1.20.4 and Java 21 from 1.20.5', () => {
  const service = new ImportService('', '');
  for (const version of ['1.20', '1.20.1', '1.20.4']) assert.equal(service.requiredJavaMajor(version), 17);
  for (const version of ['1.20.5', '1.20.6', '1.21.4']) assert.equal(service.requiredJavaMajor(version), 21);
  assert.equal(service.requiredJavaMajor('26.1'), 25);
});

test('ZIPs without directory markers detect saved worlds and inspect a generic server.jar without changing the source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-import-zip-'));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('nodepilot-import-zip-'));
    await rm(root, { recursive: true, force: true });
  });
  const zip = async (entries: Array<[string, string | Buffer]>): Promise<Buffer> => {
    const archive = new yazl.ZipFile();
    const result = (async () => { const chunks: Buffer[] = []; for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); })();
    for (const [name, content] of entries) archive.addBuffer(Buffer.from(content), name);
    archive.end();
    return result;
  };
  const jar = await zip([['META-INF/MANIFEST.MF', 'Main-Class: io.papermc.paperclip.Main\n'], ['version.json', '{"id":"1.21.4"}']]);
  const source = await zip([['my-server/server.jar', jar], ['my-server/server.properties', 'server-port=25565\n'], ['my-server/world/level.dat', 'overworld metadata'], ['my-server/world_nether/level.dat', 'nether metadata'], ['my-server/world_the_end/level.dat', 'end metadata']]);
  const archive = path.join(root, 'source.zip');
  await writeFile(archive, source);
  const service = new ImportService(path.join(root, 'servers'), path.join(root, 'data'));
  const inspection = await service.inspectArchive(archive);
  assert.equal(inspection.detectedSoftware, 'paper');
  assert.equal(inspection.minecraftVersion, '1.21.4');
  assert.deepEqual(inspection.worlds, ['world', 'world_nether', 'world_the_end']);
  assert.equal(inspection.fileCount, 5);
  assert.equal(inspection.canImport, true);
  assert.deepEqual(await readFile(archive), source);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(path.join(root, 'data/import-inspections')), []);
});
