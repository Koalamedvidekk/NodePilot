import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';
import { beginUpdateRecovery } from '../update-recovery';
import type { UpdateStatusState } from '../types';
import { errorMessage, formatDate } from '../utils';
import { Icon } from './Icon';

const UPDATE_POLL_INTERVAL_MS = 15_000;
const activeServerStatuses = new Set(['starting', 'running', 'stopping']);
const updateInProgressStatuses = new Set([
  'checking',
  'downloading',
  'verifying',
  'extracting',
  'backing_up',
  'installing',
  'ready_to_restart',
  'restarting',
]);

function reminderIsSnoozed(update: UpdateStatusState): boolean {
  const release = update.availableRelease;
  if (!release || update.snoozedVersion !== release.version || !update.snoozedUntil) return false;

  const snoozedUntil = Date.parse(update.snoozedUntil);
  return Number.isFinite(snoozedUntil) && snoozedUntil > Date.now();
}

/**
 * A small global prompt rather than a toast: an application update may restart
 * NodePilot, so the user should make a deliberate choice before it starts.
 */
export function UpdateNotification() {
  const [update, setUpdate] = useState<UpdateStatusState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.getUpdateStatus();
      setUpdate(next);
      if (next.status === 'error') setInstalling(false);
    } catch {
      // The host may still be starting, or may require an access PIN. The next
      // poll after it is ready/authenticated will show any available update.
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), UPDATE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const release = update?.availableRelease ?? null;
  const shouldShow = Boolean(update?.isUpdateAvailable && release && !reminderIsSnoozed(update));
  const updateInProgress = installing || Boolean(update && updateInProgressStatuses.has(update.status));

  const handleLater = async () => {
    setSnoozing(true);
    setActionError(null);
    try {
      setUpdate(await api.snoozeAvailableUpdate());
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSnoozing(false);
    }
  };

  const handleDownloadNow = async () => {
    if (!update || !release) return;

    setActionError(null);
    if (!update.canAutoInstall) {
      const releaseWindow = window.open(release.htmlUrl, '_blank', 'noopener,noreferrer');
      if (!releaseWindow) {
        setActionError('Your browser blocked the official release page. Allow pop-ups for NodePilot and try again.');
      }
      return;
    }

    try {
      const activeServers = (await api.servers()).filter((server) => activeServerStatuses.has(server.status));
      if (activeServers.length > 0) {
        setActionError(
          `Stop ${activeServers.length === 1 ? 'the active server' : 'all active servers'} before updating. NodePilot will not restart while a managed game server is active.`,
        );
        return;
      }

      if (!window.confirm(`Download, verify, and install NodePilot v${release.version}? NodePilot will restart after the update is staged.`)) {
        return;
      }

      setInstalling(true);
      const result = await api.installUpdate();
      setUpdate(result.update);
      beginUpdateRecovery(result.update.availableRelease?.version ?? release.version);
    } catch (error) {
      setInstalling(false);
      setActionError(errorMessage(error));
    }
  };

  if (!shouldShow || !release || !update) return null;

  const installDescription = update.canAutoInstall
    ? 'Download now verifies the signed release package checksum, then restarts NodePilot after it is safely staged.'
    : (update.autoInstallReason ?? 'Download now opens the official GitHub release page for this installation.');

  return (
    <div className="update-notification-backdrop" role="presentation">
      <section
        className="update-notification"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-notification-title"
        aria-describedby="update-notification-description"
      >
        <div className="update-notification-header">
          <span className="update-notification-icon"><Icon name="download" size={22} /></span>
          <div>
            <span className="eyebrow">NODEPILOT UPDATE AVAILABLE</span>
            <h2 id="update-notification-title">Version {release.version} is ready</h2>
          </div>
        </div>

        <p id="update-notification-description" className="update-notification-copy">
          {installDescription}
        </p>

        <div className="update-notification-release">
          <div>
            <strong>{release.name}</strong>
            <span>Published {formatDate(release.publishedAt)}</span>
          </div>
          <a href={release.htmlUrl} target="_blank" rel="noopener noreferrer" className="text-link">
            Notes <Icon name="arrowUpRight" size={14} />
          </a>
        </div>

        {updateInProgress && (
          <div className="update-notification-progress" role="status" aria-live="polite">
            <span className="button-loader" />
            <span>{update.statusMessage ?? 'Preparing the verified update…'}</span>
          </div>
        )}

        {actionError && (
          <div className="inline-alert alert-error update-notification-error" role="alert">
            <Icon name="warning" size={16} />
            <span>{actionError}</span>
          </div>
        )}

        <div className="update-notification-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void handleLater()}
            disabled={snoozing || updateInProgress}
          >
            {snoozing ? 'Saving…' : 'Later'}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleDownloadNow()}
            disabled={snoozing || updateInProgress}
          >
            {updateInProgress ? <span className="button-loader" /> : <Icon name="download" size={16} />}
            {updateInProgress ? 'Preparing update…' : 'Download now'}
          </button>
        </div>

        <p className="update-notification-later">Later hides this reminder for 24 hours. You can still update from Host Settings.</p>
      </section>
    </div>
  );
}
