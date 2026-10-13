import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import type { DashboardData, Server } from '../types';
import { errorMessage, formatBytes, formatPercent, formatUptime, titleCase } from '../utils';

function MetricCard({
  icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: 'cpu' | 'database' | 'activity';
  label: string;
  value: string;
  detail: string;
  percent?: number;
}) {
  return (
    <article className="metric-card panel">
      <div className="metric-icon"><Icon name={icon} size={20} /></div>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      {percent !== undefined && (
        <div className="metric-meter" aria-label={`${label}: ${Math.round(percent)}%`}>
          <svg viewBox="0 0 42 42" aria-hidden="true">
            <circle className="meter-track" cx="21" cy="21" r="16" />
            <circle
              className="meter-value"
              cx="21"
              cy="21"
              r="16"
              pathLength="100"
              strokeDasharray={`${Math.max(0, Math.min(percent, 100))} 100`}
            />
          </svg>
        </div>
      )}
    </article>
  );
}

function ServerRow({ server }: { server: Server }) {
  return (
    <Link to={`/servers/${encodeURIComponent(server.id)}`} className="server-row">
      <div className="server-avatar"><Icon name="box" size={21} /></div>
      <div className="server-row-main">
        <strong>{server.name}</strong>
        <span>{[titleCase(server.software ?? server.distribution), server.version].filter(Boolean).join(' · ') || 'Minecraft'}</span>
      </div>
      <div className="server-row-port"><span>Port</span><strong>{server.port ?? 'Auto'}</strong></div>
      <StatusBadge status={server.status} directoryMissing={server.directoryExists === false} />
      <Icon name="chevronRight" size={19} className="row-chevron" />
    </Link>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const response = await api.dashboard();
      setData(response);
      setLastUpdated(new Date());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const servers = data?.servers ?? [];
  const running = useMemo(() => servers.filter((server) => server.status === 'running').length, [servers]);
  const pending = useMemo(() => servers.filter((server) => ['starting', 'stopping'].includes(server.status)).length, [servers]);
  const system = data?.system;
  const memoryPercent = system?.memory?.usagePercent
    ?? (system?.memory?.usedBytes !== undefined && system.memory.totalBytes ? (system.memory.usedBytes / system.memory.totalBytes) * 100 : undefined);
  const diskPercent = system?.disk?.usagePercent
    ?? (system?.disk?.usedBytes !== undefined && system.disk.totalBytes ? (system.disk.usedBytes / system.disk.totalBytes) * 100 : undefined);

  return (
    <section className="dashboard-page page-enter">
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">YOUR LOCAL FLEET</p>
          <h2>Welcome back</h2>
          <p>Keep an eye on your game servers and the machine behind them.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary button-icon" onClick={() => void load()} disabled={loading} title="Refresh dashboard">
            <Icon name="refresh" size={17} className={loading ? 'spin' : ''} />
            Refresh
          </button>
          <Link to="/servers/new" className="button button-primary"><Icon name="plus" size={18} /> Create server</Link>
        </div>
      </div>

      {error && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={19} />
          <div><strong>NodePilot could not reach its local API.</strong><span>{error}</span></div>
          <button className="text-button" onClick={() => void load()}>Try again</button>
        </div>
      )}

      <div className="fleet-banner panel">
        <div className="fleet-banner-orb orb-one" />
        <div className="fleet-banner-orb orb-two" />
        <div className="fleet-overview">
          <span className="fleet-icon"><Icon name="server" size={23} /></span>
          <div>
            <span className="eyebrow">SERVER FLEET</span>
            <strong>{loading && !data ? 'Loading local servers…' : `${running} of ${servers.length} online`}</strong>
            <p>{pending > 0 ? `${pending} lifecycle action in progress` : 'Running entirely on this machine'}</p>
          </div>
        </div>
        <div className="fleet-separator" />
        <div className="fleet-stat"><strong>{servers.length}</strong><span>Total servers</span></div>
        <div className="fleet-stat"><strong>{running}</strong><span>Running now</span></div>
        <Link className="fleet-link" to="/servers">View fleet <Icon name="arrowUpRight" size={17} /></Link>
      </div>

      <div className="section-heading compact-heading">
        <div><p className="eyebrow">HOST HEALTH</p><h3>Local resources</h3></div>
        <span className="muted-caption">{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for local data'}</span>
      </div>

      <div className="metrics-grid">
        <MetricCard
          icon="cpu"
          label="CPU usage"
          value={formatPercent(system?.cpu?.usagePercent)}
          detail={system?.cpu?.cores ? `${system.cpu.cores} logical cores` : 'Local processor'}
          percent={system?.cpu?.usagePercent}
        />
        <MetricCard
          icon="activity"
          label="Memory"
          value={memoryPercent === undefined ? '—' : formatPercent(memoryPercent)}
          detail={system?.memory?.usedBytes !== undefined && system.memory.totalBytes !== undefined
            ? `${formatBytes(system.memory.usedBytes)} of ${formatBytes(system.memory.totalBytes)}`
            : 'Awaiting host metrics'}
          percent={memoryPercent}
        />
        <MetricCard
          icon="database"
          label="Storage"
          value={diskPercent === undefined ? '—' : formatPercent(diskPercent)}
          detail={system?.disk?.usedBytes !== undefined && system.disk.totalBytes !== undefined
            ? `${formatBytes(system.disk.usedBytes)} of ${formatBytes(system.disk.totalBytes)}`
            : (system?.disk?.path ? system.disk.path : 'Awaiting host metrics')}
          percent={diskPercent}
        />
      </div>

      <div className="dashboard-lower-grid">
        <section className="panel servers-panel">
          <div className="panel-heading">
            <div><h3>Your servers</h3><p>{system?.uptimeSeconds !== undefined ? `Host uptime ${formatUptime(system.uptimeSeconds)}` : 'Live server state from your local host'}</p></div>
            <Link to="/servers" className="text-link">View all <Icon name="chevronRight" size={16} /></Link>
          </div>
          <div className="server-list">
            {loading && !data && <div className="loading-list"><span className="loading-bar" /><span className="loading-bar" /><span className="loading-bar" /></div>}
            {!loading && !error && servers.length === 0 && (
              <div className="empty-state compact-empty">
                <div className="empty-icon"><Icon name="server" size={25} /></div>
                <div><strong>No servers yet</strong><p>Create your first Minecraft server to get started.</p></div>
                <Link className="button button-secondary" to="/servers/new">Create server</Link>
              </div>
            )}
            {servers.slice(0, 5).map((server) => <ServerRow key={server.id} server={server} />)}
          </div>
        </section>

        <aside className="panel local-panel">
          <div className="panel-heading"><div><h3>Local runtime</h3><p>NodePilot status</p></div><span className="live-chip"><span /> Live</span></div>
          <dl className="runtime-list">
            <div><dt>Host</dt><dd>{system?.hostname ?? '—'}</dd></div>
            <div><dt>Platform</dt><dd>{system?.platform ?? '—'}</dd></div>
            <div><dt>Running servers</dt><dd>{system?.activeServers ?? running}</dd></div>
            <div><dt>Access</dt><dd>localhost only</dd></div>
          </dl>
          <div className="safe-note"><Icon name="check" size={16} /><span>No cloud account or Docker required.</span></div>
        </aside>
      </div>
    </section>
  );
}
