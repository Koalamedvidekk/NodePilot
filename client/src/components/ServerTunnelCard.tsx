import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import type { PlayitStatus, Server, ServerTunnel } from '../types';
import { errorMessage } from '../utils';

export function ServerTunnelCard({ server }: { server: Server }) {
  const [tunnel, setTunnel] = useState<ServerTunnel | null>(null);
  const [playit, setPlayit] = useState<PlayitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedPort, setCopiedPort] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const loadTunnel = async () => {
    try {
      setError(undefined);
      const res = await api.getServerTunnel(server.id);
      setTunnel(res.tunnel);
      setPlayit(res.playit);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const hasPublicAddress = Boolean(tunnel?.publicAddress || tunnel?.connectionAddress);

  const effectiveAddress = useMemo(() => {
    if (!tunnel) return '';
    const host = tunnel.publicAddress || tunnel.connectionAddress;
    if (!host) return '';
    if (tunnel.publicPort && tunnel.publicPort !== 25565) {
      if (tunnel.connectionAddress && tunnel.connectionAddress.includes(':')) {
        return tunnel.connectionAddress;
      }
      return `${host.replace(/:.*$/, '')}:${tunnel.publicPort}`;
    }
    return tunnel.connectionAddress || host;
  }, [tunnel]);

  useEffect(() => {
    void loadTunnel();
    // Fast polling (3.5s) while waiting for tunnel creation, relaxed (15s) once connected
    const interval = window.setInterval(() => {
      void loadTunnel();
    }, hasPublicAddress ? 15_000 : 3_500);
    return () => window.clearInterval(interval);
  }, [server.id, hasPublicAddress]);

  const handleCopy = async () => {
    if (!effectiveAddress) return;

    try {
      await navigator.clipboard.writeText(effectiveAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback
    }
  };

  const handleCopyPort = async () => {
    if (!tunnel?.localPort) return;
    try {
      await navigator.clipboard.writeText(String(tunnel.localPort));
      setCopiedPort(true);
      setTimeout(() => setCopiedPort(false), 2200);
    } catch {
      // Fallback
    }
  };

  const handleEnable = async () => {
    setActionBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const res = await api.enableServerTunnel(server.id);
      setTunnel(res.tunnel);
      setPlayit(res.playit);
      setSuccess('Playit tunnel enabled! Checking Playit configuration…');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const handleVerify = async () => {
    setActionBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const res = await api.verifyServerTunnel(server.id);
      setTunnel(res.tunnel);
      setPlayit(res.playit);
      if (res.tunnel.status === 'connected') {
        setSuccess('Playit tunnel verified and connected!');
      } else if (res.tunnel.publicAddress) {
        setSuccess('Tunnel details updated.');
      } else {
        setSuccess('Checked Playit account. No tunnel found yet for this port.');
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm('Remove this server’s Playit tunnel mapping? Your Minecraft world and server files will remain safe.')) {
      return;
    }
    setActionBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await api.removeServerTunnel(server.id);
      setTunnel(null);
      setSuccess('Playit tunnel association removed.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  };

  if (loading && !tunnel) {
    return (
      <section className="panel overview-card tunnel-card">
        <div className="panel-heading">
          <div>
            <h3>Playit.gg Public Tunnel</h3>
            <p>Loading tunnel state…</p>
          </div>
        </div>
      </section>
    );
  }

  // Not enabled for this server
  if (!tunnel) {
    return (
      <section className="panel overview-card tunnel-card">
        <div className="panel-heading">
          <div className="title-with-icon">
            <Icon name="wifi" size={20} />
            <div>
              <h3>Playit.gg Public Tunnel</h3>
              <p>Internet multiplayer without port forwarding</p>
            </div>
          </div>
          <span className="status-pill is-offline">Not Configured</span>
        </div>
        <div className="tunnel-card-body">
          <p className="tunnel-intro">
            Friends outside your local Wi-Fi can join your server directly without you having to open router ports or expose your home IP address.
          </p>
          {error && <div className="notice-banner is-error"><Icon name="warning" size={16} /><span>{error}</span></div>}
          {success && <div className="notice-banner is-success"><Icon name="check" size={16} /><span>{success}</span></div>}
          <div className="tunnel-actions-row">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleEnable()}
              disabled={actionBusy}
            >
              <Icon name="wifi" size={16} />
              <span>{actionBusy ? 'Configuring…' : 'Enable Public Tunnel with Playit.gg'}</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const isConnected = tunnel.status === 'connected';
  const isConnecting = tunnel.status === 'connecting';

  return (
    <section className="panel overview-card tunnel-card">
      <div className="panel-heading">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div className={`status-orb status-${isConnected ? 'running' : isConnecting ? 'starting' : 'stopped'}`} style={{ width: '28px', height: '28px' }}>
            <Icon name="wifi" size={16} />
          </div>
          <div>
            <h3>Playit.gg Public Tunnel</h3>
            <p>Public Internet Address &amp; Routing</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className={`status-pill ${isConnected ? 'is-online' : isConnecting ? 'is-warning' : 'is-offline'}`}>
            {isConnected
              ? 'Tunnel Connected'
              : isConnecting
              ? 'Pending Playit Tunnel Creation'
              : tunnel.status === 'error'
              ? 'Setup Needed'
              : 'Agent Disconnected'}
          </span>
        </div>
      </div>

      <div className="tunnel-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && (
          <div className="notice-banner is-error">
            <Icon name="warning" size={16} />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="notice-banner is-success">
            <Icon name="check" size={16} />
            <span>{success}</span>
          </div>
        )}

        {/* Public Address Display Box */}
        {hasPublicAddress ? (
          <div className="public-address-banner">
            <div className="public-address-row">
              <div className="public-address-info">
                <small className="public-address-tag">Public Connection Address</small>
                <div className="public-address-code-wrap">
                  <code className="public-address-code">
                    {effectiveAddress}
                  </code>
                </div>
              </div>
              <button
                type="button"
                className={`button ${copied ? 'button-primary' : 'button-secondary'} public-address-copy-btn`}
                onClick={() => void handleCopy()}
              >
                <Icon name={copied ? 'check' : 'copy'} size={16} />
                <span>{copied ? 'Copied!' : 'Copy Address'}</span>
              </button>
            </div>
            <p className="public-address-caption">
              Give this address to players outside your network. Players in Minecraft Java can paste this directly into Direct Connection or Server List.
            </p>
            {server.status !== 'running' && (
              <div className="tunnel-warning-notice">
                <Icon name="info" size={14} />
                <span>Minecraft server is currently {server.status}. Start the server above so friends connecting through Playit can join.</span>
              </div>
            )}
            {!playit?.isRunning && (
              <div className="tunnel-warning-notice">
                <Icon name="warning" size={14} />
                <span>Playit agent is currently offline. Click <strong>Re-verify Tunnel</strong> below to launch it.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="notice-banner is-warning" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255, 209, 106, 0.35)', background: 'rgba(255, 209, 106, 0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="info" size={18} />
              <strong style={{ fontSize: '15px' }}>Action Required: Add Tunnel on Playit.gg</strong>
            </div>
            <p style={{ margin: 0, fontSize: '13.5px', lineHeight: 1.5 }}>
              Playit requires creating the tunnel once in your account so their global proxy allocates your public IP/domain.
              Add a tunnel pointing to this server’s local port <code style={{ fontSize: '14px', fontWeight: 700, background: 'rgba(255,255,255,0.12)', padding: '2px 7px', borderRadius: '4px' }}>{tunnel.localPort}</code>:
            </p>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <a
                href="https://playit.gg/account/setup/new-tunnel"
                target="_blank"
                rel="noopener noreferrer"
                className="button button-primary"
              >
                <Icon name="arrowUpRight" size={15} />
                <span>Open Playit Tunnel Setup (Port {tunnel.localPort})</span>
              </a>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleCopyPort()}
                title="Copy local port number to clipboard"
              >
                <Icon name={copiedPort ? 'check' : 'copy'} size={15} />
                <span>{copiedPort ? 'Port Copied!' : `Copy Port ${tunnel.localPort}`}</span>
              </button>
              <a
                href="https://playit.gg/account/tunnels"
                target="_blank"
                rel="noopener noreferrer"
                className="button button-secondary"
                title="View all tunnels on Playit.gg"
              >
                <span>View Tunnels</span>
              </a>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void handleVerify()}
                disabled={actionBusy}
              >
                <Icon name="refresh" size={14} />
                <span>{actionBusy ? 'Checking…' : 'Check / Verify Now'}</span>
              </button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '8px' }}>
              💡 <strong>Quick Steps:</strong> 1. Click button above &bull; 2. Select <strong>Minecraft Java</strong> &bull; 3. Enter Port <strong>{tunnel.localPort}</strong> &bull; 4. Click Add Tunnel. NodePilot will automatically detect it within seconds!
            </div>
          </div>
        )}

        {/* Technical Tunnel Details Grid */}
        <div className="tunnel-metrics-grid">
          <div className="metric-chip">
            <span className="metric-chip-label">Public Domain</span>
            <span className="metric-chip-value" style={{ fontSize: '0.95rem' }}>
              {tunnel.publicAddress || (isConnected ? 'Allocating…' : 'Needs creation on Playit')}
            </span>
          </div>
          <div className="metric-chip">
            <span className="metric-chip-label">Public Port</span>
            <span className="metric-chip-value" style={{ fontSize: '0.95rem' }}>
              {tunnel.publicPort ? String(tunnel.publicPort) : hasPublicAddress ? 'SRV / Default' : 'Assigned after creation'}
            </span>
          </div>
          <div className="metric-chip">
            <span className="metric-chip-label">Target Local Port</span>
            <span className="metric-chip-value" style={{ fontSize: '0.95rem' }}>127.0.0.1:{tunnel.localPort}</span>
          </div>
          <div className="metric-chip">
            <span className="metric-chip-label">Playit Agent</span>
            <span className="metric-chip-value" style={{ fontSize: '0.95rem' }}>{playit?.isRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div className="metric-chip">
            <span className="metric-chip-label">Minecraft Server</span>
            <span className="metric-chip-value" style={{ fontSize: '0.95rem' }}>
              <span className={`status-pill ${server.status === 'running' ? 'is-online' : 'is-offline'}`} style={{ padding: '2px 8px', fontSize: '11px' }}>
                {server.status.toUpperCase()}
              </span>
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="tunnel-card-actions">
          <div className="tunnel-action-group">
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => void handleVerify()}
              disabled={actionBusy}
              title="Re-query Playit API for matching tunnel updates"
            >
              <Icon name="refresh" size={14} />
              <span>{actionBusy ? 'Checking…' : 'Re-verify Tunnel'}</span>
            </button>
            <a
              href="https://playit.gg/account/tunnels"
              target="_blank"
              rel="noopener noreferrer"
              className="button button-secondary button-small"
              title="Manage tunnel routing and custom domains on Playit.gg"
            >
              <Icon name="arrowUpRight" size={14} />
              <span>Manage on Playit.gg</span>
            </a>
          </div>

          <button
            type="button"
            className="button button-danger-outline button-small tunnel-remove-btn"
            onClick={() => void handleRemove()}
            disabled={actionBusy}
            title="Disconnect tunnel tracking from this server"
          >
            <Icon name="trash" size={14} />
            <span>Remove Tunnel</span>
          </button>
        </div>
      </div>
    </section>
  );
}
