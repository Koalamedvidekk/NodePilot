import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import path from 'node:path';

import { resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRecord, ServerStatus } from '../types.js';
import { ServerRuntime, type ManagedProcessInfo } from './server-runtime.js';

const HISTORY_LIMIT = 300; // 10 minutes at the two-second UI cadence.
const DIRECTORY_SCAN_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 45_000;
const CLEANUP_INTERVAL_MS = 15_000;
const MAX_DIRECTORY_ENTRIES = 250_000;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024 * 1024;
const JVM_QUERY_INTERVAL_MS = 4_000;
const JVM_QUERY_TIMEOUT_MS = 4_000;

export type MetricAvailability = { available: boolean; reason?: string };
export type ProcessHeapUsage = MetricAvailability & { usedBytes?: number; committedBytes?: number; maxBytes?: number };
export type ProcessDiskUsage = MetricAvailability & {
  directoryBytes?: number;
  readBytesPerSecond?: number;
  writeBytesPerSecond?: number;
};
export type ProcessNetworkUsage = MetricAvailability & { receivedBytesPerSecond?: number; sentBytesPerSecond?: number };

export type ProcessUsageSample = {
  timestamp: string;
  cpuPercent?: number;
  memoryBytes?: number;
  heap: ProcessHeapUsage;
  disk: ProcessDiskUsage;
  network: ProcessNetworkUsage;
  uptimeMs: number;
};

export type ServerUsage = {
  serverId: string;
  status: ServerStatus;
  current?: ProcessUsageSample;
  history: ProcessUsageSample[];
  capabilities: {
    cpu: MetricAvailability;
    memory: MetricAvailability;
    heap: MetricAvailability;
    disk: MetricAvailability;
    network: MetricAvailability;
  };
};

type RawProcessReading = {
  sampledAt: number;
  cpuTimeMs: number;
  memoryBytes: number;
  readBytes?: number;
  writeBytes?: number;
};

type WindowsCollector = {
  child: ChildProcess;
  pending: string;
  reading?: RawProcessReading;
};

type MetricState = {
  runtime: ManagedProcessInfo;
  history: ProcessUsageSample[];
  previous?: RawProcessReading;
  directoryBytes?: number;
  directoryFailure?: string;
  lastDirectoryScanAt?: number;
  lastRequestedAt: number;
  windows?: WindowsCollector;
  heap: ProcessHeapUsage;
  heapQueryAt?: number;
  heapQueryInFlight?: Promise<void>;
};

function isNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseDecimal(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function unavailable(reason: string): MetricAvailability {
  return { available: false, reason };
}

function byteUnit(value: number, unit: string): number | undefined {
  const multiplier = unit.toUpperCase() === 'K'
    ? 1024
    : unit.toUpperCase() === 'M'
      ? 1024 ** 2
      : unit.toUpperCase() === 'G'
        ? 1024 ** 3
        : undefined;
  return multiplier ? value * multiplier : undefined;
}

/**
 * Normalized against every logical CPU: (process CPU milliseconds / elapsed milliseconds /
 * logical CPU count) × 100. A process using all cores is therefore 100%, not N × 100%.
 */
export function calculateCpuPercent(
  previous: Pick<RawProcessReading, 'sampledAt' | 'cpuTimeMs'> | undefined,
  current: Pick<RawProcessReading, 'sampledAt' | 'cpuTimeMs'>,
  logicalCpuCount: number,
): number | undefined {
  if (!previous || logicalCpuCount < 1) return undefined;
  const elapsedMs = current.sampledAt - previous.sampledAt;
  const cpuMs = current.cpuTimeMs - previous.cpuTimeMs;
  if (elapsedMs <= 0 || cpuMs < 0) return undefined;
  return Math.max(0, Math.min(100, Number(((cpuMs / elapsedMs / logicalCpuCount) * 100).toFixed(2))));
}

/** Handles process names containing spaces or closing parentheses in /proc/<pid>/stat. */
export function parseLinuxProcStat(raw: string): { cpuTicks: number } | undefined {
  const close = raw.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  // Fields begin at stat field 3, so utime/stime (14/15) are indexes 11/12.
  const userTicks = parseDecimal(fields[11]);
  const systemTicks = parseDecimal(fields[12]);
  if (!isNonNegative(userTicks) || !isNonNegative(systemTicks)) return undefined;
  return { cpuTicks: userTicks + systemTicks };
}

export function parseLinuxStatusRss(raw: string): number | undefined {
  const kibibytes = parseDecimal(raw.match(/^VmRSS:\s*(\d+)\s*kB\s*$/mi)?.[1]);
  return isNonNegative(kibibytes) ? kibibytes * 1024 : undefined;
}

export function parseLinuxIo(raw: string): { readBytes?: number; writeBytes?: number } {
  return {
    readBytes: parseDecimal(raw.match(/^read_bytes:\s*(\d+)\s*$/mi)?.[1]),
    writeBytes: parseDecimal(raw.match(/^write_bytes:\s*(\d+)\s*$/mi)?.[1]),
  };
}

function counterRate(current: number | undefined, previous: number | undefined, elapsedMs: number): number | undefined {
  if (!isNonNegative(current) || !isNonNegative(previous) || elapsedMs <= 0 || current < previous) return undefined;
  return Math.max(0, Math.round(((current - previous) / elapsedMs) * 1_000));
}

function isSameRuntime(left: ManagedProcessInfo, right: ManagedProcessInfo): boolean {
  return left.runtimeId === right.runtimeId && left.pid === right.pid;
}

async function managedDirectorySize(root: string): Promise<number> {
  let total = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop() as string;
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) throw new Error('The directory has too many entries to measure safely.');
      const childPath = path.join(current, child.name);
      const details = await lstat(childPath);
      // Never follow links while calculating a managed directory's size.
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) pending.push(childPath);
      if (details.isFile()) {
        total += details.size;
        if (total > MAX_DIRECTORY_BYTES) throw new Error('The directory is larger than NodePilot’s safe accounting limit.');
      }
    }
  }
  return total;
}

async function executeLimited(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: null, output: '' });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (output.length < 64 * 1024) output += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: null, output: '' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export function parseJcmdHeap(output: string, configuredMaxBytes: number): ProcessHeapUsage {
  if (!output || typeof output !== 'string') {
    return unavailable('No output received from jcmd.');
  }

  // 1. Used memory (e.g. "used 661053K" or "used 256M")
  const usedMatch = output.match(/\bused\s+(\d+)\s*([KMG])/i);
  const used = usedMatch ? byteUnit(Number(usedMatch[1]), usedMatch[2]) : undefined;

  // 2. Committed memory:
  // - Modern G1GC (Java 21/25): "committed 1048576K"
  // - ZGC: "capacity 512M"
  // - Older G1GC / Parallel: "total 1048576K"
  let committed: number | undefined;
  const committedMatch = output.match(/\bcommitted\s+(\d+)\s*([KMG])/i);
  if (committedMatch) {
    committed = byteUnit(Number(committedMatch[1]), committedMatch[2]);
  } else {
    const totalMatch = output.match(/\btotal\s+(\d+)\s*([KMG])/i);
    if (totalMatch) {
      committed = byteUnit(Number(totalMatch[1]), totalMatch[2]);
    } else {
      const capMatch = output.match(/\bcapacity\s+(\d+)\s*([KMG])/i);
      if (capMatch) {
        committed = byteUnit(Number(capMatch[1]), capMatch[2]);
      }
    }
  }

  // 3. Max / reserved memory:
  // - Modern G1GC: "total reserved 4194304K" or "reserved 4194304K"
  // - ZGC: "max capacity 2048M"
  let max: number | undefined;
  const reservedMatch = output.match(/\b(?:total\s+)?reserved\s+(\d+)\s*([KMG])/i)
    ?? output.match(/\bmax\s+(?:capacity\s+)?(\d+)\s*([KMG])/i);
  if (reservedMatch) {
    max = byteUnit(Number(reservedMatch[1]), reservedMatch[2]);
  }

  // Fallback: older general match "heap ... total 123K, used 45K"
  if (!isNonNegative(used) || !isNonNegative(committed)) {
    const fallbackMatch = output.match(/heap[^\n]*?\btotal\s+(\d+)\s*([KMG]),\s*used\s+(\d+)\s*([KMG])/i);
    if (fallbackMatch) {
      const c = byteUnit(Number(fallbackMatch[1]), fallbackMatch[2]);
      const u = byteUnit(Number(fallbackMatch[3]), fallbackMatch[4]);
      if (isNonNegative(c) && isNonNegative(u)) {
        return { available: true, usedBytes: u, committedBytes: c, maxBytes: configuredMaxBytes };
      }
    }
    return unavailable('The selected Java runtime did not return parsable heap statistics through jcmd.');
  }

  return {
    available: true,
    usedBytes: used,
    committedBytes: committed,
    maxBytes: max && max >= committed ? max : configuredMaxBytes,
  };
}

