import { exec, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { PlayitStatus } from '../types.js';

const execAsync = promisify(exec);

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
  private exchangeProcess: ChildProcess | null = null;
  private cachedBinaryPath: string | null = null;
  private managedBinaryPath: string;
  private activeClaimUrl: string | null = null;

  constructor(private readonly dataDirectory?: string) {
    const baseDir = this.dataDirectory || path.resolve('.nodepilot');
    this.managedBinaryPath = path.join(
      baseDir,
      'bin',
      os.platform() === 'win32' ? 'playit.exe' : 'playit',
    );
  }

  /**
   * Determine the official download URL for the host machine.
   */
  getDownloadUrl(): { url: string; fileName: string } | null {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'win32') {
      if (arch === 'x64' || arch === 'arm64') {
        return {
          url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.exe',
          fileName: 'playit.exe',
        };
      }
      return {
        url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86-signed.exe',
        fileName: 'playit.exe',
      };
    }

    if (platform === 'linux') {
      if (arch === 'x64') {
        return {
          url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64',
          fileName: 'playit',
        };
      }
      if (arch === 'arm64' || arch === 'arm') {
        return {
          url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-aarch64',
          fileName: 'playit',
        };
      }
    }

    return null;
  }

  /**
   * Automatically download and install Playit into .nodepilot/bin/
   */
  async installManagedBinary(): Promise<PlayitStatus> {
    const download = this.getDownloadUrl();
    if (!download) {
      throw new Error(`Automatic Playit installation is not supported for ${os.platform()} (${os.arch()}).`);
    }

    await mkdir(path.dirname(this.managedBinaryPath), { recursive: true });
    const tempFile = `${this.managedBinaryPath}.tmp-${Date.now()}`;

    try {
      const response = await fetch(download.url, { redirect: 'follow' });
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download Playit agent from GitHub (${response.status} ${response.statusText}).`);
      }

      // @ts-ignore Node.js fetch ReadableStream compatibility
      const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeStream, createWriteStream(tempFile));

      if (existsSync(this.managedBinaryPath)) {
        await unlink(this.managedBinaryPath).catch(() => undefined);
      }

      const { rename } = await import('node:fs/promises');
      await rename(tempFile, this.managedBinaryPath);

      if (os.platform() !== 'win32') {
        await chmod(this.managedBinaryPath, 0o755);
      }

      this.cachedBinaryPath = this.managedBinaryPath;
      return this.getStatus();
    } catch (err) {
      await unlink(tempFile).catch(() => undefined);
      throw new Error(`Playit installation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Locate the playit executable on the system.
   * NodePilot's managed binary in .nodepilot/bin takes precedence.
   */
  async findBinaryPath(): Promise<{ path: string; isManaged: boolean } | null> {
    if (existsSync(this.managedBinaryPath)) {
      this.cachedBinaryPath = this.managedBinaryPath;
      return { path: this.managedBinaryPath, isManaged: true };
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
      const cmd = platform === 'win32' ? 'where playit.exe' : 'which playit';
      const { stdout } = await execAsync(cmd);
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
    if (!secretPath || !existsSync(secretPath)) {
      return null;
    }
    try {
      const content = readFileSync(secretPath, 'utf8');
      const match = content.match(/secret_key\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
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
        if (firstAuto) {
          connectionAddress = firstAuto;
        } else if (publicAddress && publicPort) {
          connectionAddress = `${publicAddress}:${publicPort}`;
        } else if (publicAddress) {
          connectionAddress = publicAddress;
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
   * Check if playit process is currently running on the host.
   */
  async isProcessRunning(): Promise<boolean> {
    if (this.childProcess && !this.childProcess.killed) {
      return true;
    }

    const platform = os.platform();
    try {
      if (platform === 'win32') {
        const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq playit.exe" /NH');
        return stdout.toLowerCase().includes('playit.exe');
      } else {
        const { stdout } = await execAsync('pgrep -x playit || true');
        return stdout.trim().length > 0;
      }
    } catch {
      return false;
    }
  }

  /**
   * Fetch current Playit installation and runtime status.
   */
  async getStatus(): Promise<PlayitStatus> {
    const binary = await this.findBinaryPath();
    const secretPath = this.getSecretPath();
    const secretExists = Boolean(secretPath && existsSync(secretPath));

    if (!binary) {
      return {
        installed: false,
        isManaged: false,
        binaryPath: null,
        version: null,
        isRunning: false,
        secretExists,
        secretPath,
        claimUrl: null,
      };
    }

    let version: string | null = null;
    try {
      const { stdout } = await execAsync(`"${binary.path}" version`);
      version = stdout.trim();
    } catch {
      // Older or customized versions might not return cleanly
    }

    const isRunning = await this.isProcessRunning();

    return {
      installed: true,
      isManaged: binary.isManaged,
      binaryPath: binary.path,
      version,
      isRunning,
      secretExists,
      secretPath,
      claimUrl: this.activeClaimUrl,
    };
  }

  /**
   * Directly save or replace the Playit secret key in playit.toml, then launch the agent.
   * This solves the issue of users hitting the max agent limit on existing Playit accounts.
   */
  async setSecretKey(secretKey: string): Promise<PlayitStatus> {
    const trimmed = secretKey.trim();
    if (!trimmed) {
      throw new Error('Secret key cannot be empty.');
    }

    const secretPath = this.getSecretPath();
    if (!secretPath) {
      throw new Error('Could not resolve Playit configuration path on this operating system.');
    }

    // Stop currently running agent if any before modifying credentials
    await this.stopAgent().catch(() => undefined);

    await mkdir(path.dirname(secretPath), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(secretPath, `secret_key = "${trimmed}"\n`, 'utf8');

    // Auto-launch the agent daemon now that key is configured
    return this.startAgent();
  }

  /**
   * Reset / unlink Playit credentials by stopping any active agent and removing playit.toml.
   */
  async resetSecret(): Promise<PlayitStatus> {
    await this.stopAgent().catch(() => undefined);

    if (this.exchangeProcess && !this.exchangeProcess.killed) {
      try {
        this.exchangeProcess.kill();
      } catch {}
      this.exchangeProcess = null;
    }

    this.activeClaimUrl = null;

    const secretPath = this.getSecretPath();
    if (secretPath && existsSync(secretPath)) {
      await unlink(secretPath).catch(() => undefined);
    }

    return this.getStatus();
  }

  /**
   * Start account claim workflow: spawns the playit agent in auto-run mode with stdout,
   * captures the live claim URL issued by playit.gg, and keeps the agent process running
   * so playit.gg immediately detects the agent as ONLINE when the user opens the page.
   */
  async claimAccount(): Promise<{ claimUrl: string; claimCode: string }> {
    const status = await this.getStatus();
    if (!status.installed || !status.binaryPath) {
      throw new Error('Playit CLI must be installed before claiming an account.');
    }

    // Stop existing process if running to start fresh claim session
    await this.stopAgent().catch(() => undefined);

    if (this.exchangeProcess && !this.exchangeProcess.killed) {
      try {
        this.exchangeProcess.kill();
      } catch {}
      this.exchangeProcess = null;
    }

    const binaryPath = status.binaryPath;

    return new Promise<{ claimUrl: string; claimCode: string }>((resolve, reject) => {
      let resolved = false;

      const child: ChildProcess = spawn(binaryPath, ['--stdout'], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            child.kill();
          } catch {}
          reject(new Error('Timed out waiting for Playit agent to connect and generate claim URL.'));
        }
      }, 30_000);

      this.childProcess = child;

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/https:\/\/playit\.gg\/claim\/([a-zA-Z0-9]+)/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const claimUrl = match[0];
          const claimCode = match[1];
          this.activeClaimUrl = claimUrl;
          resolve({ claimUrl, claimCode });
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.once('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.childProcess = null;
          reject(err);
        }
      });

      child.once('exit', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.childProcess = null;
          reject(new Error('Playit agent exited before providing a claim URL.'));
        }
      });
    });
  }

  /**
   * Start the Playit agent if installed and not already running.
   */
  async startAgent(): Promise<PlayitStatus> {
    const status = await this.getStatus();
    if (!status.installed || !status.binaryPath) {
      throw new Error('Playit CLI is not installed on this host.');
    }

    if (status.isRunning) {
      return status;
    }

    try {
      // Spawn unmanaged background daemon process
      const child = spawn(status.binaryPath, ['start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });

      child.unref();
      this.childProcess = child;

      // Small delay to let process initialize
      await new Promise((resolve) => setTimeout(resolve, 800));

      return this.getStatus();
    } catch (err) {
      throw new Error(`Failed to start Playit agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stop the Playit agent process.
   */
  async stopAgent(): Promise<PlayitStatus> {
    const platform = os.platform();
    try {
      if (platform === 'win32') {
        await execAsync('taskkill /F /IM playit.exe /T');
      } else {
        await execAsync('pkill -x playit');
      }
    } catch {
      // Process may already be stopped
    }

    this.childProcess = null;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.getStatus();
  }
}
