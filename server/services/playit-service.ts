import { exec, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PlayitStatus } from '../types.js';

const execAsync = promisify(exec);

export class PlayitService {
  private childProcess: ChildProcess | null = null;
  private cachedBinaryPath: string | null = null;

  /**
   * Locate the playit executable on the system.
   */
  async findBinaryPath(): Promise<string | null> {
    if (this.cachedBinaryPath && existsSync(this.cachedBinaryPath)) {
      return this.cachedBinaryPath;
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
        return candidate;
      }
    }

    // Try finding via `where` (win32) or `which` (unix)
    try {
      const cmd = platform === 'win32' ? 'where playit.exe' : 'which playit';
      const { stdout } = await execAsync(cmd);
      const found = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (found && existsSync(found)) {
        this.cachedBinaryPath = found;
        return found;
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
    const binaryPath = await this.findBinaryPath();
    const secretPath = this.getSecretPath();
    const secretExists = Boolean(secretPath && existsSync(secretPath));

    if (!binaryPath) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        isRunning: false,
        secretExists,
        secretPath,
      };
    }

    let version: string | null = null;
    try {
      const { stdout } = await execAsync(`"${binaryPath}" version`);
      version = stdout.trim();
    } catch {
      // Older or customized versions might not return cleanly
    }

    const isRunning = await this.isProcessRunning();

    return {
      installed: true,
      binaryPath,
      version,
      isRunning,
      secretExists,
      secretPath,
    };
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
      // Spawn unmanaged or background process
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
