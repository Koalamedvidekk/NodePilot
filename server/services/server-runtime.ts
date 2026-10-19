import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../lib/errors.js';
import { resolveInside, resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import type { ConsoleLine, ServerEvent, ServerRecord, ServerStartupConfig, ServerStatus } from '../types.js';

const MAX_LOG_LINES = 1_200;
const MAX_COMMAND_LENGTH = 500;
const MAX_PENDING_OUTPUT_BYTES = 32_768;
const GRACEFUL_STOP_MS = 20_000;
const FORCE_STOP_MS = 7_000;

/**
 * Keep the JVM's starting heap smaller than its configured ceiling.  Using the same value
 * for -Xms and -Xmx commits the entire allocation up front, which makes an idle server
 * look as though it is consuming all of its configured memory.  The heap can still grow
 * to the user's selected limit when players or world generation need it.
 */
export function initialHeapMb(maxHeapMb: number): number {
  return Math.min(maxHeapMb, Math.max(512, Math.min(1_024, Math.floor(maxHeapMb / 4))));
}

function validGameArgument(value: string): boolean {
  // Installer metadata supplies the launcher arguments. Keep this intentionally small so a
  // tampered SQLite row cannot turn into an arbitrary JVM argument or another @argfile.
  return value === 'nogui' || value === '--nogui';
}

async function requireRegularManagedFile(directory: string, relativePath: string, label: string): Promise<string> {
  let target: string;
  try {
    target = await resolveInside(directory, relativePath);
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new AppError(409, 'unsafe_startup_file', 'NodePilot refused an invalid ' + label + '. Reinstall this server.');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'startup_file_missing', 'The required ' + label + ' is missing. Reinstall this server.');
  }
  return target;
}

async function launchArguments(
  directory: string,
  startup: ServerStartupConfig,
  initialMemoryMb: number,
  maximumMemoryMb: number,
  customJvmArgs: string[] = [],
): Promise<{ args: string[]; description: string }> {
  if (startup.mode === 'executable') {
    return {
      args: [...startup.gameArguments],
      description: 'server executable',
    };
  }
  if (!startup.gameArguments.every(validGameArgument)) {
    throw new AppError(409, 'unsafe_startup_arguments', 'NodePilot refused unexpected launcher arguments. Reinstall this server.');
  }
  const memory = ['-Xms' + initialMemoryMb + 'M', '-Xmx' + maximumMemoryMb + 'M', ...customJvmArgs];
  if (startup.mode === 'jar') {
    const jarPath = await requireRegularManagedFile(directory, startup.jarPath, 'server JAR');
    return {
      args: [...memory, '-jar', jarPath, ...startup.gameArguments],
      description: 'server JAR',
    };
  }

  const platformArgFile = process.platform === 'win32' ? startup.windowsArgFile : startup.linuxArgFile;
  await requireRegularManagedFile(directory, platformArgFile, 'loader launch argument file');
  for (const file of startup.jvmArgFiles) {
    await requireRegularManagedFile(directory, file, 'loader JVM argument file');
  }
  // The NodePilot heap flags intentionally follow any installer-created user JVM args so the
  // stopped-server memory control remains authoritative. All files were checked above and are
  // passed as direct Java arguments, never through a shell.
  return {
    args: [
      ...startup.jvmArgFiles.map((file) => '@' + file.replaceAll('\\', '/')),
      ...memory,
      '@' + platformArgFile.replaceAll('\\', '/'),
      ...startup.gameArguments,
    ],
    description: 'loader argument files',
  };
}

type RuntimeProcess = {
  child: ChildProcessWithoutNullStreams;
  /**
   * A per-spawn identity. PIDs are deliberately not persisted because an operating system may
   * reuse them after a process exits. Metrics consumers must hold this identity as well as the
   * PID and may only inspect a process while it remains in this in-memory map.
   */
  runtimeId: string;
  startedAt: string;
  stopping: boolean;
  fatalError?: string;
  closePromise: Promise<void>;
  resolveClose: () => void;
};

export interface ManagedProcessInfo {
  pid: number;
  runtimeId: string;
  startedAt: string;
}

