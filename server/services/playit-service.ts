import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, unlink } from 'node:fs/promises';
import { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { PlayitStatus } from '../types.js';

const execFileAsync = promisify(execFile);
const probeOptions = { timeout: 4_000, maxBuffer: 8_192, windowsHide: true } as const;
const managedVersion = '0.17.1';
const maxDownloadBytes = 40 * 1024 * 1024;
const claimUrlPattern = /https:\/\/playit\.gg\/claim\/([0-9a-f]{10})(?![a-z0-9])/i;
const assetDigests: Readonly<Record<string, string>> = {
  'playit-windows-x86_64-signed.exe': '9b00d6ff7d37d1052e5ae097e1348e11deae8617cd7a8ba39d1777f2006316a3',
  'playit-windows-x86-signed.exe': '5302a28438f4612d1fd26148420a60cf9235ce4271d5d6549bec474b709cfa88',
  'playit-linux-amd64': 'e78d463d93aa1e3ec36a06ded5a1f4fe879905fdceb865df8f4cef6124f8a555',
  'playit-linux-aarch64': 'cd3fa1cedac40a71d80a120e6353e08836308840340b58e659e8f25d00601f66',
  'playit-linux-armv7': '91b4afd035e05deda2a8bf2d648c53ba9a67465c4bcce459f573d5f61867d00a',
  'playit-linux-i686': 'c2847be0ec3ef038697f28b8196c0b1a9dff71e8392657eda767afec63d98fd5',
};

interface BinaryInfo {
  version: string | null;
  legacy: boolean;
}

interface ClaimResult {
  claimUrl: string;
  claimCode: string;
}

interface PendingClaim {
  child: ChildProcess;
  stagePath: string;
  secretPath: string;
  result: ClaimResult | null;
  timeout: ReturnType<typeof setTimeout>;
  reject: (error: Error) => void;
}

function validSecretKey(value: string): boolean {
  return /^(?:[a-f0-9]{2}){1,128}$/i.test(value);
}

function readSecretFile(secretPath: string): string | null {
  try {
    const content = readFileSync(secretPath, 'utf8');
    const match = content.match(/^[\t ]*secret_key[\t ]*=[\t ]*(['"])([a-f0-9]+)\1[\t ]*(?:#.*)?\r?$/im);
    return match && validSecretKey(match[2]) ? match[2] : null;
  } catch {
    return null;
  }
}

function writeSecretFile(secretPath: string, key: string): void {
  mkdirSync(path.dirname(secretPath), { recursive: true });
  const temporaryPath = `${secretPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `secret_key = "${key}"\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, secretPath);
  } finally {
    try { unlinkSync(temporaryPath); } catch {}
  }
}

function isLiveChild(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

function killChild(child: ChildProcess): void {
  if (isLiveChild(child)) {
    try { child.kill(); } catch {}
  }
}

function cleanClaimStage(stagePath: string): void {
  try { unlinkSync(stagePath); } catch {}
  try { rmdirSync(path.dirname(stagePath)); } catch {}
}

function claimExitMessage(output: string, code: number | null, hasUrl: boolean): string {
  if (/AgentClaimRejected|program rejected/i.test(output)) {
    return 'The Playit claim was declined. Choose Link Account to try again.';
  }
  if (/agent limit|too many agents|maximum number of agents/i.test(output)) {
    return 'The Playit account reached its agent limit. Remove an unused agent or enter an existing agent secret key.';
  }
  if (/error: unexpected argument|unrecognized (option|argument)/i.test(output)) {
    return 'Playit rejected the linking command. Install the NodePilot-managed Playit agent and try again.';
  }

  const phase = hasUrl ? 'before linking was complete' : 'before providing a claim URL';
  const status = code === null ? '' : ` (exit code ${code})`;
  return `The Playit agent exited ${phase}${status}. Check that this computer can reach playit.gg and try again.`;
}

export interface ParsedPlayitTunnel {
  id: string;
  name: string | null;
  tunnelType: string;
  localPort: number | null;
  publicAddress: string | null;
  publicPort: number | null;
  connectionAddress: string | null;
}

export class PlayitService {
  private childProcess: ChildProcess | null = null;
  private cachedBinaryPath: string | null = null;
  private readonly managedBinaryPath: string;
  private readonly previousManagedBinaryPath: string;
  private installRequest: Promise<void> | null = null;
  private binaryProbe: { key: string; result: Promise<BinaryInfo> } | null = null;
  private pendingClaim: PendingClaim | null = null;
  private claimRequest: Promise<ClaimResult> | null = null;
  private claimGeneration = 0;
  private claimError: string | undefined;

  constructor(private readonly dataDirectory?: string) {
    const baseDir = this.dataDirectory || path.resolve('.nodepilot');
    const fileName = os.platform() === 'win32' ? 'playit.exe' : 'playit';
    this.previousManagedBinaryPath = path.join(baseDir, 'bin', fileName);
    this.managedBinaryPath = path.join(baseDir, 'bin', `playit-v${managedVersion}`, fileName);
  }

  /**
   * NodePilot uses the portable CLI protocol from Playit 0.x.
   * The current Playit 2.x release uses a separate CLI and daemon.
   */
  getDownloadUrl(): { url: string; fileName: string; sha256: string } | null {
    const platform = os.platform();
    const arch = os.arch();
    let asset: string | undefined;

    if (platform === 'win32') {
      if (arch === 'x64' || arch === 'arm64') asset = 'playit-windows-x86_64-signed.exe';
      if (arch === 'ia32') asset = 'playit-windows-x86-signed.exe';
    } else if (platform === 'linux') {
      const architecture = { x64: 'amd64', arm64: 'aarch64', arm: 'armv7', ia32: 'i686' };
      if (Object.hasOwn(architecture, arch)) {
        asset = `playit-linux-${architecture[arch as keyof typeof architecture]}`;
      }
    }

    if (!asset) return null;
    return {
      url: `https://github.com/playit-cloud/playit-agent/releases/download/v${managedVersion}/${asset}`,
      fileName: path.basename(this.managedBinaryPath),
      sha256: assetDigests[asset],
    };
  }

  async installManagedBinary(): Promise<PlayitStatus> {
    await this.ensureManagedBinary();
    return this.getStatus();
  }

  private async ensureManagedBinary(): Promise<void> {
    if (!this.installRequest) {
      this.installRequest = this.downloadManagedBinary().finally(() => { this.installRequest = null; });
    }
    await this.installRequest;
  }

  private async downloadManagedBinary(): Promise<void> {
    const download = this.getDownloadUrl();
    if (!download) {
      throw new Error(`Automatic Playit installation is not supported for ${os.platform()} (${os.arch()}).`);
    }
    if ((await this.getBinaryInfo(this.managedBinaryPath)).version === managedVersion) return;

    await mkdir(path.dirname(this.managedBinaryPath), { recursive: true });
    const tempFile = `${this.managedBinaryPath}.tmp-${randomUUID()}`;
    const signal = AbortSignal.timeout(90_000);

    try {
      const response = await fetch(download.url, { redirect: 'follow', signal });
      if (!response.ok || !response.body) {
        throw new Error(`GitHub returned HTTP ${response.status}.`);
      }

      const hash = createHash('sha256');
      let receivedBytes = 0;
      const verifySize = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > maxDownloadBytes) {
            callback(new Error('The download exceeded the allowed size.'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeStream, verifySize, createWriteStream(tempFile, { flags: 'wx', mode: 0o700 }), { signal });

      if (hash.digest('hex') !== download.sha256) {
        throw new Error('The download did not match the official Playit SHA-256 checksum.');
      }
      if (os.platform() !== 'win32') await chmod(tempFile, 0o755);
      await rename(tempFile, this.managedBinaryPath);
      this.binaryProbe = null;
    } catch (error) {
      await unlink(tempFile).catch(() => undefined);
      const detail = signal.aborted ? 'Download timed out.' : error instanceof Error ? error.message : String(error);
      throw new Error(`Playit installation failed: ${detail}`);
    }
  }

  /**
   * Locate the playit executable on the system.
   * NodePilot's managed binary in .nodepilot/bin takes precedence.
   */
  async findBinaryPath(): Promise<{ path: string; isManaged: boolean } | null> {
    for (const candidate of [this.managedBinaryPath, this.previousManagedBinaryPath]) {
      if (existsSync(candidate)) {
        return { path: candidate, isManaged: true };
      }
    }

    if (this.cachedBinaryPath && existsSync(this.cachedBinaryPath)) {
      return {
        path: this.cachedBinaryPath,
        isManaged: this.cachedBinaryPath === this.managedBinaryPath,
      };
    }

    const platform = os.platform();
    const candidatePaths: string[] = [];

    if (platform === 'win32') {
      candidatePaths.push(
        'C:\\Program Files\\playit_gg\\bin\\playit.exe',
        'C:\\Program Files (x86)\\playit_gg\\bin\\playit.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'playit_gg', 'bin', 'playit.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'playit', 'playit.exe'),
      );
    } else {
      candidatePaths.push(
        '/usr/local/bin/playit',
        '/usr/bin/playit',
        path.join(os.homedir(), '.local', 'bin', 'playit'),
        path.join(os.homedir(), 'bin', 'playit'),
      );
    }

    for (const candidate of candidatePaths) {
      if (existsSync(candidate)) {
        this.cachedBinaryPath = candidate;
        return { path: candidate, isManaged: false };
      }
    }

    // Try finding via `where` (win32) or `which` (unix)
    try {
      const { stdout } = platform === 'win32'
        ? await execFileAsync('where.exe', ['playit.exe'], probeOptions)
        : await execFileAsync('which', ['playit'], probeOptions);
      const found = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (found && existsSync(found)) {
        this.cachedBinaryPath = found;
        return { path: found, isManaged: false };
      }
    } catch {
      // not in PATH
    }

    return null;
  }

  /**
   * Resolve secret path for Playit configuration.
   */
  getSecretPath(): string | null {
    const platform = os.platform();
    if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'playit_gg', 'playit.toml');
    }
    return path.join(os.homedir(), '.config', 'playit_gg', 'playit.toml');
  }

  /**
   * Read raw secret key string from playit.toml if present.
   */
  readSecretKey(): string | null {
    const secretPath = this.getSecretPath();
    return secretPath ? readSecretFile(secretPath) : null;
  }

  private async getBinaryInfo(binaryPath: string): Promise<BinaryInfo> {
    let key: string;
    try {
      const stat = statSync(binaryPath);
      if (!stat.isFile()) return { version: null, legacy: false };
      key = `${binaryPath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return { version: null, legacy: false };
    }

    if (this.binaryProbe?.key === key) return this.binaryProbe.result;
    const result = this.probeVersion(binaryPath);
    this.binaryProbe = { key, result };
    return result;
  }

  private async probeVersion(binaryPath: string): Promise<BinaryInfo> {
    for (const flag of ['version', '--version']) {
      try {
        const { stdout } = await execFileAsync(binaryPath, [flag], probeOptions);
        const match = stdout.match(/^(?:playit(?:-cli)?(?: version)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/im);
        if (match) return { version: match[1], legacy: match[1].startsWith('0.') };
      } catch {
        // The Playit 2.x daemon does not expose a version command.
      }
    }
    return { version: null, legacy: false };
  }

  private async requireCompatibleBinary(): Promise<string> {
    const binary = await this.findBinaryPath();
    if (binary && (await this.getBinaryInfo(binary.path)).legacy) return binary.path;

    await this.ensureManagedBinary();
    if (!(await this.getBinaryInfo(this.managedBinaryPath)).legacy) {
      throw new Error('The NodePilot-managed Playit agent could not run on this computer.');
    }
    return this.managedBinaryPath;
  }

  /**
   * Query tunnels list from api.playit.gg using the agent's secret key.
   */
  async fetchAccountTunnels(): Promise<ParsedPlayitTunnel[]> {
    const secretKey = this.readSecretKey();
    if (!secretKey) {
      return [];
    }

    try {
      const response = await fetch('https://api.playit.gg/v1/tunnels/list', {
        method: 'POST',
        headers: {
          'Authorization': `Agent-Key ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        return [];
      }

      const json = await response.json() as {
        status: string;
        data?: {
          tunnels?: Array<{
            id: string;
            name?: string | null;
            tunnel_type?: string;
            origin?: {
              details?: {
                config_data?: {
                  fields?: Array<{ name: string; value: string }>;
                };
              };
            };
            public_allocations?: Array<{
              type: string;
              details?: {
                ip_hostname?: string;
                auto_domain?: string;
                port?: number;
              };
            }>;
            connect_addresses?: Array<{
              type: string;
              value?: { address?: string };
            }>;
          }>;
        };
      };

      if (json.status !== 'success' || !json.data?.tunnels) {
        return [];
      }

      return json.data.tunnels.map((tunnel): ParsedPlayitTunnel => {
        let localPort: number | null = null;
        const fields = tunnel.origin?.details?.config_data?.fields;
        if (Array.isArray(fields)) {
          const portField = fields.find((f) => f.name === 'local_port');
          if (portField && portField.value) {
            const parsed = parseInt(portField.value, 10);
            if (!isNaN(parsed)) localPort = parsed;
          }
        }

        const portAlloc = tunnel.public_allocations?.find((a) => a.type === 'PortAllocation')?.details;
        const publicAddress = portAlloc?.auto_domain || portAlloc?.ip_hostname || null;
        const publicPort = typeof portAlloc?.port === 'number' ? portAlloc.port : null;

        let connectionAddress: string | null = null;
        const firstAuto = tunnel.connect_addresses?.find((c) => c.type === 'auto')?.value?.address;
        const host = firstAuto || publicAddress;
        if (host && publicPort && publicPort !== 25565) {
          connectionAddress = host.includes(':') ? host : `${host}:${publicPort}`;
        } else if (host) {
          connectionAddress = host;
        } else if (publicAddress && publicPort) {
          connectionAddress = `${publicAddress}:${publicPort}`;
        }

        return {
          id: tunnel.id,
          name: tunnel.name ?? null,
          tunnelType: tunnel.tunnel_type ?? 'unknown',
          localPort,
          publicAddress,
          publicPort,
          connectionAddress,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Find an existing tunnel that points to a specific local port.
   */
  async findTunnelForPort(localPort: number): Promise<ParsedPlayitTunnel | null> {
    const tunnels = await this.fetchAccountTunnels();
    return tunnels.find((t) => t.localPort === localPort) ?? null;
  }

  /**
   * Check for NodePilot's agent or an existing Playit process, excluding a pending claim.
   */
  async isProcessRunning(): Promise<boolean> {
    if (this.childProcess && isLiveChild(this.childProcess)) return true;
    this.childProcess = null;

    try {
      const windows = os.platform() === 'win32';
      const { stdout } = windows
        ? await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq playit.exe', '/FO', 'CSV', '/NH'], probeOptions)
        : await execFileAsync('pgrep', ['-x', 'playit'], probeOptions);
      const claimPid = this.pendingClaim?.child.pid;
      return stdout.split(/\r?\n/).some((line) => {
        const pid = windows ? line.match(/^"playit\.exe","(\d+)"/i)?.[1] : line.trim();
        return /^\d+$/.test(pid ?? '') && Number(pid) !== claimPid;
      });
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<PlayitStatus> {
    if (this.pendingClaim) this.promoteClaim(this.pendingClaim);

    const binary = await this.findBinaryPath();
    const { version } = binary ? await this.getBinaryInfo(binary.path) : { version: null };
    const isRunning = binary !== null && await this.isProcessRunning();
    const secretPath = this.getSecretPath();

    return {
      installed: binary !== null,
      isManaged: binary?.isManaged ?? false,
      binaryPath: binary?.path ?? null,
      version,
      isRunning,
      secretExists: Boolean(secretPath && readSecretFile(secretPath)),
      secretPath,
      claimUrl: this.pendingClaim?.result?.claimUrl ?? null,
      claimError: this.claimError,
    };
  }

  async setSecretKey(secretKey: string): Promise<PlayitStatus> {
    const trimmed = secretKey.trim();
    if (!trimmed) throw new Error('Secret key cannot be empty.');
    if (!validSecretKey(trimmed)) throw new Error('Enter the complete hexadecimal secret key from Playit.');

    const secretPath = this.getSecretPath();
    if (!secretPath) throw new Error('Could not resolve the Playit configuration path.');

    await this.cancelPendingClaim();
    writeSecretFile(secretPath, trimmed);
    if (this.childProcess) killChild(this.childProcess);
    return this.startAgent();
  }

  async resetSecret(): Promise<PlayitStatus> {
    await this.cancelPendingClaim();
    if (this.childProcess) killChild(this.childProcess);
    this.childProcess = null;

    const secretPath = this.getSecretPath();
    if (secretPath) {
      await unlink(secretPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return this.getStatus();
  }

  async claimAccount(): Promise<ClaimResult> {
    if (this.pendingClaim?.result) return this.pendingClaim.result;
    if (this.claimRequest) return this.claimRequest;

    this.claimError = undefined;
    const request = this.openClaim(this.claimGeneration);
    this.claimRequest = request;
    try {
      return await request;
    } finally {
      if (this.claimRequest === request) this.claimRequest = null;
    }
  }

  private async openClaim(generation: number): Promise<ClaimResult> {
    const binaryPath = await this.requireCompatibleBinary();
    const secretPath = this.getSecretPath();
    if (!secretPath) throw new Error('Could not resolve the Playit configuration path.');

    await mkdir(path.dirname(secretPath), { recursive: true });
    const stage = await mkdtemp(path.join(path.dirname(secretPath), '.nodepilot-claim-'));
    const stagePath = path.join(stage, 'playit.toml');
    if (generation !== this.claimGeneration) {
      cleanClaimStage(stagePath);
      throw new Error('Playit account linking was cancelled.');
    }

    return new Promise<ClaimResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(binaryPath, ['--secret_path', stagePath, '--stdout'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        cleanClaimStage(stagePath);
        reject(new Error('Could not launch the Playit agent. Try installing it again.'));
        return;
      }

      const timeout = setTimeout(() => {
        this.failClaim(claim, 'Timed out waiting for a Playit claim URL. Check that this computer can reach playit.gg and try again.');
      }, 30_000);
      timeout.unref();
      const claim: PendingClaim = { child, stagePath, secretPath, result: null, timeout, reject };
      this.pendingClaim = claim;

      const buffers = { stdout: '', stderr: '' };
      const handleOutput = (stream: keyof typeof buffers, chunk: Buffer) => {
        if (this.pendingClaim !== claim) return;
        buffers[stream] = stripVTControlCharacters(buffers[stream] + chunk.toString()).slice(-4_096);
        if (claim.result) return;
        const match = buffers[stream].match(claimUrlPattern);
        if (!match) return;

        clearTimeout(claim.timeout);
        claim.timeout = setTimeout(() => {
          if (!this.promoteClaim(claim)) {
            this.failClaim(claim, 'The Playit claim expired. Choose Link Account to generate a new link.');
          }
        }, 10 * 60_000);
        claim.timeout.unref();

        claim.result = { claimUrl: `https://playit.gg/claim/${match[1]}`, claimCode: match[1] };
        resolve(claim.result);
      };

      child.stdout?.on('data', (chunk: Buffer) => handleOutput('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => handleOutput('stderr', chunk));
      child.once('error', () => {
        this.failClaim(claim, 'Could not run the Playit agent. Try installing it again.');
      });
      child.once('close', (code: number | null) => {
        if (this.childProcess === child) this.childProcess = null;
        if (this.pendingClaim === claim && !this.promoteClaim(claim)) {
          this.failClaim(claim, claimExitMessage(buffers.stdout + '\n' + buffers.stderr, code, Boolean(claim.result)));
        }
        cleanClaimStage(stagePath);
      });
    });
  }

  private promoteClaim(claim: PendingClaim): boolean {
    if (this.pendingClaim !== claim || !claim.result) return false;
    const newKey = readSecretFile(claim.stagePath);
    if (!newKey) return false;

    try {
      writeSecretFile(claim.secretPath, newKey);
    } catch {
      this.failClaim(claim, 'Playit approved this link, but NodePilot could not save the new key. Check the Playit configuration folder permissions and try again.');
      return false;
    }

    this.clearClaim(claim);
    this.claimError = undefined;
    if (isLiveChild(claim.child)) {
      if (this.childProcess) killChild(this.childProcess);
      this.childProcess = claim.child;
      claim.child.unref();
      if (claim.child.stdout instanceof Socket) claim.child.stdout.unref();
      if (claim.child.stderr instanceof Socket) claim.child.stderr.unref();
    }
    return true;
  }

  private failClaim(claim: PendingClaim, message: string): void {
    if (this.pendingClaim !== claim) return;
    killChild(claim.child);
    this.clearClaim(claim);
    if (claim.result) {
      this.claimError = message;
    } else {
      claim.reject(new Error(message));
    }
  }

  private clearClaim(claim: PendingClaim): void {
    clearTimeout(claim.timeout);
    this.pendingClaim = null;
    cleanClaimStage(claim.stagePath);
  }

  async cancelPendingClaim(): Promise<void> {
    this.claimGeneration += 1;
    this.claimRequest = null;
    if (this.pendingClaim) this.failClaim(this.pendingClaim, 'Playit account linking was cancelled.');
    this.claimError = undefined;
  }

  async startAgent(): Promise<PlayitStatus> {
    if (this.pendingClaim || this.claimRequest) return this.getStatus();

    const secretPath = this.getSecretPath();
    if (!secretPath || !readSecretFile(secretPath)) {
      throw new Error('Link a Playit account or enter a Playit agent secret key before starting the tunnel agent.');
    }

    const binaryPath = await this.requireCompatibleBinary();
    if (this.pendingClaim || this.claimRequest || await this.isProcessRunning()) return this.getStatus();

    const baseDir = this.dataDirectory || path.resolve('.nodepilot');
    await mkdir(baseDir, { recursive: true });
    if (this.pendingClaim || this.claimRequest || (this.childProcess && isLiveChild(this.childProcess))) {
      return this.getStatus();
    }

    const logPath = path.join(baseDir, 'playit.log');
    const child = spawn(binaryPath, ['--secret_path', secretPath, '--stdout', '-l', logPath, 'start'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const release = () => {
      if (this.childProcess === child) this.childProcess = null;
    };
    child.once('exit', release);
    child.once('error', release);
    child.unref();
    this.childProcess = child;

    // Surface immediate launch errors instead of reporting a stopped agent as a success.
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (this.childProcess === null) {
      throw new Error('Playit stopped during startup. Check the Playit log in the NodePilot data directory.');
    }
    return this.getStatus();
  }

  /**
   * Stop the Playit agent after an explicit user request.
   */
  async stopAgent(): Promise<PlayitStatus> {
    await this.cancelPendingClaim();
    if (this.childProcess) killChild(this.childProcess);
    this.childProcess = null;
    try {
      if (os.platform() === 'win32') {
        await execFileAsync('taskkill.exe', ['/F', '/IM', 'playit.exe', '/T'], probeOptions);
      } else {
        await execFileAsync('pkill', ['-x', 'playit'], probeOptions);
      }
    } catch {
      // Process may already be stopped.
    }

    return this.getStatus();
  }
}
