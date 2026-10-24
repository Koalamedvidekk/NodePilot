import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../lib/errors.js';
import type { TorStatus } from '../types.js';

const ONION_ADDRESS_PATTERN = /^[a-z2-7]{56}\.onion$/;

export function isTorOnionAddress(value: string): boolean {
  return ONION_ADDRESS_PATTERN.test(value.trim().toLowerCase());
}

function torPath(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/.test(value)) {
    throw new Error('Tor runtime paths must be absolute paths without control characters.');
  }
  return value.replace(/\\/g, '/');
}

/** Build the narrowly scoped Tor configuration used by NodePilot's Onion service. */
export function createTorConfiguration(
  dataDirectory: string,
  hiddenServiceDirectory: string,
  panelPort: number,
): string {
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65_535) {
    throw new Error('NodePilot panel port must be a valid TCP port.');
  }

  return [
    `DataDirectory "${torPath(dataDirectory)}"`,
    // NodePilot does not expose Tor's SOCKS proxy. This process exists only for the
    // private Onion service below.
    'SocksPort 0',
    // Explicitly keep this process client-only; NodePilot never turns the host into
    // a Tor relay.
    'ClientOnly 1',
    `HiddenServiceDir "${torPath(hiddenServiceDirectory)}"`,
    `HiddenServicePort 80 127.0.0.1:${panelPort}`,
    'Log notice stdout',
    '',
  ].join('\n');
}

interface TorBinary {
  path: string;
  version: string | null;
}

export class TorService {
  private childProcess: ChildProcess | null = null;
  private cachedBinaryPath: string | null = null;
  private lastError: string | null = null;
  private bootstrapped = false;
  private stopping = false;
  private onionAddress: string | null = null;
  private outputTail = '';

  private readonly rootDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly hiddenServiceDirectory: string;
  private readonly configurationPath: string;

  constructor(private readonly nodePilotDataDirectory: string) {
    this.rootDirectory = path.join(nodePilotDataDirectory, 'tor');
    this.runtimeDirectory = path.join(this.rootDirectory, 'runtime');
    this.hiddenServiceDirectory = path.join(this.rootDirectory, 'onion-service');
    this.configurationPath = path.join(this.rootDirectory, 'torrc');
    this.onionAddress = this.readOnionAddressSync();
  }