function cleanLine(line: string): string {
  // Minecraft colors use ANSI escapes; browser output should remain readable and untrusted log
  // content is always rendered as text by the UI.
  return line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r$/, '').slice(0, 16_000);
}

/**
 * Owns the child processes started by this NodePilot process. It deliberately never tries to
 * rediscover or kill persisted PIDs after an application restart, preventing PID-reuse damage.
 */
export class ServerRuntime extends EventEmitter {
  private readonly processes = new Map<string, RuntimeProcess>();
  private readonly logs = new Map<string, ConsoleLine[]>();

  constructor(
    private readonly repository: ServerRepository,
    private readonly serversDirectory: string,
    private readonly settingsRepository?: ServerSettingsRepository,
  ) {
    super();
  }

  getLogs(serverId: string, tail = 300): ConsoleLine[] {
    const safeTail = Math.max(1, Math.min(tail, MAX_LOG_LINES));
    return (this.logs.get(serverId) ?? []).slice(-safeTail);
  }

  status(serverId: string): ServerStatus | undefined {
    return this.repository.find(serverId)?.status;
  }

  /**
   * Returns an active child process owned by this NodePilot instance. This is intentionally not
   * backed by database state: after a NodePilot restart an old PID must never be rediscovered,
   * inspected, or terminated because it could belong to an unrelated process.
   */
  getProcessInfo(serverId: string): ManagedProcessInfo | undefined {
    const runtime = this.processes.get(serverId);
    const pid = runtime?.child.pid;
    if (!runtime || runtime.stopping || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return {
      pid,
      runtimeId: runtime.runtimeId,
      startedAt: runtime.startedAt,
    };
  }

  isProcessActive(serverId: string): boolean {
    return this.processes.has(serverId);
  }

  async start(server: ServerRecord, javaPath?: string, warning?: string): Promise<ServerRecord> {
    if (server.installState !== 'ready') {
      throw new AppError(409, 'server_not_ready', 'This server is still installing or its installation failed.');
    }
    if (this.processes.has(server.id) || ['starting', 'running', 'stopping'].includes(server.status)) {
      throw new AppError(409, 'server_already_active', 'This server is already running or changing state.');
    }

    const directory = await resolveManagedServerRoot(this.serversDirectory, server.directory);
    const startup = server.startupConfig;
    const isExecutable = startup.mode === 'executable';
    let child: ChildProcessWithoutNullStreams;

    if (startup.mode === 'executable') {
      const exePath = await requireRegularManagedFile(directory, startup.executablePath, 'server executable');
      const env = { ...process.env };
      if (process.platform === 'linux') {
        env.LD_LIBRARY_PATH = `${directory}:${env.LD_LIBRARY_PATH ?? ''}`;
      }
      try {
        child = spawn(exePath, startup.gameArguments, {
          cwd: directory,
          env,
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The server executable could not be started.';
        const updated = this.repository.setStatus(server.id, 'error', { lastError: message });
        this.emitStatus(updated);
        throw new AppError(500, 'executable_start_failed', message);
      }
    } else {
      if (!javaPath) {
        throw new AppError(422, 'java_missing', 'A compatible Java installation is required to start this server.');
      }
      const settings = this.settingsRepository?.find(server.id);
      const initialMemoryMb = settings?.minMemoryMb ?? initialHeapMb(server.memoryMb);
      const customJvmArgs = settings?.customJvmArgs ?? [];
      const launch = await launchArguments(directory, startup, initialMemoryMb, server.memoryMb, customJvmArgs);
      const args = launch.args;
      try {
        child = spawn(javaPath, args, {
          cwd: directory,
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The Java process could not be started.';
        const updated = this.repository.setStatus(server.id, 'error', { lastError: message });
        this.emitStatus(updated);
        throw new AppError(500, 'java_start_failed', message);
      }
    }

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    const runtime: RuntimeProcess = {
      child,
      runtimeId: randomUUID(),
      startedAt: new Date().toISOString(),
      stopping: false,
      closePromise,
      resolveClose,
    };
    this.processes.set(server.id, runtime);
    let updated = this.repository.setStatus(server.id, 'starting', {
      lastError: warning ?? null,
      lastStartedAt: runtime.startedAt,
    });
    this.emitStatus(updated);
    this.appendLog(server.id, {
      timestamp: new Date().toISOString(),
      stream: 'system',
      message: startup.mode === 'executable'
        ? `Starting Bedrock Dedicated Server (${startup.executablePath})...`
        : `Starting Java ${javaPath} with ${initialHeapMb(server.memoryMb)} MB initial heap and ${server.memoryMb} MB maximum heap.`,
    });
    if (warning) this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: warning });

    this.pipeOutput(server.id, child.stdout, 'stdout', runtime);
    this.pipeOutput(server.id, child.stderr, 'stderr', runtime);
    child.stdin.on('error', (error) => {
      this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: `Console input closed: ${error.message}` });
    });

    child.once('spawn', () => {
      const fresh = this.repository.find(server.id);
      if (!fresh || fresh.status !== 'starting') return;
      updated = this.repository.setStatus(server.id, 'running', { lastError: warning ?? null });
      this.emitStatus(updated);
    });

    child.once('error', (error) => {
      runtime.fatalError = isExecutable ? `Server failed to start: ${error.message}` : `Java failed to start: ${error.message}`;
      this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: runtime.fatalError });
      const current = this.repository.find(server.id);
      if (current && current.status !== 'offline') {
        this.emitStatus(this.repository.setStatus(server.id, 'error', { lastError: runtime.fatalError }));
      }
      // A spawn failure may emit `error` without a later `close`. Release ownership in that
      // case so a corrected Java installation can be selected and started again.
      if (!child.pid) {
        this.processes.delete(server.id);
        runtime.resolveClose();
      }
    });

