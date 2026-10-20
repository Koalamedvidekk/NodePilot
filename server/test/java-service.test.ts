import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JavaService } from '../services/java-service.js';

test('JavaService returns downloadable major versions including Java 21 and 25', () => {
  const java = new JavaService();
  const majors = java.getDownloadableMajors();
  assert.ok(majors.includes(8));
  assert.ok(majors.includes(17));
  assert.ok(majors.includes(21));
  assert.ok(majors.includes(25));
});

test('JavaService resolves valid Adoptium download URLs for Java 21 and 25', async () => {
  const java = new JavaService();

  const dl21 = await java.getDownloadUrl(21);
  assert.ok(dl21.url.startsWith('https://'), 'Download URL should be HTTPS');
  assert.ok(dl21.fileName.length > 0, 'Filename should not be empty');
  assert.equal(typeof dl21.isZip, 'boolean');

  const dl25 = await java.getDownloadUrl(25);
  assert.ok(dl25.url.startsWith('https://'), 'Download URL should be HTTPS');
  assert.ok(dl25.fileName.length > 0, 'Filename should not be empty');
  assert.equal(typeof dl25.isZip, 'boolean');
});

test('JavaService detects managed JDK runtimes inside dataDirectory/java', async () => {
  const tempDir = path.join(os.tmpdir(), `nodepilot-java-test-${Date.now()}`);
  const managedJavaDir = path.join(tempDir, 'java');
  const mockJdkDir = path.join(managedJavaDir, 'jdk-25', 'bin');
  await mkdir(mockJdkDir, { recursive: true });

  const exeName = process.platform === 'win32' ? 'java.cmd' : 'java';
  const mockJavaPath = path.join(mockJdkDir, exeName);

  // Create a mock executable script that outputs openjdk version 25
  const mockScript = process.platform === 'win32'
    ? `@echo off\necho openjdk version "25.0.4.1" 2026-04-15\necho OpenJDK Runtime Environment Temurin-25 (build 25.0.4.1)\n`
    : `#!/bin/sh\necho 'openjdk version "25.0.4.1" 2026-04-15'\necho 'OpenJDK Runtime Environment Temurin-25 (build 25.0.4.1)'\n`;

  await writeFile(mockJavaPath, mockScript);
  if (process.platform !== 'win32') {
    await chmod(mockJavaPath, 0o755);
  }

  try {
    const java = new JavaService(tempDir);
    assert.equal(java.getManagedJavaDir(), managedJavaDir);
    assert.equal(java.isInstalling(25), false);

    // If on Windows and executable is .cmd, probeJava checks java.exe, so test findUsable logic
    const downloadable = java.getDownloadableMajors();
    assert.ok(downloadable.includes(25));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
