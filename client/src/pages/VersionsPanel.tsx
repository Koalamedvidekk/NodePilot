import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { api, ApiError } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { Server, ServerVersionStatus } from '../types';
import { errorMessage, formatDate, titleCase } from '../utils';

const MISSING_VERSIONS_API = 'The running NodePilot backend does not have the Versions API. Stop and restart NodePilot using start.bat (Windows) or ./start.sh (Linux), then choose Check for updates. If this continues, update or rebuild the backend and frontend together.';

function versionError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404 &&
    typeof cause.details === 'object' && cause.details !== null &&
    'error' in cause.details && cause.details.error === 'not_found') {
    return MISSING_VERSIONS_API;
  }
  return errorMessage(cause);
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function VersionsPanel({ server, onServerUpdated }: {
  server: Server;
  onServerUpdated: (updated: Server) => void;
}) {
  const [status, setStatus] = useState<ServerVersionStatus>();
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      const next = await api.serverVersions(server.id);
      setStatus(next);
      setError((current) => current === MISSING_VERSIONS_API ? undefined : current);
      setSelectedVersion((current) => !current || current === server.version ? next.currentVersion : current);
      if (next.currentVersion && next.currentVersion !== server.version) {
        onServerUpdated(await api.server(server.id));
      }
    } catch (cause) {
      setError(versionError(cause));
    } finally {
      setLoading(false);
    }
  }, [server.id, server.version, onServerUpdated]);

  useEffect(() => {
    setStatus(undefined);
    setSelectedVersion('');
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), installing || status?.busy ? 1_500 : 30_000);
    return () => window.clearInterval(timer);
  }, [load, installing, status?.busy]);

  const busy = installing || Boolean(status?.busy);
  const stopped = server.status === 'stopped';
  const currentVersion = status?.currentVersion ?? server.version ?? '';
  const changingVersion = Boolean(selectedVersion && selectedVersion !== currentVersion);
  const downgrade = changingVersion && compareVersions(selectedVersion, currentVersion) < 0;
  const canInstall = Boolean(status?.supported && stopped && !busy && changingVersion && server.directoryExists !== false);
  const versionOptions = useMemo(() => {
    const versions = (status?.versions ?? []).filter((version) => version.stable !== false && /^\d+(?:\.\d+)+$/.test(version.id));
    const values = [...new Set(versions.map((version) => version.id))];
    if (currentVersion && !values.includes(currentVersion)) values.push(currentVersion);
    return values.sort((a, b) => compareVersions(b, a)).map((version) => ({
      value: version,
      label: version + (version === currentVersion ? ' · Installed' : '') + (version === status?.latestVersion ? ' · Latest stable' : ''),
      description: versions.find((candidate) => candidate.id === version)?.releaseDate
        ? 'Released ' + formatDate(versions.find((candidate) => candidate.id === version)?.releaseDate)
        : undefined,
    }));
  }, [status?.versions, status?.latestVersion, currentVersion]);

  const checkVersions = async () => {
    setChecking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await api.checkServerVersions(server.id);
      setStatus(next);
      setSelectedVersion((current) => current || next.currentVersion);
      if (next.lastError) return;
      setNotice(next.latestVersion
        ? next.updateAvailable
          ? `Minecraft ${next.latestVersion} is available for this server.`
          : 'Version metadata was checked. This server has no newer stable Minecraft release available.'
        : 'Version metadata was checked, but no supported stable releases are currently available.');
    } catch (cause) {
      setError(versionError(cause));
    } finally {
      setChecking(false);
    }
  };

  const saveAutoUpdate = async (enabled: boolean) => {
    setSavingPreference(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setStatus(await api.setServerVersionPreferences(server.id, enabled));
      setNotice(enabled
        ? 'Automatic Minecraft updates enabled. Updates wait until this server is stopped and keep a full backup.'
        : 'Automatic Minecraft updates disabled. You can still change versions manually.');
    } catch (cause) {
      setError(versionError(cause));
    } finally {
      setSavingPreference(false);
    }
  };

  const installVersion = async (event: FormEvent) => {
    event.preventDefault();
    if (!canInstall) return;
    const action = downgrade ? 'Downgrade' : 'Change';
    if (!window.confirm(`${action} Minecraft from ${currentVersion} to ${selectedVersion}?\n\nNodePilot will back up the complete server before replacing its runtime. Minecraft can permanently upgrade world files when it next starts, and older versions may not be able to load newer worlds. Plugins and mods may need compatible versions. Keep the backup until you have verified the server.\n\nContinue?`)) return;
    setInstalling(true);
    setError(undefined);
    setNotice(undefined);
    // Start reading the real backend status during the long-running install request.
    void load();
    try {
      const result = await api.installServerVersion(server.id, selectedVersion);
      setStatus(result.status);
      setSelectedVersion(result.status.currentVersion);
      onServerUpdated(result.server);
      setNotice(`Minecraft ${result.status.currentVersion} is installed. The server remains stopped; review your add-ons before starting it.`);
    } catch (cause) {
      setError(versionError(cause));
      await load();
    } finally {
      setInstalling(false);
    }
  };

  if (loading && !status) return <section className="panel management-panel"><div className="management-loading"><span className="button-loader" /> Reading Minecraft version metadata…</div></section>;

  return (
    <section className="versions-panel">
      <div className="versions-heading">
        <div><p className="eyebrow">MINECRAFT RELEASES</p><h3>Versions</h3><p>Change this server’s Minecraft version using its existing {titleCase(status?.software ?? server.software ?? 'Minecraft')} software.</p></div>
        <button type="button" className="button button-secondary" onClick={() => void checkVersions()} disabled={checking || busy || status?.supported === false}>
          {checking ? <span className="button-loader" /> : <Icon name="refresh" size={16} />} {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><span>{error}</span></div>}
      {notice && <div className="inline-alert alert-info" role="status"><Icon name="info" size={18} /><span>{notice}</span></div>}
      {status?.lastError && status.lastError !== error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><span>{status.lastError}</span></div>}

      {status?.supported === false ? (
        <section className="panel versions-card"><h3>Version changes unavailable</h3><p>{status.unsupportedReason ?? 'NodePilot cannot install version changes for this server software.'}</p><p>Confirm the server software before enabling version management.</p></section>
      ) : (
        <>
          <div className="versions-summary-grid">
            <section className="panel versions-summary"><span>Installed version</span><strong>{currentVersion || 'Unknown'}</strong><small>{titleCase(status?.software ?? server.software)} · {stopped ? 'Server stopped' : 'Server ' + server.status}</small></section>
            <section className="panel versions-summary"><span>Latest stable version</span><strong>{status?.latestVersion ?? 'Not available'}</strong><small>{status?.latestVersion ? status.updateAvailable ? 'A newer Minecraft release is available' : 'No newer release detected' : 'Use Check for updates to refresh metadata'}</small></section>
            <section className="panel versions-summary"><span>Last metadata check</span><strong className="versions-check-time">{status?.lastCheckedAt ? formatDate(status.lastCheckedAt) : 'Not checked yet'}</strong><small>Publisher version metadata</small></section>
          </div>

          <section className="panel versions-card">
            <div className="panel-heading"><div><h3>Change Minecraft version</h3><p>The server software stays the same. Worlds, player data, settings, and add-ons are backed up before changing files.</p></div></div>
            {!stopped && <div className="inline-alert alert-info"><Icon name="info" size={18} /><span>Stop the server before changing its Minecraft version. Automatic updates also wait until it is stopped.</span></div>}
            {busy && <div className="versions-progress" role="status" aria-live="polite"><span className="button-loader" /><span>{status?.phase ? titleCase(status.phase.replaceAll('_', ' ')) : 'Preparing the version change…'}</span></div>}
            <form className="versions-install-form" onSubmit={(event) => void installVersion(event)}>
              <div className="form-field"><label className="field-label" htmlFor="minecraft-version-select">Minecraft version</label><CustomSelect id="minecraft-version-select" aria-label="Minecraft version" value={selectedVersion} onChange={setSelectedVersion} options={versionOptions} placeholder="Choose a stable release" disabled={!status?.supported || busy || checking || !stopped} /></div>
              <button type="submit" className="button button-primary" disabled={!canInstall}>{busy ? <span className="button-loader" /> : <Icon name="download" size={16} />}{busy ? 'Changing version…' : downgrade ? 'Back up & downgrade' : 'Back up & install'}</button>
            </form>
            {downgrade && <div className="inline-alert alert-warning"><Icon name="warning" size={18} /><span>This is a downgrade. A newer world may not open correctly in the selected Minecraft version. Restore a compatible world backup if needed.</span></div>}
            {(status?.warnings ?? []).map((warning) => <p className="versions-warning" key={warning}><Icon name="warning" size={15} /><span>{warning}</span></p>)}
          </section>

          <section className="panel versions-card">
            <div className="versions-auto-row"><div><h3>Automatic Minecraft updates</h3><p>Check for stable releases every hour while NodePilot is running. Install a newer version only after the server is stopped, with a full backup first.</p></div><label className="versions-auto-control"><input type="checkbox" role="switch" checked={Boolean(status?.autoUpdate)} disabled={!status?.supported || savingPreference || busy} onChange={(event) => void saveAutoUpdate(event.target.checked)} aria-label="Automatic Minecraft updates" /><span>{savingPreference ? 'Saving…' : status?.autoUpdate ? 'Enabled' : 'Disabled'}</span></label></div>
            <p className="input-note">Automatic updates use the same server software and never automatically downgrade. Java requirements and installed plugins or mods can block an automatic update until you resolve compatibility.</p>
            {status?.automaticUpdateBlockedReason && <div className="inline-alert alert-info"><Icon name="info" size={18} /><span>{status.automaticUpdateBlockedReason}</span></div>}
          </section>
        </>
      )}

      {status?.lastBackupPath && <section className="panel versions-card versions-backup"><div><Icon name="files" size={19} /><h3>Last version-change backup</h3></div><p>Keep this complete server backup until the updated world and add-ons have been verified.</p><code>{status.lastBackupPath}</code></section>}
    </section>
  );
}
