import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  UpdateService,
  extractExpectedSha256,
  isTrustedGitHubAssetUrl,
  normalizeGithubRepository,
  parseChangelog,
  safeArchiveRelativePath,
  selectReleaseAssets,
  type UpdateAssetCandidate,
} from '../services/update-service.js';
import type { UpdateReleaseInfo, UpdateStatusState } from '../types.js';

const hash = 'a'.repeat(64);
const archiveName = 'nodepilot-v1.2.3-universal.zip';

function asset(name: string, size = 4_096): UpdateAssetCandidate {
  return {
    name,
    apiUrl: 'https://api.github.com/repos/Koalamedvidekk/NodePilot/releases/assets/' + encodeURIComponent(name),
    browserDownloadUrl: 'https://github.com/Koalamedvidekk/NodePilot/releases/download/v1.2.3/' + encodeURIComponent(name),
    size,
    contentType: 'application/octet-stream',
  };
}

test('release asset selection accepts only the exact versioned universal ZIP', () => {
  const selected = selectReleaseAssets('1.2.3', [
    asset('source.zip'),
    asset('nodepilot-v1.2.2-universal.zip'),
    asset(archiveName),
    asset(archiveName + '.sha256', 72),
  ]);

  assert.equal(selected.packageAsset?.name, archiveName);
  assert.equal(selected.checksumAsset?.name, archiveName + '.sha256');
  assert.deepEqual(selectReleaseAssets('1.2.3', [asset('source.zip')]), {});
});

test('checksum parsing requires an archive-specific SHA-256 value', () => {
  assert.equal(extractExpectedSha256(hash + '  ' + archiveName, archiveName), hash);
  assert.equal(extractExpectedSha256(hash + ' *' + archiveName, archiveName), hash);
  assert.equal(extractExpectedSha256(archiveName + ': ' + hash, archiveName), hash);
  assert.equal(extractExpectedSha256(hash + '  other.zip', archiveName), null);
  assert.equal(extractExpectedSha256(hash, archiveName), null);
  assert.equal(extractExpectedSha256(hash, archiveName, true), hash);
});

test('archive paths reject traversal, platform paths, control characters and backslashes', () => {
  assert.equal(safeArchiveRelativePath('server/index.ts'), 'server/index.ts');
  assert.equal(safeArchiveRelativePath('release/server/index.ts'), 'release/server/index.ts');
  for (const unsafe of [
    '../package.json',
    'server/../../package.json',
    '/etc/passwd',
    'C:/Windows/System32',
    'server\\\\index.ts',
    'server/./index.ts',
    'server//index.ts',
    'server/\\u0000index.ts',
  ]) {
    assert.equal(safeArchiveRelativePath(unsafe), null, unsafe);
  }
});

test('GitHub release endpoints stay constrained to GitHub-owned HTTPS hosts', () => {
  assert.equal(normalizeGithubRepository('Koalamedvidekk/NodePilot'), 'Koalamedvidekk/NodePilot');
  assert.equal(normalizeGithubRepository('../NodePilot'), null);
  assert.equal(normalizeGithubRepository('owner/repo/extra'), null);
  assert.equal(isTrustedGitHubAssetUrl('https://api.github.com/repos/Koalamedvidekk/NodePilot/releases/assets/1'), true);
  assert.equal(isTrustedGitHubAssetUrl('https://release-assets.githubusercontent.com/asset'), true);
  assert.equal(isTrustedGitHubAssetUrl('http://github.com/Koalamedvidekk/NodePilot'), false);
  assert.equal(isTrustedGitHubAssetUrl('https://evil.example/asset'), false);
  assert.equal(isTrustedGitHubAssetUrl('https://token@api.github.com/asset'), false);
});

test('release notes are classified without exposing markup as executable content', () => {
  const notes = parseChangelog([
    '# Features',
    '- Add verified update packages',
    '# Fixes',
    '- Fix a release lookup edge case',
    '# Improvements',
    '- Improve startup reporting',
  ].join('\n'));

  assert.deepEqual(notes.features, ['Add verified update packages']);
  assert.deepEqual(notes.bugFixes, ['Fix a release lookup edge case']);
  assert.deepEqual(notes.improvements, ['Improve startup reporting']);
});

test('overlapping update checks share one in-flight GitHub request', async () => {
  let allowResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => { allowResponse = resolve; });
  let fetchCalls = 0;
  const hostSettings = {
    getSettings: () => ({
      systemStartupEnabled: false,
      launchMode: 'headless' as const,
      openBrowserOnStartup: false,
      continueRunningOnClose: true,
      updateIncludePrereleases: false,
      updateDismissedVersion: null,
      updateLastCheckedAt: null,
    }),
    saveSettings: () => undefined,
  };
  const service = new UpdateService(
    path.join(os.tmpdir(), 'nodepilot-update-service-test-data'),
    path.join(os.tmpdir(), 'nodepilot-update-service-test-app'),
    hostSettings as never,
    { list: () => [] } as never,
  );
  (service as unknown as { fetchWithTimeout: () => Promise<Response> }).fetchWithTimeout = async () => {
    fetchCalls += 1;
    await responseGate;
    return new Response('[]', { status: 200 });
  };

  const first = service.checkForUpdates(true);
  const second = service.checkForUpdates(true);
  assert.equal(fetchCalls, 1);
  allowResponse?.();

  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(fetchCalls, 1);
  assert.equal(firstStatus.status, 'idle');
  assert.equal(secondStatus.status, 'idle');
});

test('snoozing an update persists a 24-hour reminder for that exact release only', () => {
  const settings = {
    systemStartupEnabled: false,
    launchMode: 'headless' as const,
    openBrowserOnStartup: false,
    continueRunningOnClose: true,
    updateIncludePrereleases: false,
    updateDismissedVersion: null as string | null,
    updateSnoozedVersion: null as string | null,
    updateSnoozedUntil: null as string | null,
    updateLastCheckedAt: null as string | null,
  };
  const hostSettings = {
    getSettings: () => ({ ...settings }),
    saveSettings: (input: Partial<typeof settings>) => Object.assign(settings, input),
  };
  const service = new UpdateService(
    path.join(os.tmpdir(), 'nodepilot-update-snooze-test-data'),
    path.join(os.tmpdir(), 'nodepilot-update-snooze-test-app'),
    hostSettings as never,
    { list: () => [] } as never,
  );
  const state = (service as unknown as { statusState: UpdateStatusState }).statusState;
  const release: UpdateReleaseInfo = {
    version: '1.2.3',
    rawTag: 'v1.2.3',
    name: 'NodePilot v1.2.3',
    publishedAt: '2026-10-23T00:00:00.000Z',
    isPrerelease: false,
    htmlUrl: 'https://github.com/Koalamedvidekk/NodePilot/releases/tag/v1.2.3',
    body: '',
    changelog: { features: [], improvements: [], bugFixes: [], rawNotes: '' },
  };
  state.availableRelease = release;
  state.isUpdateAvailable = true;

  const startedAt = Date.now();
  service.snoozeAvailableRelease();
  const status = service.getStatus();

  assert.equal(status.snoozedVersion, '1.2.3');
  assert.equal(settings.updateSnoozedVersion, '1.2.3');
  assert.ok(status.snoozedUntil);
  const snoozedUntil = Date.parse(status.snoozedUntil ?? '');
  assert.ok(snoozedUntil >= startedAt + (23 * 60 * 60 * 1_000));
  assert.ok(snoozedUntil <= startedAt + (25 * 60 * 60 * 1_000));
});
