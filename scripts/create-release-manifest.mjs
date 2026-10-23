#!/usr/bin/env node
import { lstat, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [directoryArgument, version] = process.argv.slice(2);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const protectedPathSegments = new Set(['.nodepilot', '.git', 'node_modules', '.env']);

if (!directoryArgument || !version || !versionPattern.test(version)) {
  console.error('Usage: node scripts/create-release-manifest.mjs <release-directory> <semver>');
  process.exit(2);
}

const root = path.resolve(directoryArgument);
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const pathSegments = relative.split('/');

    if (pathSegments.some((segment) => protectedPathSegments.has(segment.toLowerCase()))) {
      throw new Error('Release package contains protected path: ' + relative);
    }

    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error('Release package contains a symbolic link: ' + relative);
    }
    if (info.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!info.isFile()) {
      throw new Error('Release package contains an unsupported filesystem entry: ' + relative);
    }
    if (relative !== 'nodepilot-release.json') files.push(relative);
  }
}

try {
  await walk(root);
  files.sort((left, right) => left.localeCompare(right, 'en'));

  for (const required of [
    'package.json',
    'package-lock.json',
    'server/index.ts',
    'scripts/bootstrap.ps1',
    'scripts/bootstrap.sh',
    'scripts/apply-update.ps1',
    'scripts/apply-update.sh',
    'start.bat',
    'start.sh',
  ]) {
    if (!files.includes(required)) {
      throw new Error('Release package is missing required file: ' + required);
    }
  }

  await writeFile(
    path.join(root, 'nodepilot-release.json'),
    JSON.stringify({ schemaVersion: 1, version, files }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o644 },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to create release manifest.');
  process.exit(1);
}
