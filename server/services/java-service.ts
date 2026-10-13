import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JavaInstallation } from '../types.js';

const JAVA_PROBE_TIMEOUT_MS = 5_000;
const CACHE_MS = 30_000;

function executableName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(output: string): { version: string; major: number } | null {
  const quoted = output.match(/(?:java|openjdk)[^\n]*?version\s+["']([^"']+)["']/i)
    ?? output.match(/version\s+["']([^"']+)["']/i);
  const fallback = output.match(/(?:openjdk|java)\s+(\d+(?:\.\d+(?:\.\d+)?)?)/i);
  const version = quoted?.[1] ?? fallback?.[1];
  if (!version) return null;

  const components = version.match(/^(\d+)(?:\.(\d+))?/);
  if (!components) return null;
  const first = Number.parseInt(components[1], 10);
  const second = Number.parseInt(components[2] ?? '', 10);
  const major = first === 1 && Number.isInteger(second) ? second : first;
  return Number.isInteger(major) && major > 0 ? { version, major } : null;
}

async function probeJava(javaPath: string): Promise<JavaInstallation | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (value: JavaInstallation | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    let child;
    try {
      child = spawn(javaPath, ['-version'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, JAVA_PROBE_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', () => finish(null));
    child.once('close', () => {
      const parsed = parseVersion(output);
      if (!parsed) {
        finish(null);
        return;
      }
      const firstLine = output.split(/\r?\n/).find(Boolean)?.trim() ?? null;
      finish({
        path: javaPath,
        version: parsed.version,
        major: parsed.major,
        vendor: firstLine,
        compatible: true,
      });
    });
  });
}

async function directoryChildren(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/** Locates and probes installed Java runtimes without executing a shell. */
export class JavaService {
  private cached: JavaInstallation[] | null = null;
  private cachedAt = 0;

  async list(): Promise<JavaInstallation[]> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_MS) return this.cached;

    const candidates = new Set<string>();
    const exe = executableName();
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) candidates.add(path.join(javaHome, 'bin', exe));

    // `java` deliberately remains a candidate: PATH resolution is handled by spawn, never a shell.
    candidates.add('java');

    if (process.platform === 'win32') {
      const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
        .filter((value): value is string => Boolean(value));
      for (const base of bases) {
        for (const relative of ['Java', path.join('Eclipse Adoptium'), path.join('Microsoft', 'jdk')]) {
          const root = path.join(base, relative);
          for (const child of await directoryChildren(root)) candidates.add(path.join(root, child, 'bin', exe));
        }
      }
    } else {
      candidates.add('/usr/bin/java');
      candidates.add('/usr/local/bin/java');
      for (const child of await directoryChildren('/usr/lib/jvm')) candidates.add(path.join('/usr/lib/jvm', child, 'bin', exe));
      for (const child of await directoryChildren('/Library/Java/JavaVirtualMachines')) {
        candidates.add(path.join('/Library/Java/JavaVirtualMachines', child, 'Contents', 'Home', 'bin', exe));
      }
    }

    const installations: JavaInstallation[] = [];
    const seenRealPaths = new Set<string>();
    for (const candidate of candidates) {
      if (candidate !== 'java' && !(await fileExists(candidate))) continue;
      const installation = await probeJava(candidate);
      if (!installation) continue;
      // Retain only one entry per executable, while allowing PATH-only Java where its real path is unknown.
      const identity = path.normalize(installation.path).toLocaleLowerCase();
      if (seenRealPaths.has(identity)) continue;
      seenRealPaths.add(identity);
      installations.push(installation);
    }

    installations.sort((left, right) => right.major - left.major || left.path.localeCompare(right.path));
    this.cached = installations;
    this.cachedAt = Date.now();
    return installations;
  }

  async findUsable(requiredMajor: number | null, preferredPath?: string | null): Promise<{ installation: JavaInstallation; warning?: string } | null> {
    const installations = await this.list();
    const preferred = preferredPath
      ? installations.find((entry) => entry.path === preferredPath)
      : undefined;
    const candidates = preferred ? [preferred, ...installations.filter((entry) => entry.path !== preferred.path)] : installations;
    if (!requiredMajor) return candidates[0] ? { installation: candidates[0] } : null;

    const exact = candidates.find((entry) => entry.major === requiredMajor);
    if (exact) return { installation: exact };
    // Newer Java releases work for many historical Minecraft versions. We permit this explicit
    // fallback but return a warning so the panel can explain why startup might still fail.
    const newer = candidates.find((entry) => entry.major > requiredMajor);
    if (newer) {
      return {
        installation: newer,
        warning: `Minecraft ${requiredMajor === 8 ? 'requires' : 'targets'} Java ${requiredMajor}; using newer Java ${newer.major} instead.`,
      };
    }
    return null;
  }

  platformLabel(): string {
    return `${os.type()} ${os.release()}`;
  }
}