    child.once('close', (code, signal) => {
      const latest = this.repository.find(server.id);
      const requestedStop = runtime.stopping || latest?.status === 'stopping';
      const detail = code === 0 || requestedStop
        ? `Server process stopped${signal ? ` (${signal})` : ''}.`
        : `Server process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
      this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: detail });
      this.processes.delete(server.id);
      runtime.resolveClose();
      if (!latest) return;
      const failed = !requestedStop && (code !== 0 || Boolean(runtime.fatalError));
      this.emitStatus(this.repository.setStatus(server.id, failed ? 'error' : 'offline', {
        lastError: failed ? runtime.fatalError ?? detail : null,
        lastStoppedAt: new Date().toISOString(),
      }));
    });

    return updated;
  }

  async stop(server: ServerRecord): Promise<ServerRecord> {
    const runtime = this.processes.get(server.id);
    if (!runtime) {
      if (server.status === 'offline') return server;
      throw new AppError(409, 'server_not_managed', 'This server is not running under this NodePilot process.');
    }
    if (runtime.stopping) return this.repository.find(server.id) ?? server;
    runtime.stopping = true;
    const updated = this.repository.setStatus(server.id, 'stopping');
    this.emitStatus(updated);
    this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: 'Requesting graceful shutdown.' });
    try {
      runtime.child.stdin.write('stop\n');
    } catch {
      // The close handler will record any outcome. Continue with bounded forced cleanup.
    }

    const settings = this.settingsRepository?.find(server.id);
    const gracefulStopMs = (settings?.shutdownTimeoutSeconds ?? 20) * 1000;

    const gracefulTimer = setTimeout(() => {
      if (this.processes.get(server.id) !== runtime) return;
      this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: 'Graceful shutdown timed out; terminating the tracked process.' });
      this.terminateTrackedProcess(runtime.child);
    }, gracefulStopMs);
    gracefulTimer.unref();
    const hardTimer = setTimeout(() => {
      if (this.processes.get(server.id) !== runtime) return;
      this.appendLog(server.id, { timestamp: new Date().toISOString(), stream: 'system', message: 'Forcing the tracked server process to stop.' });
      this.terminateTrackedProcess(runtime.child, true);
    }, gracefulStopMs + FORCE_STOP_MS);
    hardTimer.unref();

    let stopTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runtime.closePromise,
        new Promise<void>((_resolve, reject) => {
          stopTimeout = setTimeout(() => reject(new AppError(503, 'server_stop_timeout', 'The server did not stop after the configured timeout.')), gracefulStopMs + FORCE_STOP_MS + 5_000);
          stopTimeout.unref();
        }),
      ]);
    } finally {
      if (stopTimeout) clearTimeout(stopTimeout);
    }
    clearTimeout(gracefulTimer);
    clearTimeout(hardTimer);
    return this.repository.find(server.id) ?? updated;
  }

  async restart(server: ServerRecord, javaPath?: string, warning?: string): Promise<ServerRecord> {
    if (this.processes.has(server.id)) await this.stop(server);
    const fresh = this.repository.find(server.id);
    if (!fresh) throw new AppError(404, 'server_not_found', 'The requested server no longer exists.');
    return this.start(fresh, javaPath, warning);
  }

  sendCommand(serverId: string, command: string): void {
    if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(command)) {
      throw new AppError(400, 'invalid_command', 'Commands must be one line and no longer than 500 characters.');
    }
    const runtime = this.processes.get(serverId);
    if (!runtime || runtime.stopping) throw new AppError(409, 'server_not_running', 'Start the server before sending a console command.');
    runtime.child.stdin.write(`${command}\n`);
    this.appendLog(serverId, { timestamp: new Date().toISOString(), stream: 'system', message: `> ${command}` });
  }

  async shutdown(): Promise<void> {
    const active = [...this.processes.keys()]
      .map((id) => this.repository.find(id))
      .filter((server): server is ServerRecord => Boolean(server));
    await Promise.all(active.map(async (server) => {
      try {
        await this.stop(server);
      } catch {
        // The process is already tracked and close handlers will update its persistent state.
      }
    }));
  }

  private pipeOutput(
    serverId: string,
    stream: NodeJS.ReadableStream,
    channel: 'stdout' | 'stderr',
    runtime: RuntimeProcess,
  ): void {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending, 'utf8') > MAX_PENDING_OUTPUT_BYTES) {
        const clipped = cleanLine(pending.slice(0, MAX_PENDING_OUTPUT_BYTES));
        if (clipped) this.appendLog(serverId, { timestamp: new Date().toISOString(), stream: channel, message: `${clipped} [output line truncated]` });
        pending = '';
      }
      const lines = pending.split(/\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const message = cleanLine(line);
        if (message) {
          this.observeFatalOutput(serverId, message, runtime);
          this.appendLog(serverId, { timestamp: new Date().toISOString(), stream: channel, message });
        }
      }
    });
    stream.once('end', () => {
      const message = cleanLine(pending);
      if (message) {
        this.observeFatalOutput(serverId, message, runtime);
        this.appendLog(serverId, { timestamp: new Date().toISOString(), stream: channel, message });
      }
    });
    stream.on('error', (error) => {
      this.appendLog(serverId, { timestamp: new Date().toISOString(), stream: 'system', message: `Console ${channel} stream closed: ${error.message}` });
    });
  }

  private observeFatalOutput(serverId: string, message: string, runtime: RuntimeProcess): void {
    if (runtime.stopping || runtime.fatalError) return;
    if (!/(failed to bind to port|address already in use|bindexception)/i.test(message)) return;
    runtime.fatalError = `The game server could not bind its configured port. ${message}`;
    const current = this.repository.find(serverId);
    if (current && ['starting', 'running'].includes(current.status)) {
      this.emitStatus(this.repository.setStatus(serverId, 'error', { lastError: runtime.fatalError }));
    }
  }

  private appendLog(serverId: string, line: ConsoleLine): void {
    const current = this.logs.get(serverId) ?? [];
    current.push(line);
    if (current.length > MAX_LOG_LINES) current.splice(0, current.length - MAX_LOG_LINES);
    this.logs.set(serverId, current);
    this.emit('event', { type: 'log', serverId, line } satisfies ServerEvent);
  }

  private emitStatus(server: ServerRecord): void {
    this.emit('event', {
      type: 'status',
      serverId: server.id,
      status: server.status,
      error: server.lastError,
    } satisfies ServerEvent);
  }

  private terminateTrackedProcess(child: ChildProcessWithoutNullStreams, force = false): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // taskkill receives a known tracked PID as an argument; it is never built through a shell.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
      killer.unref();
      return;
    }
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}
