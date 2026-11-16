import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../lib/errors.js';
import { resolveInside, resolveManagedServerRoot } from '../lib/paths.js';
import { BROWSER_AUTH_JAR_BASE64, BROWSER_AUTH_JAR_SHA256 } from './browser-auth-artifact.js';
import { BROWSER_GATEWAY_JAVA_MAJOR, browserJavaDependencies, cloudflaredDependency, type BrowserDependency } from './browser-dependency-manifest.js';

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
export const BROWSER_AUTH_PLUGIN_VERSION = '0.1.1';

export interface BrowserInstalledDependencies {
  directory: string;
  velocityJar: string;
  cloudflared: string;
  bungeeGuardJar: string;
  authPluginJar: string;
  javaMajor: number;
  versions: Record<string, string>;
}

async function fileHash(file: string): Promise<string | null> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new AppError(409, 'unsafe_browser_dependency', 'A browser dependency was replaced by a link or an invalid file.');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Downloads only the pinned official binaries. The companion JAR is built from the checked-in source. */
export class BrowserDependencyService {
  private readonly requests = new Map<string, Promise<BrowserInstalledDependencies>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  constructor(private readonly dataDirectory: string) {}

  getManifest(): { javaMajor: number; dependencies: readonly BrowserDependency[]; supported: boolean } {
    const cloudflared = cloudflaredDependency(process.platform, process.arch);
    return { javaMajor: BROWSER_GATEWAY_JAVA_MAJOR, dependencies: [...browserJavaDependencies, ...(cloudflared ? [cloudflared] : [])], supported: Boolean(cloudflared) };
  }

