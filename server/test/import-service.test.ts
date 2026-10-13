import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  const argumentsDirectory = path.join(source, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.0.1');
  try {
    await mkdir(argumentsDirectory, { recursive: true });
    await writeFile(path.join(argumentsDirectory, 'win_args.txt'), '-Dexample=true\n');
    await writeFile(path.join(argumentsDirectory, 'unix_args.txt'), '-Dexample=true\n');
    await writeFile(path.join(source, 'server.properties'), 'server-port=25570\n');

    const service = new ImportService(path.join(root, 'managed'), path.join(root, 'data'));
    const inspection = await service.inspectDirectory(source);
    assert.equal(inspection.detectedSoftware, 'forge');
    assert.equal(inspection.minecraftVersion, '1.21.1');
    assert.equal(inspection.canImport, true);
    assert.deepEqual(inspection.startupConfig, {
      mode: 'arg-files',
      windowsArgFile: 'libraries/net/minecraftforge/forge/1.21.1-52.0.1/win_args.txt',
      linuxArgFile: 'libraries/net/minecraftforge/forge/1.21.1-52.0.1/unix_args.txt',
      jvmArgFiles: [],
      gameArguments: ['nogui'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
