import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import type { HostDiagnostics, HostSettings, HostStartupStatus, PlayitStatus, Server } from '../types';

export function HostSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [startup, setStartup] = useState<HostStartupStatus | null>(null);
  const [playit, setPlayit] = useState<PlayitStatus | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [diagnostics, setDiagnostics] = useState<HostDiagnostics | null>(null);

  const [togglingServer, setTogglingServer] = useState<string | null>(null);
  const [togglingPlayit, setTogglingPlayit] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [hostData, serverList, diag] = await Promise.all([
        api.getHostSettings(),
        api.servers(),
        api.getHostDiagnostics().catch(() => null),
      ]);
      setSettings(hostData.settings);
      setStartup(hostData.startup);
      setPlayit(hostData.playit);
      setServers(serverList);
      setDiagnostics(diag);
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

  const [installingPlayit, setInstallingPlayit] = useState(false);
  const [claimingPlayit, setClaimingPlayit] = useState(false);
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [manualSecretKey, setManualSecretKey] = useState('');
  const [savingSecretKey, setSavingSecretKey] = useState(false);
  const [showManualKeyInput, setShowManualKeyInput] = useState(false);
  const [resettingPlayit, setResettingPlayit] = useState(false);

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
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api.claimPlayitAccount();
      setClaimUrl(res.claimUrl);
      setPlayit(res.playit);
      setSuccessMessage('Account linking code generated! Open the link below to connect with playit.gg.');
      // Open in new tab automatically for maximum convenience
      window.open(res.claimUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate claim link.');
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
              <div className="setting-action">
                <select
                  className="input-select"
                  value={settings?.launchMode ?? 'headless'}
                  onChange={(e) => void handleUpdateOptions({ launchMode: e.target.value as 'headless' | 'windowed' })}
                  disabled={saving}
                >
                  <option value="headless">Headless (Background, No Window)</option>
                  <option value="windowed">Windowed (Interactive Terminal)</option>
                </select>
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

        {/* Section 3: Playit.gg Coordination */}
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
                      : 'Link this computer to your playit.gg account. Free accounts are limited to 2-3 agents—if you already reached your limit, use your existing secret key below.'}
                  </p>
                </div>
                <div className="setting-action" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`button ${playit.secretExists ? 'button-secondary' : 'button-primary'}`}
                    onClick={() => void handleClaimPlayit()}
                    disabled={claimingPlayit}
                  >
                    <Icon name="arrowUpRight" size={16} />
                    <span>{claimingPlayit ? 'Generating Link...' : (playit.secretExists ? 'Re-link New Agent' : 'Link Account (1-Click)')}</span>
                  </button>

                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setShowManualKeyInput((prev) => !prev)}
                  >
                    <Icon name="key" size={16} />
                    <span>{showManualKeyInput ? 'Hide Secret Key Input' : 'Use Existing Secret Key'}</span>
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

            {showManualKeyInput && (
              <form onSubmit={(e) => void handleSaveSecretKey(e)} className="setting-detail-box" style={{ borderColor: 'var(--cyan)' }}>
                <strong style={{ color: 'var(--cyan)' }}>🔑 Connect Using Existing Secret Key:</strong>
                <p>
                  If you already have a Playit agent on your account, navigate to <strong>playit.gg &gt; Agents &gt; (Your Agent) &gt; Settings &gt; Show Secret Key</strong>.
                  Paste the secret key here so NodePilot reuses your existing agent instead of hitting account agent limits.
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

            {(claimUrl || playit?.claimUrl) && !playit?.secretExists && (
              <div className="setting-detail-box" style={{ borderColor: 'var(--cyan)' }}>
                <strong style={{ color: 'var(--cyan)' }}>🔗 Finish Linking Account in Browser:</strong>
                <p>
                  Click the link below to confirm the agent on playit.gg. Once approved in your browser, NodePilot automatically starts the agent daemon so the page updates to <strong>Online</strong>!
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
                  <code style={{ flex: 1 }}>{claimUrl || playit?.claimUrl}</code>
                  <a
                    href={claimUrl || playit?.claimUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button-primary button-small"
                  >
                    Open Link
                  </a>
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

        {/* Section 4: Host Behavior & Diagnostics */}
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