  private isSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'linux';
  }

  private isRunning(): boolean {
    return Boolean(this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed);
  }

  private async readOnionAddress(): Promise<string | null> {
    try {
      const hostname = (await readFile(path.join(this.hiddenServiceDirectory, 'hostname'), 'utf8')).trim().toLowerCase();
      this.onionAddress = isTorOnionAddress(hostname) ? hostname : null;
      return this.onionAddress;
    } catch {
      this.onionAddress = null;
      return null;
    }
  }

  private readOnionAddressSync(): string | null {
    try {
      const hostname = readFileSync(path.join(this.hiddenServiceDirectory, 'hostname'), 'utf8').trim().toLowerCase();
      return isTorOnionAddress(hostname) ? hostname : null;
    } catch {
      return null;
    }
  }

  /** Returns the current persistent Onion hostname, if Tor has generated one. */
  async getOnionAddress(): Promise<string | null> {
    return this.readOnionAddress();
  }

  /** Used synchronously by Fastify's CORS/WebSocket origin checks. */
  getAllowedOriginHostname(): string | null {
    if (!this.isRunning()) return null;
    if (!this.onionAddress) this.onionAddress = this.readOnionAddressSync();
    return this.onionAddress;
  }

  private async probeBinary(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let child: ChildProcess;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      try {
        child = spawn(command, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }

      const append = (chunk: Buffer) => {
        if (output.length < 4_096) output += chunk.toString('utf8').slice(0, 4_096 - output.length);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* process already exited */ }
        finish(null);
      }, 5_000);
      timeout.unref();
      child.once('error', () => finish(null));
      child.once('close', (code) => {
        if (code !== 0) return finish(null);
        const match = output.match(/Tor version\s+([^\s]+)/i);
        finish(match?.[1] ?? 'installed');
      });
    });
  }

  private candidatePaths(): string[] {
    const configured = process.env.NODEPILOT_TOR_PATH?.trim();
    const candidates = configured && path.isAbsolute(configured) ? [configured] : [];

    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Tor\\tor.exe',
        'C:\\Program Files (x86)\\Tor\\tor.exe',
        path.join(os.homedir(), 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
      );
    } else if (process.platform === 'linux') {
      candidates.push(
        '/usr/bin/tor',
        '/usr/local/bin/tor',
        path.join(os.homedir(), '.local', 'bin', 'tor'),
        path.join(os.homedir(), 'tor-browser', 'Browser', 'TorBrowser', 'Tor', 'tor'),
        path.join(os.homedir(), 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor'),
      );
    }
    return candidates;
  }

  private async findBinary(): Promise<TorBinary | null> {
    if (!this.isSupported()) return null;

    if (this.cachedBinaryPath && existsSync(this.cachedBinaryPath)) {
      const version = await this.probeBinary(this.cachedBinaryPath);
      if (version) return { path: this.cachedBinaryPath, version };
    }

    for (const candidate of this.candidatePaths()) {
      if (!existsSync(candidate)) continue;
      const version = await this.probeBinary(candidate);
      if (version) {
        this.cachedBinaryPath = candidate;
        return { path: candidate, version };
      }
    }

    // `spawn` resolves PATH itself, avoiding a shell invocation of `where` / `which`.
    const pathCommand = process.platform === 'win32' ? 'tor.exe' : 'tor';
    const version = await this.probeBinary(pathCommand);
    if (version) {
      this.cachedBinaryPath = pathCommand;
      return { path: pathCommand, version };
    }
    return null;
  }

  async getStatus(): Promise<TorStatus> {
    const binary = await this.findBinary();
    const onionAddress = await this.readOnionAddress();
    const isRunning = this.isRunning();
    return {
      supported: this.isSupported(),
      installed: Boolean(binary),
      binaryPath: binary?.path ?? null,
      version: binary?.version ?? null,
      isRunning,
      isReady: isRunning && this.bootstrapped && Boolean(onionAddress),
      onionAddress,
      error: this.lastError,
    };
  }

  async start(panelPort: number): Promise<TorStatus> {
    if (!this.isSupported()) {
      throw new AppError(422, 'tor_unsupported', 'Private remote access is currently supported on Windows and Linux only.');
    }
    if (this.isRunning()) return this.getStatus();

    const binary = await this.findBinary();
    if (!binary) {
      throw new AppError(
        422,
        'tor_not_installed',
        'Tor is not installed. Install Tor Browser or the Tor Expert Bundle, then return here and enable private remote access.',
      );
    }

    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.hiddenServiceDirectory, { recursive: true, mode: 0o700 });
    // Tor stores the Onion private key here. On Unix, correct pre-existing
    // directory permissions as well as newly created ones so Tor does not
    // reject the service directory or expose key material to other users.
    if (process.platform !== 'win32') {
      await chmod(this.runtimeDirectory, 0o700);
      await chmod(this.hiddenServiceDirectory, 0o700);
    }
    await writeFile(
      this.configurationPath,
      createTorConfiguration(this.runtimeDirectory, this.hiddenServiceDirectory, panelPort),
      { encoding: 'utf8', mode: 0o600 },
    );
    if (process.platform !== 'win32') await chmod(this.configurationPath, 0o600);

    this.lastError = null;
    this.bootstrapped = false;
    this.stopping = false;
    this.outputTail = '';
    // Tor Browser's bundled binary can rely on files next to the executable
    // (notably its GeoIP data), so preserve that working directory when an
    // absolute binary path was discovered. The NodePilot config itself remains
    // absolute and continues to keep all state in the data directory.
    const workingDirectory = path.isAbsolute(binary.path) ? path.dirname(binary.path) : this.rootDirectory;
    const child = spawn(binary.path, ['-f', this.configurationPath], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.childProcess = child;

    const observeOutput = (chunk: Buffer) => {
      // A log line can be split across stream chunks, so retain a bounded tail
      // before looking for Tor's bootstrap completion message.
      const message = `${this.outputTail}${chunk.toString('utf8')}`;
      this.outputTail = message.slice(-1_024);
      if (/Bootstrapped 100%/i.test(message)) this.bootstrapped = true;
      const fatal = message.match(/\[(?:err|warn)\].*(?:fatal|failed|error)/i);
      if (fatal && !this.stopping) this.lastError = message.trim().slice(-500);
    };
    child.stdout?.on('data', observeOutput);
    child.stderr?.on('data', observeOutput);
    child.once('error', (error) => {
      if (this.childProcess === child) {
        this.childProcess = null;
        this.lastError = `Tor could not start: ${error.message}`;
      }
    });
    child.once('exit', (code, signal) => {
      if (this.childProcess === child) {
        this.childProcess = null;
        this.bootstrapped = false;
        if (!this.stopping && code !== 0) {
          this.lastError = `Tor exited unexpectedly${code === null ? '' : ` (code ${code})`}${signal ? ` (${signal})` : ''}.`;
        }
      }
    });

    // Allow Tor a moment to create its persistent key material and hostname, without
    // holding an HTTP request open for a potentially slow network bootstrap.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const status = await this.getStatus();
    if (!status.isRunning) {
      throw new AppError(502, 'tor_start_failed', status.error ?? 'Tor exited before private remote access could start.');
    }
    return status;
  }

  async stop(): Promise<TorStatus> {
    const child = this.childProcess;
    if (!child) return this.getStatus();
    if (child.exitCode !== null || child.killed) {
      this.childProcess = null;
      this.bootstrapped = false;
      return this.getStatus();
    }

    this.stopping = true;
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* process already exited */ }
        finish();
      }, 8_000);
      timeout.unref();
      child.once('exit', () => {
        clearTimeout(timeout);
        finish();
      });
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
    if (this.childProcess === child) this.childProcess = null;
    this.bootstrapped = false;
    this.stopping = false;
    return this.getStatus();
  }

  async resetAddress(panelPort: number): Promise<TorStatus> {
    const wasRunning = this.isRunning();
    await this.stop();
    await rm(this.hiddenServiceDirectory, { recursive: true, force: true });
    this.lastError = null;
    if (wasRunning) return this.start(panelPort);
    return this.getStatus();
  }
}
