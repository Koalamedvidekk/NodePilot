import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import * as yauzl from 'yauzl';

import { AppError } from '../lib/errors.js';
import type { ServerSoftware } from '../types.js';

const MAX_ARCHIVE_ENTRIES = 30_000;
const MAX_METADATA_BYTES = 512 * 1024;

export type JarMetadata = {
  valid: boolean;
  fileName: string;
  size: number;
  software: ServerSoftware;
  minecraftVersion?: string;
  name?: string;
  version?: string;
  apiVersion?: string;
  loader?: string;
  manifest?: Record<string, string>;
  entries: string[];
};

function parseManifest(raw: string): Record<string, string> {
  const unfolded = raw.replace(/\r?\n /g, '');
  return Object.fromEntries(unfolded.split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf(':');
      return separator < 1 ? undefined : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
    })
    .filter((value): value is readonly [string, string] => Boolean(value)));
}

function valueFromYaml(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*["']?([^\\r\\n"']+)["']?\\s*$`, 'mi'));
  return match?.[1]?.trim();
}

function valueFromToml(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, 'mi'));
  return match?.[1]?.trim();
}

function versionFromText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/.test(value) ? value : undefined;
}

async function openZip(filePath: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(filePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch {
    throw new AppError(400, 'invalid_jar', 'The selected file is not a valid JAR/ZIP archive.');
  }
}

async function readEntryText(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  if (entry.uncompressedSize > MAX_METADATA_BYTES) {
    throw new AppError(400, 'jar_metadata_too_large', 'A JAR metadata entry is unexpectedly large.');
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_METADATA_BYTES) stream.destroy(new AppError(400, 'jar_metadata_too_large', 'A JAR metadata entry is unexpectedly large.'));
    else chunks.push(Buffer.from(chunk));
  });
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

/** Read the small descriptor files that identify a Minecraft JAR without loading its contents. */
export async function inspectJar(filePath: string): Promise<JarMetadata> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new AppError(400, 'invalid_jar', 'The selected add-on is not a non-empty regular file.');
  }
  const zip = await openZip(filePath);
  try {
    const interesting = new Map<string, yauzl.Entry>();
    const entries: string[] = [];
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= MAX_ARCHIVE_ENTRIES) {
        throw new AppError(400, 'jar_too_many_entries', 'The JAR contains too many entries to inspect safely.');
      }
      entries.push(entry.fileName);
      const lower = entry.fileName.toLowerCase();
      if (new Set([
        'meta-inf/manifest.mf',
        'plugin.yml',
        'paper-plugin.yml',
        'fabric.mod.json',
        'quilt.mod.json',
        'meta-inf/mods.toml',
        'meta-inf/neoforge.mods.toml',
        'version.json',
      ]).has(lower)) interesting.set(lower, entry);
    }

    const read = async (name: string) => {
      const entry = interesting.get(name);
      return entry ? readEntryText(zip, entry) : undefined;
    };
    const [manifestText, pluginYml, paperPluginYml, fabricModJson, quiltModJson, forgeToml, neoForgeToml, versionJson] = await Promise.all([
      read('meta-inf/manifest.mf'),
      read('plugin.yml'),
      read('paper-plugin.yml'),
      read('fabric.mod.json'),
      read('quilt.mod.json'),
      read('meta-inf/mods.toml'),
      read('meta-inf/neoforge.mods.toml'),
      read('version.json'),
    ]);
    const manifest = manifestText ? parseManifest(manifestText) : undefined;
    let software: ServerSoftware = 'unknown';
    let name: string | undefined;
    let version: string | undefined;
    let apiVersion: string | undefined;
    let loader: string | undefined;

    if (paperPluginYml || pluginYml) {
      const descriptor = paperPluginYml ?? pluginYml ?? '';
      software = 'paper';
      name = valueFromYaml(descriptor, 'name');
      version = valueFromYaml(descriptor, 'version');
      apiVersion = valueFromYaml(descriptor, 'api-version');
    } else if (fabricModJson || quiltModJson) {
      const descriptor = fabricModJson ?? quiltModJson ?? '{}';
      try {
        const parsed = JSON.parse(descriptor) as { id?: string; name?: string; version?: string };
        software = quiltModJson ? 'quilt' : 'fabric';
        name = parsed.name ?? parsed.id;
        version = parsed.version;
      } catch {
        software = quiltModJson ? 'quilt' : 'fabric';
      }
      loader = quiltModJson ? 'quilt' : 'fabric';
    } else if (neoForgeToml) {
      software = 'neoforge';
      name = valueFromToml(neoForgeToml, 'modId') ?? valueFromToml(neoForgeToml, 'displayName');
      version = valueFromToml(neoForgeToml, 'version');
      loader = 'neoforge';
    } else if (forgeToml) {
      software = 'forge';
      name = valueFromToml(forgeToml, 'modId') ?? valueFromToml(forgeToml, 'displayName');
      version = valueFromToml(forgeToml, 'version');
      loader = 'forge';
    } else if (/purpur/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'purpur';
    } else if (/spigot|craftbukkit/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'spigot';
    } else if (/paper|papermc/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'paper';
    } else if (/quilt/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'quilt';
      loader = 'quilt';
    } else if (/fabric/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'fabric';
      loader = 'fabric';
    } else if (/forge/i.test(`${manifest?.['Implementation-Title'] ?? ''} ${manifest?.['Main-Class'] ?? ''}`)) {
      software = 'forge';
      loader = 'forge';
    }

    let minecraftVersion: string | undefined;
    if (versionJson) {
      try {
        const parsed = JSON.parse(versionJson) as { id?: string; name?: string };
        minecraftVersion = versionFromText(parsed.id) ?? versionFromText(parsed.name);
      } catch {
        // JARs with an opaque version.json still remain valid archives.
      }
    }
    return {
      valid: true,
      fileName: filePath.split(/[\\/]/).pop() ?? 'unknown.jar',
      size: fileStats.size,
      software,
      minecraftVersion,
      name,
      version,
      apiVersion,
      loader,
      manifest,
      entries,
    };
  } finally {
    zip.close();
  }
}

export async function checksumFile(filePath: string, algorithm: 'sha1' | 'sha512' = 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest('hex');
}
