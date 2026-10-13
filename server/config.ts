import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

export function projectDirectory(): string {
  // Source execution lives in server/, while compiled execution lives in server/dist/.
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const serverDirectory = path.basename(moduleDirectory) === 'dist'
    ? path.dirname(moduleDirectory)
    : moduleDirectory;
  return path.dirname(serverDirectory);
}

export interface NodePilotConfig {
  host: string;
  port: number;
  pin: string | null;
  isNetworkVisible: boolean;
  projectDirectory: string;
  dataDirectory: string;
  serversDirectory: string;
  importsDirectory: string;
  backupsDirectory: string;
  databasePath: string;
  clientDistDirectory: string;
}

export function getConfig(): NodePilotConfig {
  const projectRoot = projectDirectory();
  const dataDirectory = path.resolve(
    process.env.NODEPILOT_DATA_DIR ?? path.join(projectRoot, '.nodepilot'),
  );
  const host = process.env.NODEPILOT_HOST ?? '127.0.0.1';
  const pin = process.env.NODEPILOT_PIN?.trim() || null;

  return {
    // NodePilot deliberately remains local-first unless an administrator explicitly opts in.
    host,
    port: positiveInteger(process.env.NODEPILOT_PORT, 7420),
    pin,
    isNetworkVisible: host === '0.0.0.0',
    projectDirectory: projectRoot,
    dataDirectory,
    serversDirectory: path.join(dataDirectory, 'servers'),
    importsDirectory: path.join(dataDirectory, 'imports'),
    backupsDirectory: path.join(dataDirectory, 'backups'),
    databasePath: path.join(dataDirectory, 'nodepilot.sqlite'),
    clientDistDirectory: path.resolve(
      process.env.NODEPILOT_CLIENT_DIST ?? path.join(projectRoot, 'client', 'dist'),
    ),
  };
}

export async function updateEnvFile(updates: Record<string, string | null>): Promise<void> {
  const projectRoot = projectDirectory();
  const envPath = path.join(projectRoot, '.env');
  let content = '';

  try {
    content = await readFile(envPath, 'utf8');
  } catch {
    try {
      content = await readFile(path.join(projectRoot, '.env.example'), 'utf8');
    } catch {
      content = '';
    }
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set<string>();

  const newLines = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx).trim();
      if (key in updates) {
        updatedKeys.add(key);
        const val = updates[key];
        return val === null ? null : `${key}=${val}`;
      }
      return line;
    })
    .filter((line): line is string => line !== null);

  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key) && val !== null) {
      newLines.push(`${key}=${val}`);
    }
  }

  await writeFile(envPath, newLines.join('\n') + '\n', 'utf8');
}

