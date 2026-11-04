// Run after npm run build -w server. Uses a fresh compiled backend, temporary
// SQLite catalogue and harmless owned Node subprocesses instead of Minecraft.
// All add-on routes, file validation, queue storage and lifecycle hooks are real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yazl from 'yazl';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-addon-queue-api-'));
const dataDirectory = path.join(root, 'data');
const serverId = 'b57376ee-624e-45ed-9b14-804eef410b59';
const modServerId = '4b53c549-8280-4e30-a252-b8b65fa64b92';
const serverDirectory = path.join(dataDirectory, 'servers', 'plugin-fixture');
const modDirectory = path.join(dataDirectory, 'servers', 'mod-fixture');
const pin = 'addon-queue-test-pin';
const hold = path.join(root, 'hold-catalogue-download');
const entered = path.join(root, 'catalogue-download-entered');
const executable = process.platform === 'win32' ? 'fixture-node.exe' : 'fixture-node';
let child;
let output = '';
let database;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const running = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { running.kill('SIGKILL'); reject(new Error('Isolated add-on backend did not stop gracefully.')); }, 15_000);
    running.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Isolated add-on backend exited ' + code)); });
    if (process.platform === 'win32') running.send('test-shutdown');
    else running.kill('SIGTERM');
  });
  child = undefined;
}

async function jar(name, version, type = 'plugin') {
  const filename = path.join(root, name + '-' + version + '-' + type + '.jar');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(type === 'plugin' ? `name: ${name}\nversion: ${version}\napi-version: '1.20'\nmain: test.Fixture\n`
    : JSON.stringify({ schemaVersion: 1, id: name.toLowerCase(), name, version, environment: 'server' })), type === 'plugin' ? 'plugin.yml' : 'fabric.mod.json');
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(filename, { flags: 'wx' }));
  return readFile(filename);
}

async function fixtureServer(directory) {
  await mkdir(path.join(directory, 'plugins'), { recursive: true });
  await mkdir(path.join(directory, 'mods'), { recursive: true });
  await mkdir(path.join(directory, 'world'), { recursive: true });
  await writeFile(path.join(directory, 'server.properties'), '# retained\nlevel-name=world\nserver-port=25565\nmotd=Keep me\n');
  await copyFile(process.execPath, path.join(directory, executable));
  if (process.platform !== 'win32') await chmod(path.join(directory, executable), 0o755);
  await writeFile(path.join(directory, 'fake-game.mjs'), `
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const files = {};
for (const folder of ['plugins','mods']) for (const name of readdirSync(folder).filter(name=>/\\.jar$/i.test(name))) {
  files[folder+'/'+name] = createHash('sha256').update(readFileSync(folder+'/'+name)).digest('hex');
}
appendFileSync('launches.jsonl', JSON.stringify(files)+'\\n');
console.log('Fixture process ready');
process.stdin.setEncoding('utf8');
process.stdin.on('data', text=>{if(text.split(/\\r?\\n/).includes('stop'))process.exit(0);});
setInterval(()=>{},1000);
`);
}

async function launches(directory) {
  return (await readFile(path.join(directory, 'launches.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function backupHashes(directory) {
  const result = [];
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && /\.jar$/i.test(entry.name)) result.push(sha(await readFile(next)));
    }
  };
  await walk(directory);
  return result;
}