function noManagedProcess(server: ServerRecord): ServerUsage {
  const reason = ['offline', 'error'].includes(server.status)
    ? 'No server process is currently managed by this NodePilot session.'
    : 'Waiting for the managed server process to start.';
  return {
    serverId: server.id,
    status: server.status,
    history: [],
    capabilities: {
      cpu: unavailable(reason),
      memory: unavailable(reason),
      heap: unavailable(reason),
      disk: unavailable('Directory size is measured only while NodePilot manages a running server process.'),
      network: unavailable('Reliable per-process network byte accounting is not available on this host without a privileged collector.'),
    },
  };
}

/**
 * Samples only a child held by ServerRuntime's in-memory process map. No persisted PID is ever
 * reattached after NodePilot restarts, which prevents PID-reuse mistakes.
 */
export class ProcessMetricsService {
  private readonly states = new Map<string, MetricState>();
  private readonly logicalCpuCount = Math.max(1, cpus().length);
  private readonly cleanupTimer: NodeJS.Timeout;
  private linuxClockTicks?: Promise<number>;

  constructor(
    private readonly runtime: ServerRuntime,
    private readonly serversDirectory: string,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    this.runtime.on('event', (event: { type?: string; serverId?: string; status?: ServerStatus }) => {
      if (event.type === 'status' && event.serverId && ['offline', 'error'].includes(event.status ?? 'offline')) {
        this.stop(event.serverId);
      }
    });
  }

  async usage(server: ServerRecord): Promise<ServerUsage> {
    const process = this.runtime.getProcessInfo(server.id);
    if (!process) {
      this.stop(server.id);
      return noManagedProcess(server);
    }

    let state = this.states.get(server.id);
    if (!state || !isSameRuntime(state.runtime, process)) {
      if (state) this.dispose(state);
      state = {
        runtime: process,
        history: [],
        heap: unavailable('Java heap statistics have not been queried yet.'),
        lastRequestedAt: Date.now(),
      };
      this.states.set(server.id, state);
    }
    state.lastRequestedAt = Date.now();

    const reading = await this.readProcess(process, state);
    if (!reading) {
      return {
        serverId: server.id,
        status: server.status,
        history: state.history,
        capabilities: {
          cpu: unavailable('The managed process exited before a metric sample could be read.'),
          memory: unavailable('The managed process exited before a metric sample could be read.'),
          heap: state.heap,
          disk: state.directoryBytes === undefined
            ? unavailable(state.directoryFailure ?? 'Directory size has not been measured yet.')
            : { available: true },
          network: unavailable('Reliable per-process network byte accounting is not available on this host without a privileged collector.'),
        },
      };
    }

    this.scheduleDirectorySize(server, state);
    this.scheduleHeapQuery(server, process, state);
    const elapsedMs = state.previous ? reading.sampledAt - state.previous.sampledAt : 0;
    const sample: ProcessUsageSample = {
      timestamp: new Date(reading.sampledAt).toISOString(),
      cpuPercent: calculateCpuPercent(state.previous, reading, this.logicalCpuCount),
      memoryBytes: reading.memoryBytes,
      heap: state.heap,
      disk: {
        available: state.directoryBytes !== undefined,
        ...(state.directoryBytes === undefined
          ? { reason: state.directoryFailure ?? 'Directory size is being measured.' }
          : { directoryBytes: state.directoryBytes }),
        readBytesPerSecond: counterRate(reading.readBytes, state.previous?.readBytes, elapsedMs),
        writeBytesPerSecond: counterRate(reading.writeBytes, state.previous?.writeBytes, elapsedMs),
      },
      network: unavailable('Reliable per-process network byte accounting is not available on this host without a privileged collector.'),
      uptimeMs: Math.max(0, reading.sampledAt - Date.parse(process.startedAt)),
    };
    state.previous = reading;
    state.history.push(sample);
    if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
    return {
      serverId: server.id,
      status: server.status,
      current: sample,
      history: state.history,
      capabilities: {
        cpu: { available: true },
        memory: { available: true },
        heap: sample.heap,
        disk: sample.disk,
        network: sample.network,
      },
    };
  }

