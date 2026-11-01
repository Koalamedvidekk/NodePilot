import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawnUpdateHelper } from '../lib/update-process.js';
import { waitForUpdateHelper } from '../services/update-service.js';

test('Windows PowerShell updater normalizes readiness paths and survives its Node parent exiting', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-update-process-'));
  const ready = temporary + path.sep + '.' + path.sep + 'ready.json';
  const finished = path.join(temporary, "finished ' literal & $(noop).txt");
  const script = path.join(temporary, "helper with 'quotes' & $(literal).ps1");
  const log = path.join(temporary, 'helper.log');
  const harness = path.join(temporary, 'parent.mjs');
  let owner: ChildProcess | undefined;
  let helperPid: number | undefined;
  let stderr = '';
  try {
    await writeFile(script, [
      'param([int]$OwnerPid, [string]$ReadyFile, [string]$Finished)',
      "$ErrorActionPreference = 'Stop'",
      '$owner = Get-Process -Id $OwnerPid -ErrorAction Stop',
      '[System.IO.File]::WriteAllText($ReadyFile, (@{ ready = $true; pid = $PID } | ConvertTo-Json -Compress))',
      'if (-not $owner.WaitForExit(10000)) { throw "Parent did not exit" }',
      'Start-Sleep -Milliseconds 200',
      "[System.IO.File]::WriteAllText($Finished, 'completed after owner exit')",
      '',
    ].join('\r\n'));
    await copyFile(new URL('../../scripts/launch-update.ps1',import.meta.url),path.join(temporary,'launch-update.ps1'));
    await writeFile(harness, `
import { open } from 'node:fs/promises';
import { spawnUpdateHelper } from ${JSON.stringify(new URL('../lib/update-process.ts', import.meta.url).href)};
import { waitForUpdateHelper } from ${JSON.stringify(new URL('../services/update-service.ts', import.meta.url).href)};
const log = await open(${JSON.stringify(log)}, 'a');
try {
  const child = spawnUpdateHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(script)}, '-OwnerPid', String(process.pid), '-ReadyFile', ${JSON.stringify(ready)}, '-Finished', ${JSON.stringify(finished)}], ${JSON.stringify(temporary)}, log.fd);
  const readiness = waitForUpdateHelper(child, ${JSON.stringify(ready)}, 5000);
  child.unref();
  await readiness;
} finally { await log.close(); }
`);
    owner = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), harness], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    owner.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Node updater owner did not exit: ' + stderr)), 10_000);
      owner!.once('error', (error) => { clearTimeout(timeout); reject(error); });
      owner!.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(exit, 0, stderr+'\n'+await readFile(log,'utf8').catch(()=>''));
    const marker = JSON.parse(await readFile(ready, 'utf8')) as { ready: boolean; pid: number; helperPid: number };
    helperPid = marker.helperPid;
    assert.equal(marker.ready, true);
    assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    assert.notEqual(marker.pid,helperPid,'The bootstrap and independent helper must use different processes.');
    let result: string | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await readFile(finished, 'utf8').catch(() => null);
      if (result) break;
      await delay(50);
    }
    assert.equal(result, 'completed after owner exit', (await readFile(log, 'utf8'))+'\n'+await readFile(ready+'.stderr.log','utf8').catch(()=>''));
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
    // The benign helper has a ten-second self deadline. Give it time to release
    // its redirected log handle before removing the isolated test directory.
    for (let attempt = 0; attempt < 25; attempt++) {
      try { await rm(temporary, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 24) throw error; await delay(100); }
    }
  }
});

test('Windows updater bootstrap refuses a readiness marker from another helper PID', { skip: process.platform !== 'win32' }, async () => {
  const temporary=await mkdtemp(path.join(os.tmpdir(),'nodepilot-update-wrong-pid-'));
  const ready=path.join(temporary,'ready.json');
  const script=path.join(temporary,'wrong-pid.ps1');
  const logFile=path.join(temporary,'helper.log');
  let child:ChildProcess|undefined;
  const {open}=await import('node:fs/promises');
  const log=await open(logFile,'a');
  try{
    await copyFile(new URL('../../scripts/launch-update.ps1',import.meta.url),path.join(temporary,'launch-update.ps1'));
    await writeFile(script,[
      'param([string]$ReadyFile)',
      '[System.IO.File]::WriteAllText($ReadyFile, (@{ ready = $true; pid = $PID + 1 } | ConvertTo-Json -Compress))',
      'Start-Sleep -Milliseconds 300',
      'exit 17',
    ].join('\r\n'));
    child=spawnUpdateHelper('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ReadyFile',ready],temporary,log.fd);
    await assert.rejects(waitForUpdateHelper(child,ready,5000),/exited before it was ready/);
    await assert.rejects(readFile(ready),{code:'ENOENT'});
    assert.equal(JSON.parse(await readFile(ready+'.child','utf8')).ready,true,'The invalid child marker was inspected rather than accepted.');
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
    await log.close();
    assert.equal(path.dirname(temporary).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('nodepilot-update-wrong-pid-'));
    await rm(temporary,{recursive:true,force:true});
  }
});
