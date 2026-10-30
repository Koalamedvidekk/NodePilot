import { useCallback, useEffect, useState } from 'react';
import { api, PANEL_AUTH_CHANGED_EVENT, PANEL_AUTH_REQUIRED_EVENT } from '../api';
import { Icon } from '../components/Icon';
import { CustomSelect } from '../components/CustomSelect';
import { openPlayitClaim } from '../playit-link';
import { beginUpdateRecovery } from '../update-recovery';
import type { HostDiagnostics, HostSettings, HostStartupStatus, PlayitStatus, Server, TorStatus, UpdateStatusState } from '../types';

export function HostSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [startup, setStartup] = useState<HostStartupStatus | null>(null);
  const [playit, setPlayit] = useState<PlayitStatus | null>(null);
  const [tor, setTor] = useState<TorStatus | null>(null);
  const [pinConfigured, setPinConfigured] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [diagnostics, setDiagnostics] = useState<HostDiagnostics | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusState | null>(null);

  const [togglingServer, setTogglingServer] = useState<string | null>(null);
  const [togglingPlayit, setTogglingPlayit] = useState(false);
  const [togglingTor, setTogglingTor] = useState(false);
  const [installingTor, setInstallingTor] = useState(false);
  const [resettingTor, setResettingTor] = useState(false);
  const [updatingNodePilot, setUpdatingNodePilot] = useState(false);
  const [installingPlayit, setInstallingPlayit] = useState(false);
  const [claimingPlayit, setClaimingPlayit] = useState(false);
  const [playitClaimError, setPlayitClaimError] = useState<string | null>(null);
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [claimCopied, setClaimCopied] = useState(false);
  const [manualSecretKey, setManualSecretKey] = useState('');
  const [savingSecretKey, setSavingSecretKey] = useState(false);
  const [showManualKeyInput, setShowManualKeyInput] = useState(false);
  const [resettingPlayit, setResettingPlayit] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [hostData, serverList, diag, updates] = await Promise.all([
        api.getHostSettings(),
        api.servers(),
        api.getHostDiagnostics().catch(() => null),
        api.getUpdateStatus().catch(() => null),
      ]);
      setSettings(hostData.settings);
      setStartup(hostData.startup);
      setPlayit(hostData.playit);
      setTor(hostData.tor);
      setPinConfigured(hostData.pinConfigured);
      setServers(serverList);
      setDiagnostics(diag);
      setUpdateStatus(updates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load host configuration.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // A protected page can mount just before the PIN dialog is completed. Reload
  // its real status as soon as that dialog stores the verified credential.
  useEffect(() => {
    const refreshAfterAuthentication = () => void loadData();
    window.addEventListener(PANEL_AUTH_CHANGED_EVENT, refreshAfterAuthentication);
    return () => window.removeEventListener(PANEL_AUTH_CHANGED_EVENT, refreshAfterAuthentication);
  }, [loadData]);

  // A check or download can take long enough that a one-shot API response would
  // leave the user looking at stale information. Poll the real status only while
  // an update action is underway; normal page loading remains request-light.
  useEffect(() => {
    if (!updatingNodePilot) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api.getUpdateStatus();
        if (!active) return;
        setUpdateStatus(next);
        if (next.status === 'error') {
          setError(next.checkError ?? next.error ?? next.statusMessage ?? 'NodePilot update failed.');
          setUpdatingNodePilot(false);
        }
      } catch {
        // A brief request loss is expected while a successful update restarts the app.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [updatingNodePilot]);

  // A Tor bundle download or Tor network bootstrap can both take a moment. Keep
  // the status current while either operation is underway.
  useEffect(() => {
    if (!installingTor && !tor?.isInstalling && (!tor?.isRunning || tor.isReady)) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api.getTorStatus();
        if (!active) return;
        setTor(next.tor);
        setPinConfigured(next.pinConfigured);
      } catch {
        // The local process may be stopping; the manual Refresh button remains available.
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [installingTor, tor?.isInstalling, tor?.isReady, tor?.isRunning]);

  // Auto-detect when the user finishes claiming their agent on playit.gg
  useEffect(() => {
    const activeClaim = claimUrl || playit?.claimUrl;
    if (!activeClaim || playit?.secretExists) return undefined;

    let active = true;
    const interval = window.setInterval(async () => {
      try {
        const next = await api.getPlayitStatus();
        if (!active) return;
        if (next.secretExists) {
          setPlayit(next);
          setClaimUrl(null);
          setSuccessMessage('🎉 Playit.gg account successfully linked! Tunnels will now establish automatically.');
        }
      } catch {
        // Silently continue polling
      }
    }, 2_500);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [claimUrl, playit?.claimUrl, playit?.secretExists]);

  const handleToggleStartup = async () => {
    if (!settings || !startup) return;
    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      if (startup.registeredInOs) {
        const res = await api.disableHostStartup();
        setStartup(res.startup);
        setSettings(res.settings);
        setSuccessMessage('Automatic system startup integration has been cleanly removed.');
      } else {
        const res = await api.enableHostStartup({
          launchMode: settings.launchMode,
          openBrowserOnStartup: settings.openBrowserOnStartup,
        });
        setStartup(res.startup);
        setSettings(res.settings);
        setSuccessMessage('Automatic system startup enabled successfully.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to modify system startup.');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateOptions = async (updated: Partial<HostSettings>) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await api.updateHostSettings(updated);
      setSettings(res.settings);
      setStartup(res.startup);

      // If startup is currently active, re-sync OS entry to reflect window/browser choice
      if (res.startup.registeredInOs) {
        const syncRes = await api.enableHostStartup({
          launchMode: res.settings.launchMode,
          openBrowserOnStartup: res.settings.openBrowserOnStartup,
        });
        setStartup(syncRes.startup);
      }
      setSuccessMessage('Host settings saved successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save host settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleServerAutoStart = async (server: Server) => {
    setTogglingServer(server.id);
    setError(null);
    const nextMode = server.autoStart === 'always' ? 'disabled' : 'always';

    try {
      const res = await api.setServerAutoStart(server.id, nextMode);
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, autoStart: res.server.autoStart } : s)),
      );
      setSuccessMessage(`Auto-start for "${server.name}" set to ${nextMode === 'always' ? 'Always Start' : 'Leave Stopped'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update server auto-start.');
    } finally {
      setTogglingServer(null);
    }
  };


  const handleInstallPlayit = async () => {
    setInstallingPlayit(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api.installPlayit();
      setPlayit(res.playit);
      setSuccessMessage('Playit.gg agent successfully downloaded and ready to use!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install Playit agent.');
    } finally {
      setInstallingPlayit(false);
    }
  };

  const handleClaimPlayit = async () => {
    setClaimingPlayit(true);
    setPlayitClaimError(null);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await api.claimPlayitAccount();
      setClaimUrl(res.claimUrl);
      setPlayit(res.playit);
      setSuccessMessage('Opening Playit to finish linking. Return to NodePilot afterwards.');
      openPlayitClaim(res.claimUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate claim link.';
      setError(message);
      setPlayitClaimError(message);
    } finally {
      setClaimingPlayit(false);
    }
  };

  const handleSaveSecretKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualSecretKey.trim()) return;
    setSavingSecretKey(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api.setPlayitSecret(manualSecretKey.trim());
      setPlayit(res.playit);
      setManualSecretKey('');
      setShowManualKeyInput(false);
      setSuccessMessage('Playit secret key saved and tunnel agent launched!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Playit secret key.');
    } finally {
      setSavingSecretKey(false);
    }
  };

  const handleResetPlayit = async () => {
    if (!window.confirm('Are you sure you want to unlink and reset your Playit credentials on this host?')) {
      return;
    }
    setResettingPlayit(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api.resetPlayit();
      setPlayit(res.playit);
      setClaimUrl(null);
      setSuccessMessage('Playit credentials removed. You can link a new account or paste an existing secret key.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset Playit credentials.');
    } finally {
      setResettingPlayit(false);
    }
  };

  const handlePlayitToggle = async () => {
    if (!playit) return;
    setTogglingPlayit(true);
    setError(null);
    try {
      if (playit.isRunning) {
        const res = await api.stopPlayit();
        setPlayit(res.playit);
        setSuccessMessage('Playit agent stopped.');
      } else {
        const res = await api.startPlayit();
        setPlayit(res.playit);
        setSuccessMessage('Playit agent launched successfully.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Playit operation failed.');
    } finally {
      setTogglingPlayit(false);
    }
  };

  const handleTorToggle = async () => {
    if (!tor) return;
    setTogglingTor(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = tor.isRunning ? await api.stopTor() : await api.startTor();
      setTor(result.tor);
      setPinConfigured(result.pinConfigured);
      setSuccessMessage(tor.isRunning
        ? 'Private remote access is disabled. Your Onion address is no longer reachable.'
        : 'Private remote access is starting. Your persistent Onion address will appear when Tor is ready.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Private remote access could not be changed.');
    } finally {
      setTogglingTor(false);
    }
  };

  const handleResetTorAddress = async () => {
    if (!window.confirm('Reset this Onion address? The old address will stop working permanently.')) return;
    setResettingTor(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await api.resetTorAddress();
      setTor(result.tor);
      setPinConfigured(result.pinConfigured);
      setSuccessMessage(result.tor.isRunning
        ? 'A new private Onion address is being created.'
        : 'The saved Onion address was removed. Enable private remote access to create a new one.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Onion address could not be reset.');
    } finally {
      setResettingTor(false);
    }
  };

  const handleInstallTor = async () => {
    if (!tor) return;
    setInstallingTor(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const installed = await api.installTor();
      setTor(installed.tor);
      setPinConfigured(installed.pinConfigured);

      if (installed.pinConfigured) {
        const started = await api.startTor();
        setTor(started.tor);
        setPinConfigured(started.pinConfigured);
        setSuccessMessage('Tor was installed and private remote access is starting. Your Onion address will appear when Tor is ready.');
      } else {
        setSuccessMessage('Tor was installed. Set a strong panel PIN, then enable private remote access.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tor could not be installed.');
    } finally {
      setInstallingTor(false);
    }
  };

  const openPanelUnlock = () => window.dispatchEvent(new Event(PANEL_AUTH_REQUIRED_EVENT));

  const copyTorAddress = async () => {
    if (!tor?.onionAddress) return;
    try {
      await navigator.clipboard.writeText(`http://${tor.onionAddress}`);
      setSuccessMessage('Private access address copied to your clipboard. Open it in Tor Browser.');
    } catch {
      setError('Could not copy the address. Select it manually instead.');
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdatingNodePilot(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const next = await api.checkForUpdates();
      setUpdateStatus(next);
      const updateError = next.checkError ?? next.error;
      if (next.status === 'error' || updateError) {
        setError(updateError ?? 'Unable to check for NodePilot updates.');
      } else {
        setSuccessMessage(next.statusMessage ?? 'Update check completed.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to check for NodePilot updates.');
    } finally {
      setUpdatingNodePilot(false);
    }
  };

  const handlePrereleasePreference = async (includePrereleases: boolean) => {
    setUpdatingNodePilot(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const next = await api.setUpdatePreferences(includePrereleases);
      setUpdateStatus(next);
      setSettings((current) => current ? { ...current, updateIncludePrereleases: includePrereleases } : current);
      const updateError = next.checkError ?? next.error;
      if (next.status === 'error' || updateError) {
        setError(updateError ?? 'Unable to check for NodePilot updates.');
      } else {
        setSuccessMessage(includePrereleases ? 'Preview releases are now included in update checks.' : 'Update checks now use stable releases only.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to change update preferences.');
    } finally {
      setUpdatingNodePilot(false);
    }
  };

  const handleDismissUpdate = async () => {
    if (!window.confirm('Hide this update until a newer NodePilot release is published?')) return;
    setUpdatingNodePilot(true);
    setError(null);
    try {
      const next = await api.dismissAvailableUpdate();
      setUpdateStatus(next);
      setSuccessMessage('The update was dismissed. You can still check again at any time.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to dismiss the update.');
    } finally {
      setUpdatingNodePilot(false);
    }
  };

  const handleInstallUpdate = async () => {
    const active = servers.filter((server) => ['running', 'starting', 'stopping'].includes(server.status));
    if (active.length > 0) {
      setError('Stop all managed game servers before updating NodePilot.');
      return;
    }
    if (!window.confirm('NodePilot will build the verified release and restart. Continue?')) return;

    setUpdatingNodePilot(true);
    setError(null);
    try {
      const result = await api.installUpdate();
      setUpdateStatus(result.update);
      setSuccessMessage(result.message);
      const expectedVersion = result.update.availableRelease?.version ?? updateStatus?.availableRelease?.version;
      if (expectedVersion) beginUpdateRecovery(expectedVersion);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to prepare the NodePilot update.');
      setUpdatingNodePilot(false);
    }
  };

  if (loading) {
    return (
      <div className="empty-panel">
        <p>Reading host configuration and OS startup entries...</p>
      </div>
    );
  }

  return (
    <div className="host-settings-page">
      <div className="page-header">
        <div>
          <h2>Host Settings & System Startup</h2>
          <p className="page-caption">
            Manage NodePilot's background service on this computer, configure boot behavior, and automate Minecraft server startup.
          </p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void loadData()}
          disabled={saving}
        >
          <Icon name="refresh" size={16} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div className="notice-banner is-error">
          <Icon name="warning" size={18} />
          <span>{error}</span>
        </div>
      )}

      {successMessage && (
        <div className="notice-banner is-success">
          <Icon name="check" size={18} />
          <span>{successMessage}</span>
        </div>
      )}

      <div className="host-settings-grid">
        {/* Section 1: System Startup */}
        <section className="settings-section-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="settings" size={20} />
              <div>
                <h3>System Startup (Boot & Login)</h3>
                <p>Run NodePilot automatically when the host computer powers on or logs in.</p>
              </div>
            </div>
            <div className="section-header-action">
              <span className={`status-pill ${startup?.registeredInOs ? 'is-online' : 'is-offline'}`}>
                {startup?.registeredInOs ? 'Active in OS' : 'Disabled'}
              </span>
            </div>
          </div>

          <div className="section-card-body">
            <div className="setting-row">
              <div className="setting-info">
                <strong>Start NodePilot on System Boot / Login</strong>
                <p>
                  {startup?.platform === 'win32'
                    ? 'Configured cleanly via your Windows Startup profile without needing Administrator rights.'
                    : startup?.platform === 'linux'
                    ? 'Registered via user systemd service (~/.config/systemd/user/nodepilot.service).'
                    : 'System startup integration on your platform.'}
                </p>
                <small className="setting-explanation">{startup?.permissionsExplanation}</small>
              </div>
              <div className="setting-action">
                <button
                  type="button"
                  className={`button ${startup?.registeredInOs ? 'button-danger' : 'button-primary'}`}
                  onClick={() => void handleToggleStartup()}
                  disabled={saving || !startup?.isSupported}
                >
                  {saving
                    ? 'Updating...'
                    : startup?.registeredInOs
                    ? 'Disable Startup'
                    : 'Enable Startup'}
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <strong>Launch Mode</strong>
                <p>Choose whether NodePilot starts silently in the background or with an open console window.</p>
              </div>
              <div className="setting-action" style={{ minWidth: '300px' }}>
                <CustomSelect
                  value={settings?.launchMode ?? 'headless'}
                  onChange={(val) => void handleUpdateOptions({ launchMode: val as 'headless' | 'windowed' })}
                  disabled={saving}
                  options={[
                    { value: 'headless', label: 'Headless (Background, No Window)', description: 'Runs quietly in background' },
                    { value: 'windowed', label: 'Windowed (Interactive Terminal)', description: 'Opens terminal window on launch' },
                  ]}
                  aria-label="NodePilot launch mode"
                />
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <strong>Open Browser on Startup</strong>
                <p>Automatically open your default browser to the NodePilot web UI when your computer boots.</p>
              </div>
              <div className="setting-action">
                <label className="switch-label">
                  <input
                    type="checkbox"
                    checked={settings?.openBrowserOnStartup ?? false}
                    onChange={(e) => void handleUpdateOptions({ openBrowserOnStartup: e.target.checked })}
                    disabled={saving}
                  />
                  <span>{settings?.openBrowserOnStartup ? 'Enabled' : 'Disabled'}</span>
                </label>
              </div>
            </div>

            <div className="setting-detail-box">
              <strong>OS Registration Reality:</strong>
              <p>{startup?.registrationDetails}</p>
              {startup?.serviceFile && (
                <code>{startup.serviceFile}</code>
              )}
            </div>
          </div>
        </section>

        {/* Section 2: Server Startup */}
        <section className="settings-section-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="server" size={20} />
              <div>
                <h3>Server Auto-Start (Per-Server)</h3>
                <p>Choose which Minecraft servers should automatically launch when NodePilot starts.</p>
              </div>
            </div>
          </div>

          <div className="section-card-body">
            <p className="card-hint">
              Servers marked <strong>Always Start</strong> will boot exactly once with NodePilot. Unmarked servers remain safely stopped until you manually start them.
            </p>

            {servers.length === 0 ? (
              <div className="empty-panel">
                <p>No Minecraft servers have been created yet.</p>
              </div>
            ) : (
              <div className="servers-autostart-list">
                {servers.map((server) => {
                  const isAlways = server.autoStart === 'always';
                  const isToggling = togglingServer === server.id;

                  return (
                    <div key={server.id} className="autostart-server-row">
                      <div className="autostart-server-info">
                        <strong>{server.name}</strong>
                        <div className="server-subline">
                          <span>Port {server.port ?? 25565}</span>
                          <span>•</span>
                          <span>{server.software ?? server.distribution ?? 'vanilla'} {server.version}</span>
                          <span>•</span>
                          <span className={`status-badge is-${server.status}`}>{server.status}</span>
                        </div>
                      </div>

                      <div className="autostart-server-action">
                        <button
                          type="button"
                          className={`button button-small ${isAlways ? 'button-primary' : 'button-secondary'}`}
                          onClick={() => void handleToggleServerAutoStart(server)}
                          disabled={isToggling}
                        >
                          {isToggling
                            ? 'Saving...'
                            : isAlways
                            ? 'Always Start'
                            : 'Leave Stopped'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Section 3: Private Remote Access */}
        <section className="settings-section-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="lock" size={20} />
              <div>
                <h3>Private Remote Access (Tor)</h3>
                <p>Reach this NodePilot panel privately from anywhere without port forwarding, accounts, or a paid relay.</p>
              </div>
            </div>
            <div className="section-header-action">
              <span className={`status-pill ${tor?.isReady ? 'is-online' : 'is-offline'}`}>
                {!tor ? 'Status Unavailable' : !tor.supported ? 'Unsupported' : tor.isReady ? 'Private Address Ready' : tor.isRunning ? 'Starting Tor' : tor.enabled ? 'Restore Needed' : 'Disabled'}
              </span>
            </div>
          </div>

          <div className="section-card-body">
            <div className="setting-row">
              <div className="setting-info">
                <strong>Onion Service</strong>
                <p>
                  NodePilot runs a local Tor process that forwards one private Onion address to this panel only. It does not open your router, create an account, or expose a Tor SOCKS proxy.
                </p>
                {!tor ? (
                  <small className="setting-explanation">Unlock the panel with its existing access PIN, then use Refresh to load private-access status.</small>
                ) : !tor.supported ? (
                  <small className="setting-explanation">Private remote access is currently available on Windows and Linux.</small>
                ) : (
                  <div className="tor-install-help">
                    {!tor?.installed ? (
                      <small className="setting-explanation">
                        NodePilot can download, verify, and install the small official Tor runtime for this panel. It does not install a browser or expose a SOCKS proxy.
                      </small>
                    ) : (
                      <small className="setting-explanation">Tor {tor.version ?? 'installed'} detected locally. {tor.binaryPath && <code>{tor.binaryPath}</code>}</small>
                    )}
                    <div className="tor-download-actions" aria-label="Tor Browser download">
                      <a
                        className="button button-secondary button-small"
                        href="https://download.torproject.org/tor-browser-for-desktop/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon name="download" size={15} />
                        <span>Download Tor Browser</span>
                        <Icon name="arrowUpRight" size={14} />
                      </a>
                    </div>
                  </div>
                )}
              </div>
              <div className="setting-action">
                {!tor ? (
                  <button type="button" className="button button-primary" onClick={openPanelUnlock}>
                    <Icon name="lock" size={16} />
                    <span>Unlock panel</span>
                  </button>
                ) : !tor.installed ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => void handleInstallTor()}
                    disabled={installingTor || Boolean(tor?.isInstalling) || !tor?.supported || !tor?.autoInstallSupported}
                    title={!tor?.autoInstallSupported ? 'One-click Tor installation is currently supported on Windows and Linux x64 hosts.' : ''}
                  >
                    <Icon name="download" size={16} />
                    <span>
                      {installingTor || tor?.isInstalling
                        ? (tor?.installStage === 'resolving' ? 'Finding Tor...' : tor?.installStage === 'verifying' ? 'Verifying Tor...' : tor?.installStage === 'installing' ? 'Installing Tor...' : 'Downloading Tor...')
                        : 'Install Tor (1-Click)'}
                    </span>
                  </button>
                ) : (
                  <button
                  type="button"
                  className={`button ${tor?.isRunning ? 'button-danger' : 'button-primary'}`}
                  onClick={() => void handleTorToggle()}
                  disabled={togglingTor || !tor?.supported || (!tor?.isRunning && !pinConfigured)}
                  title={!pinConfigured && !tor?.isRunning ? 'Set a panel access PIN in Network & Remote Access before enabling Tor.' : ''}
                >
                  {togglingTor ? 'Working...' : tor?.isRunning ? 'Disable Private Access' : 'Enable Private Access'}
                </button>
                )}
              </div>
            </div>

            {!tor ? (
              <div className="setting-detail-box" style={{ borderColor: 'var(--warning, #f59e0b)' }}>
                <strong>Panel unlock required</strong>
                <p>NodePilot could not read private-access status yet. Enter your existing panel PIN in the unlock dialog, then refresh this page.</p>
              </div>
            ) : !pinConfigured && (
              <div className="setting-detail-box" style={{ borderColor: 'var(--warning, #f59e0b)' }}>
                <strong>Access PIN required</strong>
                <p>Before enabling this feature, set a panel PIN of at least 4 characters in <strong>Network &amp; Remote Access</strong> from the sidebar. NodePilot blocks Tor activation without it and will not let you remove it while private access is active.</p>
              </div>
            )}

            {tor?.onionAddress && (
              <div className="setting-detail-box" style={{ borderColor: tor.isReady ? 'var(--cyan)' : undefined }}>
                <strong>{tor.isReady ? 'Your private access address' : 'Saved private access address'}</strong>
                <p>{tor.isReady ? 'Open this URL in Tor Browser, then enter your NodePilot access PIN.' : 'This address is persistent, but it is reachable only while private access is enabled and Tor has finished starting.'}</p>
                <div className="tor-address-row">
                  <code>http://{tor.onionAddress}</code>
                  <button type="button" className="button button-secondary button-small" onClick={() => void copyTorAddress()}>
                    <Icon name="copy" size={15} />
                    <span>Copy</span>
                  </button>
                  <button type="button" className="button button-danger button-small" onClick={() => void handleResetTorAddress()} disabled={resettingTor}>
                    <Icon name="refresh" size={15} />
                    <span>{resettingTor ? 'Resetting...' : 'Reset Address'}</span>
                  </button>
                </div>
              </div>
            )}

            {tor?.error && (
              <div className="setting-detail-box" style={{ borderColor: 'var(--danger, #ef4444)' }}>
                <strong>Tor status</strong>
                <p>{tor.error}</p>
              </div>
            )}

            <div className="setting-detail-box">
              <strong>Important:</strong>
              <p>Use Tor Browser for this address. It is designed for private panel access, not high-speed game traffic. Your NodePilot data and servers stay on this computer; the Onion key is kept in NodePilot&apos;s local data folder so the address survives restarts and updates.</p>
            </div>
          </div>
        </section>

        {/* Section 4: Playit.gg Coordination */}
        <section className="settings-section-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="wifi" size={20} />
              <div>
                <h3>Playit.gg Tunnel Coordination</h3>
                <p>Create free public addresses for friends to join over the internet without port forwarding.</p>
              </div>
            </div>
            <div className="section-header-action">
              <span className={`status-pill ${playit?.isRunning ? 'is-online' : (playit?.installed ? 'is-offline' : 'is-offline')}`}>
                {!playit?.installed ? 'Not Installed' : (playit?.isRunning ? 'Agent Running' : 'Agent Stopped')}
              </span>
            </div>
          </div>

          <div className="section-card-body">
            <div className="setting-row">
              <div className="setting-info">
                <strong>Playit Agent CLI</strong>
                <p>
                  {playit?.installed
                    ? `Playit CLI ready (Version ${playit.version ?? 'latest'}). ${playit.isManaged ? 'Managed locally by NodePilot.' : 'Installed on host system.'}`
                    : 'Download the official Playit standalone binary directly into NodePilot with 1 click (no admin privileges or installer needed).'}
                </p>
                {playit?.binaryPath && <code>{playit.binaryPath}</code>}
              </div>
              <div className="setting-action">
                {!playit?.installed ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => void handleInstallPlayit()}
                    disabled={installingPlayit}
                  >
                    <Icon name="plus" size={16} />
                    <span>{installingPlayit ? 'Downloading Playit...' : 'Install Playit (1-Click)'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`button ${playit.isRunning ? 'button-secondary' : 'button-primary'}`}
                    onClick={() => void handlePlayitToggle()}
                    disabled={togglingPlayit || !playit.secretExists}
                    title={!playit.secretExists ? 'Link your Playit account first' : ''}
                  >
                    {togglingPlayit
                      ? 'Working...'
                      : playit.isRunning
                      ? 'Stop Tunnel Agent'
                      : 'Start Tunnel Agent'}
                  </button>
                )}
              </div>
            </div>

            {playit?.installed && (
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Playit Account Association</strong>
                  <p>
                    {playit.secretExists
                      ? 'Your Playit credentials are configured. Tunnels will automatically launch and link with your servers.'
                      : 'Link this computer to your playit.gg account with 1 click. If playit.gg says you hit the agent limit (2 on free tier), delete any old unused agent on playit.gg first.'}
                  </p>
                  <small className="setting-explanation">Linking opens Playit in this tab. After approving the agent, return to NodePilot.</small>
                </div>
                <div className="setting-action" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`button ${playit.secretExists ? 'button-secondary' : 'button-primary'}`}
                    onClick={() => void handleClaimPlayit()}
                    disabled={claimingPlayit}
                  >
                    <Icon name="arrowUpRight" size={16} />
                    <span>{claimingPlayit ? 'Connecting Agent...' : (playit.secretExists ? 'Re-link New Agent' : 'Link Account (1-Click)')}</span>
                  </button>

                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setShowManualKeyInput((prev) => !prev)}
                  >
                    <Icon name="key" size={16} />
                    <span>{showManualKeyInput ? 'Hide Secret Key Input' : 'Enter Secret Key Manually'}</span>
                  </button>

                  {playit.secretExists && (
                    <button
                      type="button"
                      className="button button-danger"
                      onClick={() => void handleResetPlayit()}
                      disabled={resettingPlayit}
                    >
                      <Icon name="trash" size={16} />
                      <span>{resettingPlayit ? 'Unlinking...' : 'Unlink / Reset Playit'}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {playitClaimError && (
              <div className="notice-banner is-error" role="alert">
                <Icon name="warning" size={18} />
                <span>{playitClaimError}</span>
              </div>
            )}

            {showManualKeyInput && (
              <form onSubmit={(e) => void handleSaveSecretKey(e)} className="setting-detail-box" style={{ borderColor: 'var(--cyan)' }}>
                <strong style={{ color: 'var(--cyan)' }}>🔑 Enter Secret Key Manually:</strong>
                <p>
                  Use this only if you already have a secret key from an existing <code>playit.toml</code> file or server. 
                  <em>(Note: the playit.gg website does not display secret keys on the web dashboard for security).</em> 
                  If you don't have a key, use <strong>Link Account (1-Click)</strong> above.
                </p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                  <input
                    type="password"
                    className="input-field"
                    placeholder="e.g. 6a6758fdd18898d9ba3c..."
                    value={manualSecretKey}
                    onChange={(e) => setManualSecretKey(e.target.value)}
                    style={{ flex: 1 }}
                    required
                  />
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={savingSecretKey || !manualSecretKey.trim()}
                  >
                    {savingSecretKey ? 'Saving & Starting...' : 'Save & Connect'}
                  </button>
                </div>
              </form>
            )}

            {(claimUrl || (!playit?.secretExists && playit?.claimUrl)) && (
              <div className="setting-detail-box" style={{ borderColor: 'var(--cyan)', background: 'rgba(56, 189, 248, 0.08)', padding: '16px', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Icon name="arrowUpRight" size={18} />
                  <strong style={{ color: 'var(--cyan)', fontSize: '15px' }}>Action Required: Claim Agent on Playit.gg</strong>
                </div>
                <p style={{ margin: '0 0 12px 0', lineHeight: 1.5 }}>
                  Your Playit agent is running live on this computer. Click <strong>Open Claim Page</strong> below to associate it with your account on playit.gg. 
                  NodePilot will automatically detect when you claim it and activate your tunnels!
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <a
                    href={claimUrl || playit?.claimUrl || '#'}
                    className="button button-primary"
                    style={{ fontWeight: 700 }}
                  >
                    <Icon name="arrowUpRight" size={15} />
                    <span>Open Claim Page on Playit.gg</span>
                  </a>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={async () => {
                      const link = claimUrl || playit?.claimUrl;
                      if (!link) return;
                      await navigator.clipboard.writeText(link).catch(() => undefined);
                      setClaimCopied(true);
                      setTimeout(() => setClaimCopied(false), 2000);
                    }}
                  >
                    <Icon name={claimCopied ? 'check' : 'copy'} size={15} />
                    <span>{claimCopied ? 'Link Copied!' : 'Copy Link'}</span>
                  </button>
                  <code style={{ fontSize: '12px', background: 'rgba(0,0,0,0.3)', padding: '5px 8px', borderRadius: '4px' }}>
                    {claimUrl || playit?.claimUrl}
                  </code>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '12.5px', color: 'var(--cyan)' }}>
                  <span className="button-loader" style={{ width: '14px', height: '14px' }} />
                  <span>Waiting for you to claim agent on playit.gg… (Auto-detecting)</span>
                </div>
              </div>
            )}

            <div className="setting-detail-box">
              <strong>Account Secret Status:</strong>
              <p>
                {playit?.secretExists
                  ? 'Credentials active. Playit tunnels will automatically establish connections when servers start.'
                  : (playit?.installed ? 'Not yet linked. Click "Link Account (1-Click)" or enter your existing secret key above.' : 'Install Playit above to get started.')}
              </p>
              {playit?.secretPath && <small>Config path: {playit.secretPath}</small>}
            </div>
          </div>
        </section>

        {/* Section 4: Verified NodePilot Updates */}
        <section className="settings-section-card update-settings-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="download" size={20} />
              <div>
                <h3>NodePilot Updates</h3>
                <p>Check GitHub Releases and apply only a checksum-verified package.</p>
              </div>
            </div>
            <div className="section-header-action">
              <span
                className={[
                  'status-pill',
                  ['checking', 'downloading', 'verifying', 'extracting', 'ready_to_restart', 'restarting'].includes(updateStatus?.status ?? '')
                    ? 'is-warning'
                    : updateStatus?.status === 'error'
                      ? 'is-offline'
                      : updateStatus?.isUpdateAvailable
                      ? 'is-online'
                      : 'is-offline',
                ].join(' ')}
              >
                {updateStatus?.status === 'checking'
                  ? 'Checking'
                  : !updateStatus
                    ? 'Not Checked'
                  : updateStatus?.status === 'downloading'
                    ? 'Downloading'
                    : updateStatus?.status === 'verifying' || updateStatus?.status === 'extracting' || updateStatus?.status === 'ready_to_restart'
                      ? 'Preparing'
                    : updateStatus?.status === 'restarting'
                      ? 'Restarting'
                      : updateStatus?.status === 'error'
                        ? 'Update Error'
                      : updateStatus?.isUpdateAvailable
                        ? 'Update Available'
                        : 'Up to Date'}
              </span>
            </div>
          </div>

          <div className="section-card-body">
            <div className="update-version-grid">
              <div className="update-version-stat">
                <span>Installed</span>
                <strong>{'v' + (updateStatus?.currentVersion ?? '…')}</strong>
              </div>
              <div className="update-version-stat">
                <span>Latest release</span>
                <strong>{updateStatus?.availableRelease ? 'v' + updateStatus.availableRelease.version : 'Not checked yet'}</strong>
              </div>
              <div className="update-version-stat">
                <span>Last checked</span>
                <strong>
                  {updateStatus?.lastCheckedAt
                    ? new Date(updateStatus.lastCheckedAt).toLocaleString()
                    : 'Never'}
                </strong>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <strong>Include Preview Releases</strong>
                <p>Allow beta and release-candidate versions in update checks. Stable releases remain the default.</p>
              </div>
              <div className="setting-action">
                <label className="switch-label">
                  <input
                    type="checkbox"
                    checked={updateStatus?.includePrereleases ?? settings?.updateIncludePrereleases ?? false}
                    onChange={(event) => void handlePrereleasePreference(event.target.checked)}
                    disabled={updatingNodePilot}
                  />
                  <span>{(updateStatus?.includePrereleases ?? settings?.updateIncludePrereleases) ? 'Enabled' : 'Stable only'}</span>
                </label>
              </div>
            </div>

            <div className="update-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleCheckForUpdates()}
                disabled={updatingNodePilot || updateStatus?.status === 'restarting'}
              >
                <Icon name="refresh" size={16} />
                <span>{updateStatus?.status === 'checking' ? 'Checking…' : 'Check for Updates'}</span>
              </button>

              {updateStatus?.isUpdateAvailable && updateStatus.canAutoInstall && (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleInstallUpdate()}
                  disabled={updatingNodePilot}
                >
                  <Icon name="download" size={16} />
                  <span>{updatingNodePilot ? 'Preparing Update…' : 'Install & Restart'}</span>
                </button>
              )}

              {updateStatus?.isUpdateAvailable && (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleDismissUpdate()}
                  disabled={updatingNodePilot}
                >
                  Dismiss this version
                </button>
              )}
            </div>

            {updateStatus?.statusMessage && (
              <p className="update-status-message" aria-live="polite">{updateStatus.statusMessage}</p>
            )}

            {updateStatus && ['downloading', 'verifying', 'extracting'].includes(updateStatus.status) && (
              <div className="update-progress" aria-label="Update preparation progress">
                <div className="update-progress-track">
                  <span style={{ width: String(Math.max(3, updateStatus.progressPercent)) + '%' }} />
                </div>
                <small>
                  {updateStatus.status === 'downloading' && updateStatus.totalBytes > 0
                    ? Math.round(updateStatus.downloadedBytes / 1024 / 1024) + ' MB of ' + Math.round(updateStatus.totalBytes / 1024 / 1024) + ' MB'
                    : String(updateStatus.progressPercent) + '% complete'}
                </small>
              </div>
            )}

            {updateStatus?.isUpdateAvailable && updateStatus.availableRelease && (
              <div className="update-release-details">
                <div className="update-release-heading">
                  <div>
                    <strong>{updateStatus.availableRelease.name}</strong>
                    <p>
                      Published {new Date(updateStatus.availableRelease.publishedAt).toLocaleDateString()}
                      {updateStatus.availableRelease.isPrerelease ? ' · Preview release' : ''}
                    </p>
                  </div>
                  <a
                    href={updateStatus.availableRelease.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button-ghost button-small"
                  >
                    Release notes
                    <Icon name="arrowUpRight" size={15} />
                  </a>
                </div>

                {updateStatus.availableRelease.changelog.features.length > 0 && (
                  <div className="update-note-group">
                    <strong>New</strong>
                    <ul>{updateStatus.availableRelease.changelog.features.slice(0, 5).map((note) => <li key={note}>{note}</li>)}</ul>
                  </div>
                )}
                {updateStatus.availableRelease.changelog.improvements.length > 0 && (
                  <div className="update-note-group">
                    <strong>Improved</strong>
                    <ul>{updateStatus.availableRelease.changelog.improvements.slice(0, 5).map((note) => <li key={note}>{note}</li>)}</ul>
                  </div>
                )}
                {updateStatus.availableRelease.changelog.bugFixes.length > 0 && (
                  <div className="update-note-group">
                    <strong>Fixed</strong>
                    <ul>{updateStatus.availableRelease.changelog.bugFixes.slice(0, 5).map((note) => <li key={note}>{note}</li>)}</ul>
                  </div>
                )}
              </div>
            )}

            {updateStatus?.autoInstallReason && (
              <div className="setting-notice-banner">
                <Icon name="warning" size={16} />
                <span>{updateStatus.autoInstallReason}</span>
              </div>
            )}

            <div className="setting-detail-box update-safety-note">
              <strong>Update safety:</strong>
              <p>
                NodePilot requires a matching SHA-256 checksum, stages the ZIP without extracting links or unsafe paths,
                keeps your <code>.nodepilot</code> data and <code>.env</code> untouched, and refuses to restart while a managed server is active.
              </p>
            </div>
          </div>
        </section>

        {/* Section 5: Host Behavior & Diagnostics */}
        <section className="settings-section-card">
          <div className="section-card-header">
            <div className="section-title-wrap">
              <Icon name="activity" size={20} />
              <div>
                <h3>Host Diagnostics & Behavior</h3>
                <p>Verify NodePilot's background runtime, memory consumption, and recent startup logs.</p>
              </div>
            </div>
          </div>

          <div className="section-card-body">
            <div className="setting-row">
              <div className="setting-info">
                <strong>Continue Running When Browser Closes</strong>
                <p>
                  NodePilot operates as an independent local daemon. Closing your browser tab or window will never terminate your running Minecraft servers.
                </p>
              </div>
              <div className="setting-action">
                <span className="badge-positive">Always Protected</span>
              </div>
            </div>

            {diagnostics && (
              <div className="diagnostics-metrics-grid">
                <div className="metric-chip">
                  <span className="metric-chip-label">Host OS</span>
                  <span className="metric-chip-value">{diagnostics.platform}</span>
                </div>
                <div className="metric-chip">
                  <span className="metric-chip-label">Process PID</span>
                  <span className="metric-chip-value">{diagnostics.pid}</span>
                </div>
                <div className="metric-chip">
                  <span className="metric-chip-label">Node Runtime</span>
                  <span className="metric-chip-value">{diagnostics.nodeVersion}</span>
                </div>
                <div className="metric-chip">
                  <span className="metric-chip-label">Memory Usage</span>
                  <span className="metric-chip-value">{diagnostics.memoryUsageMb} MB</span>
                </div>
                <div className="metric-chip">
                  <span className="metric-chip-label">Uptime</span>
                  <span className="metric-chip-value">{Math.floor(diagnostics.uptimeSeconds / 60)} min</span>
                </div>
              </div>
            )}

            <div className="diagnostics-logs-wrap">
              <h4>Startup & Host Event Log</h4>
              {diagnostics?.recentLogs && diagnostics.recentLogs.length > 0 ? (
                <div className="diagnostics-log-viewer">
                  {diagnostics.recentLogs.map((entry, idx) => (
                    <div key={idx} className={`log-entry is-${entry.level}`}>
                      <span className="log-time">{entry.timestamp.split('T')[1]?.slice(0, 8)}</span>
                      <span className="log-msg">{entry.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="no-logs-caption">No startup events recorded yet.</p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