  stop(serverId: string): void {
    const state = this.states.get(serverId);
    if (!state) return;
    this.dispose(state);
    this.states.delete(serverId);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const state of this.states.values()) this.dispose(state);
    this.states.clear();
  }

  private async readProcess(process: ManagedProcessInfo, state: MetricState): Promise<RawProcessReading | undefined> {
    return platform() === 'win32'
      ? this.readWindows(process, state)
      : this.readLinux(process);
  }

  private async readLinux(process: ManagedProcessInfo): Promise<RawProcessReading | undefined> {
    const procRoot = '/proc/' + process.pid;
    const [statText, statusText, ioText, clockTicks] = await Promise.all([
      readFile(path.join(procRoot, 'stat'), 'utf8').catch(() => undefined),
      readFile(path.join(procRoot, 'status'), 'utf8').catch(() => undefined),
      readFile(path.join(procRoot, 'io'), 'utf8').catch(() => undefined),
      this.getLinuxClockTicks(),
    ]);
    const stat = statText ? parseLinuxProcStat(statText) : undefined;
    const memoryBytes = statusText ? parseLinuxStatusRss(statusText) : undefined;
    if (!stat || !isNonNegative(memoryBytes)) return undefined;
    return {
      sampledAt: Date.now(),
      cpuTimeMs: (stat.cpuTicks / clockTicks) * 1_000,
      memoryBytes,
      ...(ioText ? parseLinuxIo(ioText) : {}),
    };
  }

  private readWindows(process: ManagedProcessInfo, state: MetricState): RawProcessReading | undefined {
    if (!state.windows) state.windows = this.startWindowsCollector(process.pid);
    return state.windows.reading;
  }

  private startWindowsCollector(pid: number): WindowsCollector {
    // The PID originates only from ServerRuntime and is emitted as a base-10 integer. The
    // long-lived helper filters a single PID instead of enumerating host processes every poll.
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '$nodePilotPid = ' + pid,
      'while ($true) {',
      '  $nodePilotProcess = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $nodePilotPid)',
      '  if ($null -eq $nodePilotProcess) { break }',
      '  [pscustomobject]@{',
      '    pid = [int]$nodePilotProcess.ProcessId',
      '    user100ns = [string]$nodePilotProcess.UserModeTime',
      '    kernel100ns = [string]$nodePilotProcess.KernelModeTime',
      '    workingSet = [string]$nodePilotProcess.WorkingSetSize',
      '    readBytes = [string]$nodePilotProcess.ReadTransferCount',
      '    writeBytes = [string]$nodePilotProcess.WriteTransferCount',
      '  } | ConvertTo-Json -Compress',
      '  Start-Sleep -Milliseconds 2000',
      '}',
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collector: WindowsCollector = { child, pending: '' };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      collector.pending += chunk;
      const lines = collector.pending.split(/\r?\n/);
      collector.pending = lines.pop() ?? '';
      for (const line of lines) this.acceptWindowsReading(collector, line);
    });
    child.once('close', () => { collector.pending = ''; });
    child.once('error', () => { collector.pending = ''; });
    return collector;
  }

  private acceptWindowsReading(collector: WindowsCollector, line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const user = typeof parsed.user100ns === 'string' && /^\d+$/.test(parsed.user100ns) ? BigInt(parsed.user100ns) : undefined;
      const kernel = typeof parsed.kernel100ns === 'string' && /^\d+$/.test(parsed.kernel100ns) ? BigInt(parsed.kernel100ns) : undefined;
      const memoryBytes = typeof parsed.workingSet === 'string' ? parseDecimal(parsed.workingSet) : undefined;
      if (user === undefined || kernel === undefined || !isNonNegative(memoryBytes)) return;
      collector.reading = {
        sampledAt: Date.now(),
        cpuTimeMs: Number((user + kernel) / 10_000n),
        memoryBytes,
        readBytes: typeof parsed.readBytes === 'string' ? parseDecimal(parsed.readBytes) : undefined,
        writeBytes: typeof parsed.writeBytes === 'string' ? parseDecimal(parsed.writeBytes) : undefined,
      };
    } catch {
      // A malformed or localized helper line does not poison later samples.
    }
  }

  private scheduleDirectorySize(server: ServerRecord, state: MetricState): void {
    const now = Date.now();
    if (state.lastDirectoryScanAt && now - state.lastDirectoryScanAt < DIRECTORY_SCAN_INTERVAL_MS) return;
    state.lastDirectoryScanAt = now;
    void (async () => {
      try {
        const root = await resolveManagedServerRoot(this.serversDirectory, server.directory);
        const bytes = await managedDirectorySize(root);
        if (this.states.get(server.id) === state) {
          state.directoryBytes = bytes;
          state.directoryFailure = undefined;
        }
      } catch (error) {
        if (this.states.get(server.id) === state) {
          state.directoryFailure = error instanceof Error ? error.message : 'Directory accounting failed.';
        }
      }
    })();
  }

  private scheduleHeapQuery(server: ServerRecord, process: ManagedProcessInfo, state: MetricState): void {
    const now = Date.now();
    if (state.heapQueryInFlight || (state.heapQueryAt && now - state.heapQueryAt < JVM_QUERY_INTERVAL_MS)) return;
    state.heapQueryAt = now;
    state.heapQueryInFlight = (async () => {
      const jcmd = this.jcmdPath(server.javaPath);
      if (!jcmd) {
        state.heap = unavailable('jcmd is not available beside the selected Java runtime.');
        return;
      }
      const result = await executeLimited(jcmd, [String(process.pid), 'GC.heap_info'], JVM_QUERY_TIMEOUT_MS);
      if (this.states.get(server.id) !== state || !isSameRuntime(state.runtime, process)) return;
      state.heap = result.code === 0
        ? parseJcmdHeap(result.output, server.memoryMb * 1024 * 1024)
        : unavailable('jcmd could not query this Java process.');
    })().finally(() => {
      if (this.states.get(server.id) === state) state.heapQueryInFlight = undefined;
    });
  }

  private jcmdPath(javaPath: string | null): string | undefined {
    if (javaPath) {
      const adjacent = path.join(path.dirname(javaPath), platform() === 'win32' ? 'jcmd.exe' : 'jcmd');
      if (existsSync(adjacent)) return adjacent;
    }
    return platform() === 'win32' ? 'jcmd.exe' : 'jcmd';
  }

  private getLinuxClockTicks(): Promise<number> {
    if (!this.linuxClockTicks) {
      this.linuxClockTicks = executeLimited('getconf', ['CLK_TCK'], 1_000)
        .then((result) => {
          const ticks = Number.parseInt(result.output.trim(), 10);
          return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : 100;
        })
        .catch(() => 100);
    }
    return this.linuxClockTicks;
  }

  private cleanupIdle(): void {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [serverId, state] of this.states) {
      if (state.lastRequestedAt < cutoff) this.stop(serverId);
    }
  }

  private dispose(state: MetricState): void {
    if (state.windows && !state.windows.child.killed) state.windows.child.kill();
  }
}
