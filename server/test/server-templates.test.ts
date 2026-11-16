import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db.js';
import { parseJavaProperties } from '../lib/java-properties.js';
import { filterTemplateVersions, listServerTemplates, requireServerTemplate, resolveServerTemplate } from '../lib/server-templates.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { MinecraftService } from '../services/minecraft-service.js';
import type { MinecraftVersion, ServerRecord } from '../types.js';

test('templates are isolated configuration presets with explicit software compatibility', () => {
  const templates = listServerTemplates();
  assert.deepEqual(templates.map(item => item.id), ['smp', 'pure-vanilla', 'creative', 'hardcore']);
  assert.deepEqual(requireServerTemplate('pure-vanilla').software, ['vanilla']);
  templates[0].defaults.maxPlayers = 999;
  templates[0].software.push('forge');
  assert.equal(requireServerTemplate('smp').defaults.maxPlayers, 20);
  assert.throws(() => requireServerTemplate('smp', 'forge'), /compatible software/);
  assert.throws(() => requireServerTemplate('pure-vanilla', 'paper'), /compatible software/);
  assert.throws(() => requireServerTemplate('creative', 'bedrock'), /compatible software/);
  assert.throws(() => requireServerTemplate('../smp'), /available server template/);
});

test('version choices retain only available stable upstream releases supported by the template', () => {
  const versions: MinecraftVersion[] = [
    { id: '26.3', type: 'release', releaseTime: null, available: true },
    { id: '1.21.4', type: 'release', releaseTime: null, available: true },
    { id: '1.8', type: 'release', releaseTime: null, available: true },
    { id: '1.7.10', type: 'release', releaseTime: null, available: true },
    { id: '26.4-pre1', type: 'snapshot', releaseTime: null, available: true },
    { id: '1.20.1', type: 'release', releaseTime: null, available: false },
  ];
  assert.deepEqual(filterTemplateVersions(requireServerTemplate('pure-vanilla'), versions).map(item => item.id), ['26.3', '1.21.4', '1.8']);
  for (const version of ['1.7.10', '1.21.5-pre1', '../26.3']) {
    assert.throws(() => resolveServerTemplate('pure-vanilla', 'vanilla', version), /stable Minecraft Java release/);
  }
});

test('template configuration adapts legacy game-mode/difficulty encodings and retains exact seeds', () => {
  const seed = '-9223372036854775808';
  for (const version of ['1.8', '1.12.2', '1.13.2', '1.14', '1.21.4', '26.3']) {
    const result = resolveServerTemplate('creative', 'vanilla', version, { seed, maxPlayers: 12, viewDistance: 6 })!;
    const legacy = ['1.8', '1.12.2', '1.13.2'].includes(version);
    assert.equal(result.properties.gamemode, legacy ? '1' : 'creative');
    assert.equal(result.properties.difficulty, legacy ? '0' : 'peaceful');
    assert.equal(result.properties['level-seed'], seed);
    assert.equal(result.properties['max-players'], '12');
    assert.equal(result.properties['view-distance'], '6');
    assert.equal(result.properties['generate-structures'], 'true');
  }
  const hardcore = resolveServerTemplate('hardcore', 'paper', '1.21.4')!;
  assert.equal(hardcore.properties.hardcore, 'true');
  assert.equal(hardcore.properties.gamemode, 'survival');
  assert.equal(hardcore.properties.difficulty, 'hard');
  assert.throws(() => resolveServerTemplate('hardcore', 'vanilla', '1.21.4', { gameMode: 'creative' }), /Hardcore requires/);
  assert.throws(() => resolveServerTemplate('hardcore', 'vanilla', '1.21.4', { difficulty: 'easy' }), /Hardcore requires/);
});

test('untrusted template overrides cannot inject properties or bypass authentication and validation', () => {
  assert.equal(resolveServerTemplate(undefined, 'vanilla', '1.21.4'), undefined);
  assert.throws(() => resolveServerTemplate(undefined, 'vanilla', '1.21.4', {}), /Choose a template/);
  const invalid = [ { maxPlayers: 0 }, { maxPlayers: 1001 }, { maxPlayers: 1.5 }, { viewDistance: 2 },
    { viewDistance: 33 }, { whitelist: 'false' }, { gameMode: 'invalid' }, { seed: 'seed\nonline-mode=false' },
    { seed: 'a'.repeat(129) }, { 'online-mode': false }, { 'server-port': 1 }, { __proto__: null, javaPath: '/tmp/java' } ];
  for (const values of invalid) assert.throws(() => resolveServerTemplate('smp', 'paper', '1.21.4', values as never));
});

test('creation writes customized templates to real properties while ordinary setup stays unchanged', async t => {
  const temp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temp, 'nodepilot-templates-'));
  const database = openDatabase(path.join(root, 'nodepilot.sqlite'));
  const repository = new ServerRepository(database);
  const service = new MinecraftService(repository, path.join(root, 'servers'));
  t.after(async () => {
    database.close();
    assert.equal(path.dirname(root), temp);
    assert.ok(path.basename(root).startsWith('nodepilot-templates-'));
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(service, 'stageRuntime', async (server: ServerRecord, directory: string) => {
    await writeFile(path.join(directory, 'server.jar'), 'isolated trusted-download stand-in');
    return { software: server.software as 'vanilla', loaderVersion: null,
      startupConfig: { mode: 'jar' as const, jarPath: 'server.jar', gameArguments: ['nogui'] } };
  });
  for (const templateId of ['smp', 'pure-vanilla', 'creative', 'hardcore', undefined]) {
    const id = randomUUID();
    const definition = templateId ? requireServerTemplate(templateId) : undefined;
    const software = definition?.defaultSoftware ?? 'vanilla';
    const server = repository.create({ id, machineId: 'local', name: 'A world: \\ friendly = name', directory: id,
      software, version: '1.21.4', port: 25565 + repository.list().length, memoryMb: 2048, eulaAccepted: true });
    const template = resolveServerTemplate(templateId, software, server.version,
      templateId ? { seed: '9223372036854775807', whitelist: true, maxPlayers: 7 } : undefined);
    await service.install(server, template);
    const directory = path.join(root, 'servers', server.directory);
    const properties = parseJavaProperties(await readFile(path.join(directory, 'server.properties'), 'utf8'));
    assert.equal(properties.motd, server.name);
    assert.equal(properties['online-mode'], 'true');
    assert.equal(properties['enable-rcon'], 'false');
    assert.equal(properties['server-port'], String(server.port));
    if (template) for (const [key, value] of Object.entries(template.properties)) assert.equal(properties[key], value);
    else { assert.equal(properties.gamemode, undefined); assert.equal(properties['max-players'], '20'); }
    assert.equal(await readFile(path.join(directory, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.deepEqual((await readdir(directory)).sort(), ['eula.txt', 'server.jar', 'server.properties']);
    assert.equal(repository.markReady(id).status, 'offline');
  }
});
