import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export class InstanceLock {
  private lockFilePath: string;

  constructor(dataDirectory: string) {
    this.lockFilePath = path.join(dataDirectory, 'nodepilot.pid');
  }

  /**
   * Acquire single-instance lock or detect running instance.
   * If an old PID is found, check if it's still alive. If dead, reclaim cleanly.
   */
  async acquire(): Promise<boolean> {
    await mkdir(path.dirname(this.lockFilePath), { recursive: true });

    if (existsSync(this.lockFilePath)) {
      try {
        const content = readFileSync(this.lockFilePath, 'utf8').trim();
        const existingPid = Number(content);
        if (Number.isInteger(existingPid) && existingPid > 0) {
          if (existingPid === process.pid) {
            return true; // Already acquired by this process
          }
          // Check if external process exists
          if (this.isProcessRunning(existingPid)) {
            return false; // Another real instance is running
          }
        }
      } catch {
        // Corrupt lock file, overwrite
      }
    }

    try {
      writeFileSync(this.lockFilePath, String(process.pid), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      if (existsSync(this.lockFilePath)) {
        const content = readFileSync(this.lockFilePath, 'utf8').trim();
        if (Number(content) === process.pid) {
          unlinkSync(this.lockFilePath);
        }
      }
    } catch {
      // Ignore release errors
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 tests for existence without killing
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      return code === 'EPERM'; // Exists but belongs to another user
    }
  }
}
