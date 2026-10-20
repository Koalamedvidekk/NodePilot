import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

import { AppError } from '../lib/errors.js';
import type { JavaInstallation } from '../types.js';

const JAVA_PROBE_TIMEOUT_MS = 5_000;
const CACHE_MS = 30_000;
const DOWNLOADABLE_MAJORS = [8, 11, 16, 17, 21, 25];

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

/** Locates, probes, and automatically downloads managed Java runtimes. */
export class JavaService {
  private cached: JavaInstallation[] | null = null;
  private cachedAt = 0;
  private readonly managedJavaDir: string;
  private activeDownloads = new Map<number, Promise<JavaInstallation>>();

  constructor(private readonly dataDirectory?: string) {
    const baseDir = this.dataDirectory || path.resolve('.nodepilot');
    this.managedJavaDir = path.join(baseDir, 'java');
  }

  getManagedJavaDir(): string {
    return this.managedJavaDir;
  }

  getDownloadableMajors(): number[] {
    return [...DOWNLOADABLE_MAJORS];
  }

  isInstalling(major: number): boolean {
    return this.activeDownloads.has(major);
  }

  async list(): Promise<JavaInstallation[]> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_MS) return this.cached;

    const candidates = new Set<string>();
    const exe = executableName();
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) candidates.add(path.join(javaHome, 'bin', exe));

    // `java` deliberately remains a candidate: PATH resolution is handled by spawn, never a shell.
    candidates.add('java');

    // Managed NodePilot Java directory (.nodepilot/java/jdk-<version>)
    if (await fileExists(this.managedJavaDir)) {
      for (const child of await directoryChildren(this.managedJavaDir)) {
        if (child === 'tmp') continue;
        const childDir = path.join(this.managedJavaDir, child);
        candidates.add(path.join(childDir, 'bin', exe));
        for (const sub of await directoryChildren(childDir)) {
          candidates.add(path.join(childDir, sub, 'bin', exe));
        }
      }
    }

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

  /** Resolve official Adoptium download URL for the target Java major version and host architecture */
  async getDownloadUrl(major: number): Promise<{ url: string; fileName: string; isZip: boolean }> {
    const platform = process.platform;
    const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? (platform === 'win32' ? 'x64' : 'aarch64') : process.arch === 'ia32' ? 'x86' : 'x64';

    // Adoptium API v3 endpoint
    const gaUrl = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
    const eaUrl = `https://api.adoptium.net/v3/binary/latest/${major}/ea/${osName}/${arch}/jdk/hotspot/normal/eclipse`;

    let response = await fetch(gaUrl, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok && response.status === 404) {
      response = await fetch(eaUrl, { method: 'HEAD', redirect: 'follow' });
    }

    if (!response.ok) {
      throw new AppError(
        404,
        'jdk_unavailable',
        `Eclipse Adoptium OpenJDK ${major} is not currently available for ${osName} (${arch}) (Status ${response.status}).`
      );
    }

    const finalUrl = response.url;
    const isZip = platform === 'win32' || finalUrl.includes('.zip');
    const urlPath = new URL(finalUrl).pathname;
    const fileName = urlPath.split('/').pop() || `OpenJDK${major}.${isZip ? 'zip' : 'tar.gz'}`;

    return { url: finalUrl, fileName, isZip };
  }

  /** Download and extract OpenJDK into managed .nodepilot/java/jdk-{major} directory */
  async downloadAndInstall(major: number): Promise<JavaInstallation> {
    const existing = this.activeDownloads.get(major);
    if (existing) return existing;

    const task = (async () => {
      const targetDir = path.join(this.managedJavaDir, `jdk-${major}`);
      const tmpDir = path.join(this.managedJavaDir, 'tmp');
      await mkdir(tmpDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });

      const downloadInfo = await this.getDownloadUrl(major);
      const ext = downloadInfo.isZip ? '.zip' : '.tar.gz';
      const tempArchive = path.join(tmpDir, `download-${major}-${Date.now()}${ext}`);

      try {
        const response = await fetch(downloadInfo.url, { redirect: 'follow' });
        if (!response.ok || !response.body) {
          throw new AppError(502, 'download_failed', `Failed to download OpenJDK ${major} from Adoptium (${response.status} ${response.statusText}).`);
        }

        // @ts-ignore Node.js fetch ReadableStream compatibility
        const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        await pipeline(nodeStream, createWriteStream(tempArchive));

        await this.extractArchive(tempArchive, targetDir);

        // Invalidate cached discoveries
        this.cached = null;
        this.cachedAt = 0;

        // Locate java executable inside targetDir or its single nested root
        const exe = executableName();
        const candidatePaths = [
          path.join(targetDir, 'bin', exe),
        ];
        for (const sub of await directoryChildren(targetDir)) {
          candidatePaths.push(path.join(targetDir, sub, 'bin', exe));
        }

        let verifiedInstallation: JavaInstallation | null = null;
        for (const candidate of candidatePaths) {
          if (await fileExists(candidate)) {
            if (process.platform !== 'win32') {
              await chmod(candidate, 0o755).catch(() => undefined);
            }
            const probed = await probeJava(candidate);
            if (probed) {
              probed.vendor = probed.vendor ? `${probed.vendor} (Adoptium Managed)` : 'Adoptium OpenJDK (Managed)';
              verifiedInstallation = probed;
              break;
            }
          }
        }

        if (!verifiedInstallation) {
          throw new AppError(500, 'java_verify_failed', `OpenJDK ${major} was installed, but the Java runtime binary could not be verified.`);
        }

        return verifiedInstallation;
      } finally {
        await unlink(tempArchive).catch(() => undefined);
        this.activeDownloads.delete(major);
      }
    })();

    this.activeDownloads.set(major, task);
    return task;
  }

  private async extractArchive(archivePath: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });

    // 1. Try native tar (handles both .zip and .tar.gz on Windows 10+ and Linux/macOS)
    const tarResult = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn('tar', ['-xf', archivePath, '-C', destination], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.once('error', () => resolve(false));
        child.once('close', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });

    if (tarResult) return;

    // 2. If tar failed or unavailable and file is .zip, fallback to yauzl
    if (archivePath.endsWith('.zip')) {
      const zip = await yauzl.openPromise(archivePath, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: false,
        strictFileNames: false,
      });
      try {
        for await (const entry of zip.eachEntry()) {
          const rawPath = entry.fileName.replace(/\\/g, '/');
          if (
            !rawPath ||
            rawPath.startsWith('/') ||
            rawPath.startsWith('\\') ||
            /^[a-zA-Z]:/.test(rawPath) ||
            rawPath.split('/').some((part) => part === '..')
          ) {
            continue;
          }
          const targetPath = path.join(destination, ...rawPath.split('/'));
          if (rawPath.endsWith('/')) {
            await mkdir(targetPath, { recursive: true });
            continue;
          }
          await mkdir(path.dirname(targetPath), { recursive: true });
          const readStream = await zip.openReadStreamPromise(entry);
          await pipeline(readStream, createWriteStream(targetPath, { flags: 'w' }));
          if (process.platform !== 'win32') {
            const base = path.basename(targetPath);
            if (base === 'java' || base === 'javac' || base.endsWith('.so') || base.includes('.so.')) {
              await chmod(targetPath, 0o755).catch(() => undefined);
            }
          }
        }
      } finally {
        zip.close();
      }
    } else {
      throw new AppError(500, 'archive_extraction_failed', `Failed to extract archive: native tar is unavailable or exited with an error.`);
    }
  }

  platformLabel(): string {
    return `${os.type()} ${os.release()}`;
  }
}