  install(serverId: string, progress?: (message: string) => void): Promise<BrowserInstalledDependencies> {
    if (this.stopped) return Promise.reject(new AppError(409, 'browser_download_cancelled', 'Browser component installation was cancelled during shutdown.'));
    const existing = this.requests.get(serverId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.add(controller);
    const request = this.installFiles(serverId, progress, controller.signal).finally(() => {
      this.controllers.delete(controller);
      if (this.requests.get(serverId) === request) this.requests.delete(serverId);
    });
    this.requests.set(serverId, request);
    return request;
  }

  cancelAll(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }

  private async installFiles(serverId: string, progress: ((message: string) => void) | undefined, signal: AbortSignal): Promise<BrowserInstalledDependencies> {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(serverId)) {
      throw new AppError(400, 'invalid_server_id', 'A valid server identity is required.');
    }
    const tunnel = cloudflaredDependency(process.platform, process.arch);
    if (!tunnel) {
      throw new AppError(422, 'browser_platform_unavailable', 'Browser access supports Windows x64 and Linux x64/arm64. No pinned official tunnel binary is available for this architecture.');
    }
    const root = path.join(this.dataDirectory, 'browser-access');
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) {
      throw new AppError(409, 'unsafe_browser_directory', 'The browser access directory must not be a filesystem link.');
    }
    const directory = await resolveManagedServerRoot(root, serverId.toLowerCase(), true);
    for (const folder of ['plugins', 'backend']) {
      const target = await resolveInside(directory, folder, false);
      await mkdir(target, { recursive: true });
      if ((await lstat(path.join(directory, folder))).isSymbolicLink()) {
        throw new AppError(409, 'unsafe_browser_directory', 'Managed browser dependency directories must not be filesystem links.');
      }
    }
    const plugins = path.join(directory, 'plugins');
    const versions: Record<string, string> = {};
    for (const dependency of [...browserJavaDependencies, tunnel]) {
      signal.throwIfAborted();
      progress?.('Verifying ' + dependency.id + ' ' + dependency.version);
      const targetDirectory = dependency.id === 'bungeeguard' ? path.join(directory, 'backend')
        : dependency.id === 'velocity' || dependency.id === 'cloudflared' ? directory : plugins;
      const destination = path.join(targetDirectory, dependency.fileName);
      await this.download(dependency, destination, signal);
      versions[dependency.id] = dependency.version;
    }
    signal.throwIfAborted();
    const authentication = await this.refreshAuthCompanion(serverId);
    versions['nodepilot-browser-auth'] = authentication.version;
    return {
      directory, velocityJar: path.join(directory, 'velocity.jar'),
      cloudflared: path.join(directory, tunnel.fileName),
      bungeeGuardJar: path.join(directory, 'backend', 'BungeeGuard.jar'),
      authPluginJar: authentication.path, javaMajor: BROWSER_GATEWAY_JAVA_MAJOR, versions,
    };
  }

  /** Refresh only NodePilot's own companion before a gateway starts. */
  async refreshAuthCompanion(serverId: string): Promise<{ path: string; version: string }> {
    if (this.stopped) throw new AppError(409, 'browser_download_cancelled', 'Browser authentication update was cancelled during shutdown.');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(serverId)) {
      throw new AppError(400, 'invalid_server_id', 'A valid server identity is required.');
    }
    const root = path.join(this.dataDirectory, 'browser-access');
    if ((await lstat(root)).isSymbolicLink()) throw new AppError(409, 'unsafe_browser_directory', 'The browser access directory must not be a filesystem link.');
    const directory = await resolveManagedServerRoot(root, serverId.toLowerCase());
    const plugins = path.join(directory, 'plugins');
    const metadata = await lstat(plugins);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AppError(409, 'unsafe_browser_directory', 'The managed plugins directory must be an ordinary directory.');
    const authPluginJar = path.join(plugins, 'NodePilotBrowserAuth.jar');
    if (await fileHash(authPluginJar) !== BROWSER_AUTH_JAR_SHA256) {
      const bytes = Buffer.from(BROWSER_AUTH_JAR_BASE64, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== BROWSER_AUTH_JAR_SHA256) {
        throw new AppError(500, 'browser_companion_invalid', 'The bundled browser authentication companion failed integrity verification.');
      }
      const temporary = authPluginJar + '.tmp-' + randomUUID();
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        if (this.stopped) throw new AppError(409, 'browser_download_cancelled', 'Browser authentication update was cancelled during shutdown.');
        await rename(temporary, authPluginJar);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    return { path: authPluginJar, version: BROWSER_AUTH_PLUGIN_VERSION };
  }

  private async download(dependency: BrowserDependency, destination: string, parentSignal?: AbortSignal): Promise<void> {
    parentSignal?.throwIfAborted();
    if (await fileHash(destination) === dependency.sha256) return;
    const temporary = destination + '.tmp-' + randomUUID();
    const timeout = AbortSignal.timeout(120_000);
    const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
    try {
      const response = await fetch(dependency.url, {
        signal, headers: { 'User-Agent': 'NodePilot browser access (https://github.com/Koalamedvidekk/NodePilot)' },
      });
      if (!response.ok || !response.body) {
        throw new Error('The official download returned HTTP ' + response.status + '.');
      }
      const hash = createHash('sha256');
      let bytes = 0;
      const limits = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_DOWNLOAD_BYTES) {
            callback(new Error('The official download exceeded the allowed size.'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        limits, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (hash.digest('hex') !== dependency.sha256) {
        throw new Error('The download failed its pinned SHA-256 integrity check.');
      }
      if (dependency.id === 'cloudflared' && process.platform !== 'win32') await chmod(temporary, 0o700);
      await rename(temporary, destination);
    } catch (error) {
      if (parentSignal?.aborted) throw new AppError(409, 'browser_download_cancelled', 'Browser component installation was cancelled during shutdown.');
      const detail = timeout.aborted ? 'The download timed out.' : error instanceof Error ? error.message : 'Download failed.';
      throw new AppError(502, 'browser_dependency_download_failed', 'Could not install ' + dependency.id + '. ' + detail);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
