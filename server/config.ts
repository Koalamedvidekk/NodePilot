import path from 'node:path';
import { fileURLToPath } from 'node:url';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function projectDirectory(): string {
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

  return {
    // NodePilot deliberately remains local-first unless an administrator explicitly opts in.
    host: process.env.NODEPILOT_HOST ?? '127.0.0.1',
    port: positiveInteger(process.env.NODEPILOT_PORT, 7420),
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
