import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** File-backed stdio and unref let the helper outlive NodePilot on either OS. */
export function spawnUpdateHelper(command: string, args: string[], cwd: string, logFd: number): ChildProcess {
  let launchCommand=command;
  let launchArgs=args;
  if(process.platform==='win32'){
    const fileIndex=args.indexOf('-File');
    const readyIndex=args.indexOf('-ReadyFile');
    if(fileIndex<0||!args[fileIndex+1]||readyIndex<0||!args[readyIndex+1])throw new Error('The Windows updater requires a script and readiness file.');
    const script=args[fileIndex+1];
    const childArgs=args.slice(fileIndex+2);
    const childReadyIndex=childArgs.indexOf('-ReadyFile');
    if(childReadyIndex<0)throw new Error('The Windows updater readiness argument is missing.');
    childArgs[childReadyIndex+1]=args[readyIndex+1]+'.child';
    launchCommand='powershell.exe';
    launchArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(path.dirname(script),'launch-update.ps1'),
      '-ScriptFile',script,'-ArgumentsBase64',Buffer.from(JSON.stringify(childArgs),'utf8').toString('base64'),'-ReadyFile',args[readyIndex+1]];
  }
  // DETACHED_PROCESS can make Windows PowerShell exit without executing. The
  // verified bootstrap instead creates an independent hidden console, confirms
  // the real helper PID, then relays readiness using its own managed child PID.
  return spawn(launchCommand, launchArgs, {
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
}