try {
  const port = await freePort();
  await fixtureServer(serverDirectory);
  await fixtureServer(modDirectory);
  const original = await jar('Original', '1.0');
  const updated = await jar('Original', '2.0');
  const later = await jar('Original', '3.0');
  const external = await jar('Original', '99.0');
  const removable = await jar('Removable', '1.0');
  const newPlugin = await jar('NewPlugin', '1.0');
  const oldMod = await jar('FabricFixture', '1.0', 'mod');
  const newMod = await jar('FabricFixture', '2.0', 'mod');
  const catalogue = await jar('CatalogueFixture', '1.0');
  await writeFile(path.join(root, 'catalogue.jar'), catalogue);
  await writeFile(path.join(serverDirectory, 'plugins', 'Original.jar'), original);
  await writeFile(path.join(serverDirectory, 'plugins', 'Removable.jar'), removable);
  await writeFile(path.join(modDirectory, 'mods', 'FabricFixture.jar'), oldMod);
  await mkdir(path.join(root, 'server'), { recursive: true });
  await cp(path.join(projectRoot, 'server', 'dist'), path.join(root, 'server', 'dist'), { recursive: true });
  await cp(path.join(projectRoot, 'package.json'), path.join(root, 'package.json'));
  await cp(path.join(projectRoot, 'server', 'package.json'), path.join(root, 'server', 'package.json'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, '.env'), [
    'NODEPILOT_HOST=127.0.0.1', 'NODEPILOT_PORT=' + port, 'NODEPILOT_PIN=' + pin,
    'NODEPILOT_DATA_DIR="' + dataDirectory.replaceAll('\\', '/') + '"',
    'NODEPILOT_CLIENT_DIST="' + path.join(root, 'no-client').replaceAll('\\', '/') + '"', 'NODEPILOT_LOG_LEVEL=error',
  ].join('\n'));
  await writeFile(path.join(root, 'run.mjs'), `
import { access, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PlayitService } from './server/dist/services/playit-service.js';
PlayitService.prototype.getStatus = async () => ({ installed:false,isManaged:false,binaryPath:null,version:null,isRunning:false,secretExists:false,secretPath:null,claimUrl:null });
// The only fake network source is a checksum-verified local catalogue fixture.
// Its scheduling gate keeps a real add-on mutation open for exclusion checks.
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async (input,init)=>{
  const url=String(input);
  if(url.startsWith('https://api.modrinth.com/v2/project/fixtureproject/version?')) return new Response(JSON.stringify([{
    id:'fixture-version', name:'Fixture 1.0',version_number:'1.0',game_versions:['1.20.1'],loaders:['paper'],dependencies:[],
    files:[{filename:'CatalogueFixture.jar',url:'https://cdn.modrinth.com/data/fixture.jar',primary:true,size:${catalogue.length},hashes:{sha512:${JSON.stringify(createHash('sha512').update(catalogue).digest('hex'))}}}]
  }]),{headers:{'content-type':'application/json'}});
  if(url==='https://cdn.modrinth.com/data/fixture.jar'){
    await writeFile(${JSON.stringify(entered)},'entered');
    while(await access(${JSON.stringify(hold)}).then(()=>true,()=>false)) await delay(20);
    const bytes=await readFile(${JSON.stringify(path.join(root, 'catalogue.jar'))});
    return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
  }
  return fetchOriginal(input,init);
};
await import('./server/dist/index.js');
process.on('message',message=>{if(message==='test-shutdown')process.emit('SIGTERM');});
`);
  const { openDatabase } = await import(pathToFileURL(path.join(root, 'server/dist/db.js')).href);
  const { ServerRepository } = await import(pathToFileURL(path.join(root, 'server/dist/repositories/server-repository.js')).href);
  database = openDatabase(path.join(dataDirectory, 'nodepilot.sqlite'));
  const servers = new ServerRepository(database);
  for (const [id, software, directory, gamePort] of [[serverId, 'paper', 'plugin-fixture', 25565], [modServerId, 'fabric', 'mod-fixture', 25566]]) {
    servers.create({ id, machineId:'local',name:'Isolated '+software+' add-ons',directory,software,version:'1.20.1',port:gamePort,memoryMb:1024,eulaAccepted:true,
      startupConfig:{mode:'executable',executablePath:executable,gameArguments:['fake-game.mjs']} });
    servers.markReady(id);
  }
  servers.setCache('minecraft:paper-available-versions',[{id:'1.20.1',stable:true}]);
  database.close(); database = undefined;
  const baseUrl = 'http://127.0.0.1:' + port;
  async function request(target, { method = 'GET', body, form, authenticated = true } = {}) {
    const response = await fetch(baseUrl + '/api' + target, { method, signal:AbortSignal.timeout(20_000),
      headers:{...(authenticated?{'x-nodepilot-pin':pin}:{}),...(body===undefined?{}:{'content-type':'application/json'})},
      ...(form?{body:form}:body===undefined?{}:{body:JSON.stringify(body)}),
    });
    const text = await response.text();
    return { status:response.status,body:text?JSON.parse(text):null };
  }
  const route = id => '/servers/' + id;
  const addons = async id => {
    const result = await request(route(id) + '/addons');
    assert.equal(result.status,200,JSON.stringify(result.body)); return result.body;
  };
  const success = result => { assert.ok(result.status>=200&&result.status<300,JSON.stringify(result)); return result.body; };
  async function upload(id, type, bytes, filename) {
    const form = new FormData(); form.append('file',new Blob([bytes],{type:'application/java-archive'}),filename);
    return request(route(id)+'/addons/upload?type='+type,{method:'POST',form});
  }
  async function startChild() {
    output='';
    child=spawn(process.execPath,[path.join(root,'run.mjs')],{cwd:root,env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.on('data',chunk=>{output=(output+chunk).slice(-24_000);}); child.stderr.on('data',chunk=>{output=(output+chunk).slice(-24_000);});
    let spawnError; child.once('error',error=>{spawnError=error;});
    for(let attempt=0;attempt<150;attempt++){
      if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('Isolated add-on backend exited: '+output);
      try{if((await request('/health')).status===200)return;}catch{}
      await delay(100);
    }
    throw new Error('Isolated add-on backend never started: '+output);
  }
  async function launch(id, directory, action='start') {
    const before=(await launches(directory)).length;
    success(await request(route(id)+'/'+action,{method:'POST'}));
    for(let attempt=0;attempt<100;attempt++){
      const current=await launches(directory);
      if(current.length>before)return current.at(-1);
      await delay(30);
    }
    throw new Error('Managed fixture process never reached its real startup marker.');
  }
  const cancel = (id, changeId) => request(route(id)+'/addons/pending/'+changeId,{method:'DELETE',body:{confirm:true}});
  await startChild();
  assert.equal((await request(route(serverId)+'/addons',{authenticated:false})).status,401);
  assert.equal((await request(route(serverId)+'/addons/pending/not-a-uuid',{method:'DELETE',body:{confirm:true}})).status,400);
  await launch(serverId,serverDirectory);
  const first=success(await upload(serverId,'plugin',updated,'Original.jar'));
  assert.equal(first.queued,true);
  const addition=success(await upload(serverId,'plugin',newPlugin,'NewPlugin.jar'));assert.equal(addition.queued,true);
  const removal=success(await request(route(serverId)+'/addons/plugin/Removable.jar',{method:'DELETE',body:{confirm:true}}));assert.equal(removal.queued,true);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),original);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Removable.jar')),removable);
  assert.equal((await readdir(path.join(serverDirectory,'plugins'))).includes('NewPlugin.jar'),false);
  let listing=await addons(serverId);
  assert.equal(listing.pendingChanges.length,3);
  assert.equal(listing.plugins.find(item=>item.fileName==='Original.jar').metadata.version,'1.0');
  assert.equal((await upload(serverId,'mod',newMod,'wrong-loader.jar')).status,422);
  assert.equal((await upload(serverId,'plugin',Buffer.from('not a jar'),'broken.jar')).status,400);
  console.log('PASS authenticated running-server uploads/removal remain queued and never modify live plugin JARs');

  const change=listing.pendingChanges.find(item=>item.fileName==='NewPlugin.jar');
  success(await cancel(serverId,change.id));
  assert.equal((await addons(serverId)).pendingChanges.length,2);
  assert.equal((await cancel(modServerId,change.id)).status,404);
  success(await upload(serverId,'plugin',newPlugin,'NewPlugin.jar'));
  await stopChild(); await startChild();
  listing=await addons(serverId);assert.equal(listing.pendingChanges.length,3);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),original);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Removable.jar')),removable);
  assert.equal((await request(route(serverId))).body.server.status,'stopped');
  assert.equal((await request(route(serverId)+'/versions/install',{method:'POST',body:{version:'1.20.2',confirm:true}})).status,409);
  assert.equal((await request(route(serverId)+'/versions/check',{method:'POST'})).status,200);
  assert.equal((await addons(serverId)).pendingChanges.length,3);
  await rename(path.join(serverDirectory,executable),path.join(serverDirectory,executable+'.held'));
  const missingExecutable=await request(route(serverId)+'/start',{method:'POST'});
  assert.ok(missingExecutable.status>=400);assert.equal((await addons(serverId)).pendingChanges.length,3);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),original);
  await rename(path.join(serverDirectory,executable+'.held'),path.join(serverDirectory,executable));
  const snapshot=await launch(serverId,serverDirectory);
  assert.equal(snapshot['plugins/Original.jar'],sha(updated));assert.equal(snapshot['plugins/NewPlugin.jar'],sha(newPlugin));assert.equal(snapshot['plugins/Removable.jar'],undefined);
  assert.equal((await addons(serverId)).pendingChanges.length,0);
  const backup=await backupHashes(path.join(dataDirectory,'backups'));assert.ok(backup.includes(sha(original)));assert.ok(backup.includes(sha(removable)));
  console.log('PASS pending changes/cancellation survive panel restart and apply with backups before the next real managed process launches');

  success(await upload(serverId,'plugin',later,'Original.jar'));
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),updated);
  const restarted=await launch(serverId,serverDirectory,'restart');assert.equal(restarted['plugins/Original.jar'],sha(later));
  assert.equal((await addons(serverId)).pendingChanges.length,0);
  success(await upload(serverId,'plugin',updated,'Original.jar'));
  success(await request(route(serverId)+'/stop',{method:'POST'}));
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),later);
  await writeFile(path.join(serverDirectory,'plugins/Original.jar'),external);
  const launchCount=(await launches(serverDirectory)).length;
  const stale=await request(route(serverId)+'/start',{method:'POST'});assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.equal((await launches(serverDirectory)).length,launchCount);assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/Original.jar')),external);
  listing=await addons(serverId);assert.equal(listing.pendingChanges.length,1);assert.ok(listing.pendingError||listing.pendingChanges[0].error);
  success(await cancel(serverId,listing.pendingChanges[0].id));assert.equal((await addons(serverId)).pendingChanges.length,0);
  console.log('PASS restart applies queued changes; plain stop leaves them pending; stale live files block startup without overwriting external changes');

  await launch(modServerId,modDirectory);
  const mod=success(await upload(modServerId,'mod',newMod,'FabricFixture.jar'));assert.equal(mod.queued,true);
  assert.deepEqual(await readFile(path.join(modDirectory,'mods/FabricFixture.jar')),oldMod);
  const modRestart=await launch(modServerId,modDirectory,'restart');assert.equal(modRestart['mods/FabricFixture.jar'],sha(newMod));
  assert.equal((await addons(modServerId)).pendingChanges.length,0);
  success(await request(route(modServerId)+'/stop',{method:'POST'}));
  console.log('PASS loader mods use the same deferred lifecycle while remaining distinct from plugins');

  await writeFile(hold,'hold');
  const downloading=request(route(serverId)+'/addons/modrinth',{method:'POST',body:{type:'plugin',projectId:'fixtureproject'}});
  for(let attempt=0;attempt<100;attempt++){if(await readFile(entered,'utf8').catch(()=>null))break;await delay(25);}
  assert.equal(await readFile(entered,'utf8'),'entered');
  assert.equal((await request(route(serverId)+'/start',{method:'POST'})).status,409);
  assert.equal((await request(route(serverId)+'/files/content',{method:'PUT',body:{path:'server.properties',content:'level-name=unsafe\n'}})).status,409);
  assert.equal((await request(route(serverId)+'/versions/install',{method:'POST',body:{version:'1.20.2',confirm:true}})).status,409);
  assert.equal((await request('/host/updates/install',{method:'POST'})).status,409);
  await rm(hold,{force:true});
  const immediate=success(await downloading);assert.equal(immediate.queued,false);
  assert.deepEqual(await readFile(path.join(serverDirectory,'plugins/CatalogueFixture.jar')),catalogue);
  assert.match(await readFile(path.join(serverDirectory,'server.properties'),'utf8'),/motd=Keep me/);
  console.log('PASS add-on downloads share maintenance exclusion with starts, files, Minecraft versions and panel updates');
} catch(error) {
  if(output)console.error('Isolated add-on backend output:\n'+output);
  throw error;
} finally {
  if(database)database.close();
  await rm(hold,{force:true});
  await stopChild();
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('nodepilot-addon-queue-api-'));
  await rm(root,{recursive:true,force:true});
}
