import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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

export function loadEnv(): void {
  const projectRoot = projectDirectory();
  const rootEnv = path.join(projectRoot, '.env');
  const serverEnv = path.join(projectRoot, 'server', '.env');
  const cwdEnv = path.resolve(process.cwd(), '.env');

  // Load from root .env first
  if (existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv, override: true });
  }
  // Load from server/.env if it exists
  if (existsSync(serverEnv)) {
    dotenv.config({ path: serverEnv, override: true });
  }
  // Load from cwd .env if different
  if (existsSync(cwdEnv) && cwdEnv !== rootEnv && cwdEnv !== serverEnv) {
    dotenv.config({ path: cwdEnv, override: true });
  }
}

// Ensure environment variables are loaded immediately upon module import
loadEnv();

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
  loadEnv();
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
  const serverEnvPath = path.join(projectRoot, 'server', '.env');
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

  const finalContent = newLines.join('\n') + '\n';
  await writeFile(envPath, finalContent, 'utf8');

  // Keep server/.env synchronized as well so child workspace execution sees it
  try {
    await writeFile(serverEnvPath, finalContent, 'utf8');
  } catch {
    // Ignore if server directory isn't writable
  }

  // Update in-memory process.env immediately
  for (const [key, val] of Object.entries(updates)) {
    if (val === null) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

