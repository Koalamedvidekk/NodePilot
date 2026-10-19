import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Icon } from '../components/Icon';
import type {
  Server,
  ServerSettings,
  ServerSettingsDetails,
  ServerSettingsRuntime,
  ResetServerSettingsSection,
} from '../types';
import { errorMessage, titleCase } from '../utils';

type SettingsTab = 'all' | 'auto-wake' | 'auto-sleep' | 'java' | 'startup' | 'general';

interface ServerSettingsPanelProps {
  server: Server;
  onServerUpdated?: () => void;
  onNavigateToTab?: (tab: string) => void;
}

export function ServerSettingsPanel({ server, onServerUpdated, onNavigateToTab }: ServerSettingsPanelProps) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<SettingsTab>('all');
  const [loading, setLoading] = useState(true);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [resettingSection, setResettingSection] = useState<string | null>(null);
  const [restartingServer, setRestartingServer] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [restartWarning, setRestartWarning] = useState<string | null>(null);

  const [details, setDetails] = useState<ServerSettingsDetails | null>(null);

  // Form states per section
  // 1. Auto-Wake
  const [autoWake, setAutoWake] = useState(false);
  const [wakeProxyPort, setWakeProxyPort] = useState<string>('');

  // 2. Auto-Sleep
  const [autoSleep, setAutoSleep] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState('15');

  // 3. Java & Performance
  const [minMemory, setMinMemory] = useState('');
  const [maxMemory, setMaxMemory] = useState('');
  const [customJvmArgsText, setCustomJvmArgsText] = useState('');

  // 4. Startup & Shutdown
  const [autoStart, setAutoStart] = useState<'always' | 'disabled'>('disabled');
  const [shutdownTimeoutSeconds, setShutdownTimeoutSeconds] = useState('20');

  // 5. General
  const [serverName, setServerName] = useState(server.name);
  const [serverPort, setServerPort] = useState(String(server.port ?? ''));

  const populateForm = useCallback((data: ServerSettingsDetails) => {
    const s = data.settings;
    setAutoWake(s.autoWake);
    setWakeProxyPort(s.wakeProxyPort ? String(s.wakeProxyPort) : '');

    setAutoSleep(s.autoSleep);
    setIdleTimeoutMinutes(String(s.idleTimeoutMinutes));

    const minMem = s.minMemoryMb ? (s.minMemoryMb % 1024 === 0 ? `${s.minMemoryMb / 1024}G` : `${s.minMemoryMb}M`) : '';
    const maxMem = s.maxMemoryMb ? (s.maxMemoryMb % 1024 === 0 ? `${s.maxMemoryMb / 1024}G` : `${s.maxMemoryMb}M`) : '';
    setMinMemory(minMem);
    setMaxMemory(maxMem);
    setCustomJvmArgsText((s.customJvmArgs ?? []).join('\n'));

    setAutoStart(s.autoStart ?? 'disabled');
    setShutdownTimeoutSeconds(String(s.shutdownTimeoutSeconds));

    setServerName(server.name);
    setServerPort(String(server.port ?? ''));
  }, [server.name, server.port]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getServerSettings(server.id);
      setDetails(data);
      populateForm(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [server.id, populateForm]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Periodic polling for live countdown and status when server is running
  useEffect(() => {
    if (!details?.runtime.isRunning) return;

    const timer = setInterval(() => {
      void api.getServerSettings(server.id).then((fresh) => {
        setDetails(fresh);
      }).catch(() => undefined);
    }, 4000);

    return () => clearInterval(timer);
  }, [details?.runtime.isRunning, server.id]);

  // Section Save Handlers
  const handleSaveAutoWake = async () => {
    setSavingSection('auto-wake');
    setError(null);
    setSuccessMessage(null);
    try {
      const portVal = wakeProxyPort.trim() ? parseInt(wakeProxyPort.trim(), 10) : null;
      if (portVal !== null && (isNaN(portVal) || portVal < 1 || portVal > 65535)) {
        throw new Error('Wake proxy port must be a valid port number between 1 and 65535.');
      }

      const res = await api.updateServerSettings(server.id, {
        autoWake,
        wakeProxyPort: portVal,
      });

      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      setSuccessMessage('Auto-Wake settings saved successfully.');
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveAutoSleep = async () => {
    setSavingSection('auto-sleep');
    setError(null);
    setSuccessMessage(null);
    try {
      const timeoutVal = parseInt(idleTimeoutMinutes.trim(), 10);
      if (isNaN(timeoutVal) || timeoutVal < 1 || timeoutVal > 1440) {
        throw new Error('Idle timeout must be between 1 and 1440 minutes (24 hours).');
      }

      const res = await api.updateServerSettings(server.id, {
        autoSleep,
        idleTimeoutMinutes: timeoutVal,
      });

      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      setSuccessMessage('Auto-Sleep settings saved successfully.');
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveJava = async () => {
    setSavingSection('java');
    setError(null);
    setSuccessMessage(null);
    setRestartWarning(null);
    try {
      const jvmArgs = customJvmArgsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const res = await api.updateServerSettings(server.id, {
        minMemory: minMemory.trim() ? minMemory.trim() : null,
        maxMemory: maxMemory.trim() ? maxMemory.trim() : undefined,
        customJvmArgs: jvmArgs,
      });

      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      if (res.restartRequired) {
        setRestartWarning('Settings saved. A server restart is required for the new Java heap and JVM arguments to take effect.');
      } else {
        setSuccessMessage('Java & Performance settings saved successfully.');
      }
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveStartup = async () => {
    setSavingSection('startup');
    setError(null);
    setSuccessMessage(null);
    setRestartWarning(null);
    try {
      const timeoutVal = parseInt(shutdownTimeoutSeconds.trim(), 10);
      if (isNaN(timeoutVal) || timeoutVal < 5 || timeoutVal > 300) {
        throw new Error('Shutdown timeout must be between 5 and 300 seconds.');
      }

      const res = await api.updateServerSettings(server.id, {
        autoStart,
        shutdownTimeoutSeconds: timeoutVal,
      });

      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      if (res.restartRequired) {
        setRestartWarning('Settings saved. The new shutdown timeout will apply on next server restart.');
      } else {
        setSuccessMessage('Startup & Shutdown settings saved successfully.');
      }
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveGeneral = async () => {
    setSavingSection('general');
    setError(null);
    setSuccessMessage(null);
    try {
      const nameVal = serverName.trim();
      if (!nameVal) throw new Error('Server name cannot be empty.');

      const portVal = parseInt(serverPort.trim(), 10);
      if (isNaN(portVal) || portVal < 1 || portVal > 65535) {
        throw new Error('Server port must be a valid port number between 1 and 65535.');
      }

      const res = await api.updateServerSettings(server.id, {
        name: nameVal,
        port: portVal,
      });

      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      setSuccessMessage('General server settings updated successfully.');
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSection(null);
    }
  };

  // Section Reset Handlers
  const handleResetSection = async (section: ResetServerSettingsSection) => {
    const titles: Record<ResetServerSettingsSection, string> = {
      'auto-wake': 'Auto-Wake settings',
      'auto-sleep': 'Auto-Sleep settings',
      java: 'Java & Performance settings',
      startup: 'Startup & Shutdown settings',
    };

    if (!window.confirm(`Reset ${titles[section]} to defaults? This will overwrite your current configuration for this section.`)) {
      return;
    }

    setResettingSection(section);
    setError(null);
    setSuccessMessage(null);
    setRestartWarning(null);

    try {
      const res = await api.resetServerSettings(server.id, section);
      setDetails((prev) => prev ? { ...prev, settings: res.settings, runtime: res.runtime ?? prev.runtime } : null);
      populateForm({ settings: res.settings, runtime: res.runtime ?? details!.runtime });
      setSuccessMessage(`${titles[section]} reset to defaults.`);
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResettingSection(null);
    }
  };

  const handleRestartNow = async () => {
    setRestartingServer(true);
    setError(null);
    try {
      await api.lifecycle(server.id, 'restart');
      setRestartWarning(null);
      setSuccessMessage('Server restarted successfully with your updated settings.');
      await loadSettings();
      onServerUpdated?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRestartingServer(false);
    }
  };

  if (loading && !details) {
    return (
      <section className="management-panel panel">
        <div className="management-loading">
          <span className="button-loader" /> Loading server settings…
        </div>
      </section>
    );
  }

  const isServerRunning = details?.runtime.isRunning ?? (server.status === 'running' || server.status === 'starting');
  const isBedrock = details?.runtime.isBedrock ?? (server.software === 'bedrock' || server.game === 'minecraft-bedrock');
  const wakeProxy = details?.runtime.wakeProxy;
  const autoSleepStatus = details?.runtime.autoSleep;
  const tunnel = details?.runtime.tunnel;
  const playit = details?.runtime.playit;

  const defaultWakePort = server.port ? (server.port >= 55535 ? server.port - 10000 : server.port + 10000) : 35565;

  return (
    <section className="management-panel panel server-settings-container">
      {/* Header */}
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SERVER CONFIGURATION</p>
          <h3>Server Settings</h3>
          <p>
            Configure automation, memory allocation, JVM arguments, and startup options for <strong>{server.name}</strong>.
          </p>
        </div>
        <div className="panel-heading-actions">
          <button
            className="button button-secondary button-icon"
            type="button"
            onClick={() => void loadSettings()}
            disabled={loading || savingSection !== null}
          >
            <Icon name="refresh" size={16} /> Refresh
          </button>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={18} />
          <div>
            <strong>Action failed.</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="text-button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {successMessage && (
        <div className="inline-alert alert-info" role="status">
          <Icon name="check" size={18} />
          <div>
            <strong>Saved.</strong>
            <span>{successMessage}</span>
          </div>
          <button type="button" className="text-button" onClick={() => setSuccessMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      {restartWarning && (
        <div className="inline-alert alert-warning" role="alert">
          <Icon name="warning" size={18} />
          <div>
            <strong>Restart required.</strong>
            <span>{restartWarning}</span>
          </div>
          {isServerRunning && (
            <button
              type="button"
              className="button button-warning button-compact"
              onClick={() => void handleRestartNow()}
              disabled={restartingServer}
            >
              {restartingServer ? 'Restarting…' : 'Restart Server Now'}
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setRestartWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Secondary Navigation Subtabs */}
      <div className="settings-subtabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'all'}
          className={activeTab === 'all' ? 'is-selected' : ''}
          onClick={() => setActiveTab('all')}
        >
          All Settings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'auto-wake'}
          className={activeTab === 'auto-wake' ? 'is-selected' : ''}
          onClick={() => setActiveTab('auto-wake')}
        >
          Auto-Wake
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'auto-sleep'}
          className={activeTab === 'auto-sleep' ? 'is-selected' : ''}
          onClick={() => setActiveTab('auto-sleep')}
        >
          Auto-Sleep
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'java'}
          className={activeTab === 'java' ? 'is-selected' : ''}
          onClick={() => setActiveTab('java')}
        >
          Java & Performance
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'startup'}
          className={activeTab === 'startup' ? 'is-selected' : ''}
          onClick={() => setActiveTab('startup')}
        >
          Startup & Shutdown
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={activeTab === 'general' ? 'is-selected' : ''}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
      </div>

      <div className="settings-sections-wrapper">
        {/* ============================================================== */}
        {/* SECTION 1: AUTO-WAKE */}
        {/* ============================================================== */}
        {(activeTab === 'all' || activeTab === 'auto-wake') && (
          <section className="settings-section-card">
            <div className="section-card-header">
              <div className="section-title-wrap">
                <Icon name="wifi" size={20} />
                <div>
                  <h3>Auto-Wake on Connection</h3>
                  <p>Wake up your server automatically when players connect via your Playit.gg tunnel.</p>
                </div>
              </div>
              <div className="section-header-action">
                <span
                  className={`status-pill ${
                    wakeProxy?.status === 'active'
                      ? 'is-online'
                      : wakeProxy?.status === 'standby'
                      ? 'is-standby'
                      : wakeProxy?.status === 'unsupported'
                      ? 'is-unsupported'
                      : 'is-offline'
                  }`}
                >
                  {wakeProxy?.status === 'active'
                    ? 'Active · Listening'
                    : wakeProxy?.status === 'standby'
                    ? 'Standby · Server Active'
                    : wakeProxy?.status === 'unsupported'
                    ? 'Setup Required'
                    : 'Disabled'}
                </span>
              </div>
            </div>

            <div className="section-card-body">
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Enable Auto-Wake Proxy</strong>
                  <p>
                    When enabled, NodePilot runs a lightweight TCP Wake Proxy on this server&apos;s wake port while the
                    Minecraft server is stopped. When a player attempts to join via your Playit.gg tunnel, the proxy
                    detects the connection and initiates an automatic server launch.
                  </p>
                </div>
                <div className="setting-action">
                  <ToggleSwitch
                    checked={autoWake}
                    onChange={setAutoWake}
                    label={autoWake ? 'Enabled' : 'Disabled'}
                    variant="purple"
                  />
                </div>
              </div>

              {/* Infrastructure Readiness & Diagnostics Box */}
              <div className="setting-detail-box">
                <strong>Playit.gg Tunnel & Infrastructure Status</strong>
                <p>Auto-Wake routes incoming traffic through your local Playit agent to trigger wakeups:</p>

                <div className="settings-status-grid">
                  <div className="status-grid-item">
                    <span className="status-label">Playit Agent</span>
                    <strong className={playit?.isRunning ? 'status-val-green' : 'status-val-red'}>
                      {playit?.isRunning
                        ? `Running (${playit.version ?? 'agent ready'})`
                        : playit?.installed
                        ? 'Installed · Stopped'
                        : 'Not Installed'}
                    </strong>
                    {(!playit?.installed || !playit.secretExists) && (
                      <Link to="/settings" className="setup-link">
                        Set up in Host Settings →
                      </Link>
                    )}
                  </div>

                  <div className="status-grid-item">
                    <span className="status-label">Tunnel Link</span>
                    <strong className={tunnel?.status === 'connected' ? 'status-val-green' : 'status-val-yellow'}>
                      {tunnel?.status === 'connected'
                        ? 'Active Public Tunnel'
                        : tunnel?.status === 'connecting'
                        ? 'Connecting…'
                        : 'No Tunnel Configured'}
                    </strong>
                    {!tunnel && (
                      <span className="setup-hint">Configure tunnel on Overview tab</span>
                    )}
                  </div>

                  <div className="status-grid-item">
                    <span className="status-label">Wake Proxy Status</span>
                    <strong>
                      {wakeProxy?.status === 'active'
                        ? `Listening on port ${wakeProxy.wakePort}`
                        : wakeProxy?.status === 'standby'
                        ? 'Standby (Server is running)'
                        : wakeProxy?.status === 'unsupported'
                        ? 'Action required'
                        : 'Disabled'}
                    </strong>
                  </div>
                </div>

                {wakeProxy?.message && (
                  <p className="setting-explanation-box">
                    <Icon name="info" size={14} /> {wakeProxy.message}
                  </p>
                )}
              </div>

              {/* Distinct Local Ports & Addresses */}
              <div className="ports-comparison-card">
                <h4>Network Routing & Port Mapping</h4>
                <div className="ports-grid">
                  <div className="port-card">
                    <span className="port-badge-label">Public Playit Address</span>
                    <strong>{tunnel?.publicAddress ?? 'None configured'}</strong>
                    <small>Players enter this address in their Minecraft multiplayer list.</small>
                  </div>
                  <div className="port-card">
                    <span className="port-badge-label">Wake Proxy Port</span>
                    <strong>{wakeProxyPort ? wakeProxyPort : defaultWakePort}</strong>
                    <small>Listens on 127.0.0.1 for wakeup triggers while server is stopped.</small>
                  </div>
                  <div className="port-card">
                    <span className="port-badge-label">Actual Minecraft Port</span>
                    <strong>{server.port ?? 25565}</strong>
                    <small>The local server port bound when the Minecraft server is running.</small>
                  </div>
                </div>

                <div className="custom-port-input-row">
                  <label htmlFor="custom-wake-port">
                    <span>Custom Wake Proxy Port (Optional):</span>
                    <input
                      id="custom-wake-port"
                      type="number"
                      min={1}
                      max={65535}
                      placeholder={String(defaultWakePort)}
                      value={wakeProxyPort}
                      onChange={(e) => setWakeProxyPort(e.target.value)}
                    />
                  </label>
                  <small>Leave empty to use standard offset port ({defaultWakePort}).</small>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="section-actions-row">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleResetSection('auto-wake')}
                  disabled={resettingSection === 'auto-wake' || savingSection === 'auto-wake'}
                >
                  <Icon name="refresh" size={14} /> Reset Auto-Wake
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleSaveAutoWake()}
                  disabled={savingSection === 'auto-wake'}
                >
                  {savingSection === 'auto-wake' ? 'Saving…' : 'Save Auto-Wake Settings'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ============================================================== */}
        {/* SECTION 2: AUTO-SLEEP */}
        {/* ============================================================== */}
        {(activeTab === 'all' || activeTab === 'auto-sleep') && (
          <section className="settings-section-card">
            <div className="section-card-header">
              <div className="section-title-wrap">
                <Icon name="activity" size={20} />
                <div>
                  <h3>Auto-Sleep (Idle Power Saving)</h3>
                  <p>Gracefully stop the server when no players are connected to conserve host resources.</p>
                </div>
              </div>
              <div className="section-header-action">
                <span
                  className={`status-pill ${
                    autoSleepStatus?.enabled
                      ? autoSleepStatus.isIdle
                        ? 'is-idle'
                        : 'is-online'
                      : 'is-offline'
                  }`}
                >
                  {autoSleepStatus?.enabled
                    ? autoSleepStatus.isIdle
                      ? 'Idle · Countdown Active'
                      : 'Active · Players Online'
                    : 'Disabled'}
                </span>
              </div>
            </div>

            <div className="section-card-body">
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Enable Auto-Sleep</strong>
                  <p>
                    When enabled, NodePilot continuously monitors active player connections. If the server has 0
                    players connected for the configured duration, it triggers a graceful shutdown (allowing the server
                    to save world chunks and player data).
                  </p>
                  <small className="setting-explanation">
                    Auto-Sleep operates independently from Auto-Wake. The countdown will immediately cancel if a player joins.
                  </small>
                </div>
                <div className="setting-action">
                  <ToggleSwitch
                    checked={autoSleep}
                    onChange={setAutoSleep}
                    label={autoSleep ? 'Enabled' : 'Disabled'}
                    variant="purple"
                  />
                </div>
              </div>

              {/* Idle Timeout Configuration */}
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Idle Timeout Duration</strong>
                  <p>Minutes to wait with 0 players online before initiating a graceful stop.</p>
                </div>
                <div className="setting-action idle-timeout-controls">
                  <CustomSelect
                    value={idleTimeoutMinutes}
                    onChange={setIdleTimeoutMinutes}
                    options={[
                      { value: '5', label: '5 minutes' },
                      { value: '10', label: '10 minutes' },
                      { value: '15', label: '15 minutes (Default)' },
                      { value: '30', label: '30 minutes' },
                      { value: '60', label: '1 hour' },
                      { value: '120', label: '2 hours' },
                    ]}
                  />
                </div>
              </div>

              {/* Live Idle & Countdown Status Card */}
              <div className="setting-detail-box countdown-card">
                <div className="countdown-header">
                  <strong>Live Idle & Shutdown Status</strong>
                  <span className="players-count-chip">
                    <Icon name="users" size={14} /> {autoSleepStatus?.onlinePlayersCount ?? 0} Players Online
                  </span>
                </div>

                {isServerRunning ? (
                  autoSleepStatus?.enabled ? (
                    autoSleepStatus.isIdle && autoSleepStatus.countdownSeconds !== null ? (
                      <div className="countdown-body is-counting">
                        <div className="countdown-timer-display">
                          <span className="timer-number">
                            {Math.floor(autoSleepStatus.countdownSeconds / 60)}m {autoSleepStatus.countdownSeconds % 60}s
                          </span>
                          <span className="timer-label">remaining until graceful shutdown</span>
                        </div>
                        <p className="countdown-hint">
                          Server is idle with 0 players. If any player joins, this timer resets and cancels automatically.
                        </p>
                      </div>
                    ) : (
                      <div className="countdown-body is-active-players">
                        <span className="status-val-green">
                          <Icon name="check" size={16} /> Server active with connected players
                        </span>
                        <p className="countdown-hint">
                          Auto-Sleep countdown is suspended because players are currently connected. The server will never shut down while players remain on the server.
                        </p>
                      </div>
                    )
                  ) : (
                    <p className="countdown-hint">
                      Auto-Sleep is disabled. The server will run continuously until stopped manually.
                    </p>
                  )
                ) : (
                  <p className="countdown-hint">
                    Server is currently stopped. Auto-Sleep monitoring will activate automatically once the server is started.
                  </p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="section-actions-row">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleResetSection('auto-sleep')}
                  disabled={resettingSection === 'auto-sleep' || savingSection === 'auto-sleep'}
                >
                  <Icon name="refresh" size={14} /> Reset Auto-Sleep
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleSaveAutoSleep()}
                  disabled={savingSection === 'auto-sleep'}
                >
                  {savingSection === 'auto-sleep' ? 'Saving…' : 'Save Auto-Sleep Settings'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ============================================================== */}
        {/* SECTION 3: JAVA & PERFORMANCE */}
        {/* ============================================================== */}
        {(activeTab === 'all' || activeTab === 'java') && (
          <section className="settings-section-card">
            <div className="section-card-header">
              <div className="section-title-wrap">
                <Icon name="cpu" size={20} />
                <div>
                  <h3>Java & Performance</h3>
                  <p>Configure Java Virtual Machine heap memory allocation and custom startup arguments.</p>
                </div>
              </div>
              <div className="section-header-action">
                {isBedrock ? (
                  <span className="status-pill is-standby">Bedrock Native C++</span>
                ) : (
                  <span className="status-pill is-online">
                    Max: {maxMemory || `${server.memoryMb ?? 2048}M`}
                  </span>
                )}
              </div>
            </div>

            <div className="section-card-body">
              {isBedrock ? (
                <div className="setting-detail-box bedrock-notice">
                  <strong>Minecraft Bedrock Dedicated Server</strong>
                  <p>
                    This server runs as a native C++ executable (<code>bedrock_server.exe</code>) rather than a Java JAR.
                    Java heap settings (-Xms, -Xmx) and JVM parameters do not apply to Bedrock servers. Process memory is
                    managed directly by the host operating system.
                  </p>
                </div>
              ) : (
                <>
                  {isServerRunning && (
                    <div className="setting-notice-banner">
                      <Icon name="info" size={16} />
                      <span>
                        The server is currently running. Any adjustments to heap memory or launch arguments will take effect
                        upon the next server restart.
                      </span>
                    </div>
                  )}

                  {/* Heap Memory Inputs */}
                  <div className="memory-config-grid">
                    <div className="memory-input-card">
                      <label htmlFor="java-min-memory">
                        <strong>Minimum Heap Memory (-Xms)</strong>
                        <span>Initial memory committed to Java at startup. Supports human units like &quot;2G&quot; or &quot;2048M&quot;.</span>
                      </label>
                      <input
                        id="java-min-memory"
                        type="text"
                        placeholder="e.g. 2G (Optional)"
                        value={minMemory}
                        onChange={(e) => setMinMemory(e.target.value)}
                      />
                      <small className="card-hint">
                        {minMemory.trim()
                          ? `Will be passed as: -Xms${minMemory.trim()}`
                          : 'Default: NodePilot computes initial heap dynamically.'}
                      </small>
                    </div>

                    <div className="memory-input-card">
                      <label htmlFor="java-max-memory">
                        <strong>Maximum Heap Memory (-Xmx)</strong>
                        <span>Maximum memory limit for the server. Supports &quot;4G&quot;, &quot;4096M&quot;, etc.</span>
                      </label>
                      <input
                        id="java-max-memory"
                        type="text"
                        placeholder="e.g. 4G"
                        value={maxMemory}
                        onChange={(e) => setMaxMemory(e.target.value)}
                      />
                      <small className="card-hint">
                        Current allocated limit: {maxMemory.trim() ? maxMemory.trim() : `${server.memoryMb ?? 2048}M`}
                      </small>
                    </div>
                  </div>

                  {/* Additional JVM Arguments */}
                  <div className="jvm-arguments-box">
                    <label htmlFor="custom-jvm-args">
                      <strong>Additional JVM Launch Arguments</strong>
                      <p>
                        Flags passed directly to Java at startup (one argument per line or space-separated). Never silently
                        overwritten. Direct execution prevents shell injection.
                      </p>
                    </label>
                    <textarea
                      id="custom-jvm-args"
                      rows={4}
                      placeholder="-XX:+UseG1GC&#10;-XX:+ParallelRefProcEnabled&#10;-Dfile.encoding=UTF-8"
                      value={customJvmArgsText}
                      onChange={(e) => setCustomJvmArgsText(e.target.value)}
                    />
                    <small className="setting-explanation">
                      Do not include -Xms or -Xmx flags here; use the dedicated heap fields above.
                    </small>
                  </div>

                  {/* Detected Java Version Card */}
                  <div className="setting-detail-box java-detection-card">
                    <strong>Java Runtime Environment</strong>
                    <div className="java-details-row">
                      <div className="java-detail-item">
                        <span className="detail-label">Configured Java Path</span>
                        <code>{details?.runtime.javaPath ?? server.javaPath ?? 'Auto-detected by NodePilot'}</code>
                      </div>
                      <div className="java-detail-item">
                        <span className="detail-label">Detected Version</span>
                        <strong>
                          {details?.runtime.detectedJava
                            ? `Java ${details.runtime.detectedJava.major} (${details.runtime.detectedJava.version})`
                            : details?.runtime.requiredJavaMajor
                            ? `Java ${details.runtime.requiredJavaMajor} (Required)`
                            : 'Standard Java Runtime'}
                        </strong>
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="section-actions-row">
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => void handleResetSection('java')}
                      disabled={resettingSection === 'java' || savingSection === 'java'}
                    >
                      <Icon name="refresh" size={14} /> Reset Java Settings
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => void handleSaveJava()}
                      disabled={savingSection === 'java'}
                    >
                      {savingSection === 'java' ? 'Saving…' : 'Save Java & Performance Settings'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {/* ============================================================== */}
        {/* SECTION 4: STARTUP & SHUTDOWN */}
        {/* ============================================================== */}
        {(activeTab === 'all' || activeTab === 'startup') && (
          <section className="settings-section-card">
            <div className="section-card-header">
              <div className="section-title-wrap">
                <Icon name="play" size={20} />
                <div>
                  <h3>Startup & Shutdown</h3>
                  <p>Control automatic launch on NodePilot startup and configure graceful shutdown safety timeouts.</p>
                </div>
              </div>
              <div className="section-header-action">
                <span className={`status-pill ${autoStart === 'always' ? 'is-online' : 'is-offline'}`}>
                  Auto-Start: {autoStart === 'always' ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>

            <div className="section-card-body">
              {/* Server Auto-Start vs OS Startup */}
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Start Server when NodePilot Starts</strong>
                  <p>
                    Automatically boots this Minecraft server as soon as the NodePilot host daemon begins running.
                  </p>
                  <div className="distinct-startup-callout">
                    <Icon name="info" size={14} />
                    <span>
                      <strong>Important distinction:</strong> This setting controls whether this specific server starts
                      when NodePilot opens. To make NodePilot itself launch on Windows boot or system login, configure{' '}
                      <Link to="/settings">Host Settings</Link>.
                    </span>
                  </div>
                </div>
                <div className="setting-action">
                  <ToggleSwitch
                    checked={autoStart === 'always'}
                    onChange={(checked) => setAutoStart(checked ? 'always' : 'disabled')}
                    label={autoStart === 'always' ? 'Always' : 'Disabled'}
                    variant="purple"
                  />
                </div>
              </div>

              {/* Graceful Shutdown Timeout */}
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Graceful Shutdown Timeout (Seconds)</strong>
                  <p>
                    Seconds NodePilot waits after issuing the <code>stop</code> command for the server to save player
                    inventories and world chunks before forcefully stopping the process.
                  </p>
                </div>
                <div className="setting-action">
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={shutdownTimeoutSeconds}
                    onChange={(e) => setShutdownTimeoutSeconds(e.target.value)}
                    className="small-number-input"
                  />
                </div>
              </div>

              {/* Startup Configuration Inspector */}
              <div className="setting-detail-box startup-inspector">
                <strong>Current Server Launch Configuration</strong>
                <div className="inspector-grid">
                  <div>
                    <span className="inspector-label">Startup Mode</span>
                    <code>{details?.runtime.startupConfig?.mode ?? (isBedrock ? 'executable' : 'jar')}</code>
                  </div>
                  <div>
                    <span className="inspector-label">Minecraft Software</span>
                    <strong>{titleCase(server.software ?? server.distribution)}</strong>
                  </div>
                  <div>
                    <span className="inspector-label">Default Game Arguments</span>
                    <code>{(details?.runtime.startupConfig?.gameArguments ?? ['nogui']).join(' ')}</code>
                  </div>
                  <div>
                    <span className="inspector-label">Working Directory</span>
                    <code>.nodepilot/servers/{server.directory}</code>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="section-actions-row">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void handleResetSection('startup')}
                  disabled={resettingSection === 'startup' || savingSection === 'startup'}
                >
                  <Icon name="refresh" size={14} /> Reset Startup Settings
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleSaveStartup()}
                  disabled={savingSection === 'startup'}
                >
                  {savingSection === 'startup' ? 'Saving…' : 'Save Startup Settings'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ============================================================== */}
        {/* SECTION 5: GENERAL */}
        {/* ============================================================== */}
        {(activeTab === 'all' || activeTab === 'general') && (
          <section className="settings-section-card">
            <div className="section-card-header">
              <div className="section-title-wrap">
                <Icon name="settings" size={20} />
                <div>
                  <h3>General Server Details</h3>
                  <p>View identity parameters and modify server name and network port.</p>
                </div>
              </div>
            </div>

            <div className="section-card-body">
              <div className="setting-row">
                <div className="setting-info">
                  <strong>Server Name</strong>
                  <p>Display name shown in the server list and NodePilot dashboard.</p>
                </div>
                <div className="setting-action">
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    maxLength={64}
                    className="general-text-input"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <strong>Local Game Port</strong>
                  <p>Local TCP/UDP port bound by this server process on the host machine.</p>
                  {isServerRunning && (
                    <small className="setting-explanation warning-text">
                      <Icon name="warning" size={12} /> Stop the server to modify its network port.
                    </small>
                  )}
                </div>
                <div className="setting-action">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={serverPort}
                    onChange={(e) => setServerPort(e.target.value)}
                    disabled={isServerRunning}
                    className="small-number-input"
                  />
                </div>
              </div>

              <div className="setting-detail-box read-only-details">
                <strong>Read-Only Metadata</strong>
                <div className="metadata-grid">
                  <div>
                    <span className="metadata-label">Software Distribution</span>
                    <strong>{titleCase(server.software ?? server.distribution)}</strong>
                  </div>
                  <div>
                    <span className="metadata-label">Minecraft Version</span>
                    <strong>{server.version ?? 'Unknown'}</strong>
                  </div>
                  <div>
                    <span className="metadata-label">Game Platform</span>
                    <strong>{isBedrock ? 'Minecraft Bedrock' : 'Minecraft Java'}</strong>
                  </div>
                  <div>
                    <span className="metadata-label">Server Folder</span>
                    <code>.nodepilot/servers/{server.directory}</code>
                  </div>
                </div>
              </div>

              {/* Gameplay Settings Link Callout */}
              <div className="gameplay-link-callout">
                <div className="callout-content">
                  <Icon name="sliders" size={18} />
                  <div>
                    <strong>Looking for Minecraft Gameplay Settings?</strong>
                    <p>
                      Game mode, difficulty, PvP, whitelist, monster spawning, and MOTD are configured in your{' '}
                      <code>server.properties</code> file.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    if (onNavigateToTab) {
                      onNavigateToTab('properties');
                    } else {
                      navigate(`/servers/${server.id}/properties`);
                    }
                  }}
                >
                  <span>Go to Properties Tab →</span>
                </button>
              </div>

              {/* Action Buttons */}
              <div className="section-actions-row">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleSaveGeneral()}
                  disabled={savingSection === 'general'}
                >
                  {savingSection === 'general' ? 'Saving…' : 'Save General Settings'}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
