import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from './errors.js';

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve a NodePilot-generated server directory under the configured servers root. Unlike a
 * generic relative path, a managed directory must be a single generated slug and can never be
 * a symlink/junction. This protects process CWD, provisioning, and deletion from a server-side
 * plugin replacing its own directory with a link to another part of the host.
 */
export async function resolveManagedServerRoot(
  serversDirectory: string,
  directory: string,
  create = false,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(directory)) {
    throw new AppError(500, 'invalid_server_directory', 'NodePilot refused an invalid managed server directory.');
  }
  await ensureDirectory(serversDirectory);
  const resolvedServersDirectory = await realpath(serversDirectory);
  const candidate = path.resolve(resolvedServersDirectory, directory);
  if (!isInside(resolvedServersDirectory, candidate) || candidate === resolvedServersDirectory) {
    throw new AppError(500, 'unsafe_server_directory', 'NodePilot refused an unsafe managed server directory.');
  }
  try {
    await lstat(candidate);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (!create || nodeError.code !== 'ENOENT') {
      throw new AppError(404, 'server_directory_not_found', 'The server directory does not exist.');
    }
    await mkdir(candidate, { recursive: false });
  }
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AppError(500, 'unsafe_server_directory', 'NodePilot refused a linked or invalid managed server directory.');
  }
  const resolvedCandidate = await realpath(candidate);
  if (!isInside(resolvedServersDirectory, resolvedCandidate) || resolvedCandidate === resolvedServersDirectory) {
    throw new AppError(500, 'unsafe_server_directory', 'NodePilot refused an unsafe managed server directory.');
  }
  return resolvedCandidate;
}

export async function managedServerDirectoryExists(
  serversDirectory: string,
  directory: string,
): Promise<boolean> {
  try {
    await resolveManagedServerRoot(serversDirectory, directory, false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve user-controlled relative paths without permitting traversal or absolute paths.
 * The second realpath check also prevents an existing symlink from escaping the server root.
 */
export async function resolveInside(root: string, requestedPath = '', mustExist = true): Promise<string> {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new AppError(400, 'invalid_path', 'The supplied path is invalid.');
  }

  const normalizedInput = requestedPath.replace(/\\/g, '/');
  if (
    normalizedInput.startsWith('/') ||
    normalizedInput.startsWith('\\') ||
    /^[a-zA-Z]:/.test(normalizedInput) ||
    normalizedInput.split('/').some((part) => part === '..')
  ) {
    throw new AppError(400, 'invalid_path', 'Paths must stay inside the server directory.');
  }

  const resolvedRoot = await realpath(root);
  const candidate = path.resolve(resolvedRoot, normalizedInput || '.');
  if (!isInside(resolvedRoot, candidate)) {
    throw new AppError(400, 'invalid_path', 'Paths must stay inside the server directory.');
  }

  try {
    const resolvedCandidate = await realpath(candidate);
    if (!isInside(resolvedRoot, resolvedCandidate)) {
      throw new AppError(400, 'invalid_path', 'Paths must stay inside the server directory.');
    }
    return resolvedCandidate;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (mustExist) {
      throw new AppError(404, 'file_not_found', 'The requested file or directory does not exist.');
    }

    // The target is new. Its nearest existing parent must still be inside the root.
    let parent = path.dirname(candidate);
    while (parent !== path.dirname(parent)) {
      try {
        await access(parent);
        const resolvedParent = await realpath(parent);
        if (!isInside(resolvedRoot, resolvedParent)) {
          throw new AppError(400, 'invalid_path', 'Paths must stay inside the server directory.');
        }
        return candidate;
      } catch (parentError) {
        if (parentError instanceof AppError) throw parentError;
        parent = path.dirname(parent);
      }
    }
    throw new AppError(400, 'invalid_path', 'The supplied path is invalid.');
  }
}

export async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function safeDirectoryName(name: string, id: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'minecraft-server'}-${id.slice(0, 8)}`;
}
