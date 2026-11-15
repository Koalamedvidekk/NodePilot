import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import * as yazl from 'yazl';
import { inspectJar } from '../services/jar-inspection.js';
import { addonCompatibility } from '../services/addon-service.js';

test('uploaded Fabric and Quilt descriptors retain their declared environment for server compatibility checks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-jar-environment-'));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('nodepilot-jar-environment-'));
    await rm(root, { recursive: true, force: true });
  });
  for (const software of ['fabric', 'quilt'] as const) {
    for (const side of ['client', software === 'quilt' ? 'dedicated_server' : 'server', '*', undefined]) {
      const filename = path.join(root, software + '-' + (side === '*' ? 'both' : side ?? 'default') + '.jar');
      const archive = new yazl.ZipFile();
      const completed = pipeline(archive.outputStream, createWriteStream(filename, { flags: 'wx' }));
      const identity = { id: 'test_mod', version: '1.0.0', name: 'Test Mod' };
      const descriptor = software === 'fabric' ? { ...identity, environment: side }
        : { schema_version: 1, quilt_loader: { ...identity, metadata: { name: identity.name } }, minecraft: { environment: side } };
      archive.addBuffer(Buffer.from(JSON.stringify(descriptor)), software + '.mod.json');
      archive.end();
      await completed;
      const metadata = await inspectJar(filename);
      assert.equal(metadata.name, 'Test Mod');
      assert.equal(metadata.version, '1.0.0');
      assert.equal(metadata.environment, side === 'client' ? 'client' : side === undefined || side === '*' ? '*' : 'server');
      assert.equal(addonCompatibility('mod', { software, version: '1.21.4' }, metadata).compatible, side !== 'client');
    }
  }
});
