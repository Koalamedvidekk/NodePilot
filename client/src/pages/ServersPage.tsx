import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import type { Server, ServerStatus } from '../types';
import { errorMessage, formatDate, titleCase } from '../utils';

type Filter = 'all' | ServerStatus;

const filters: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All servers' },
  { key: 'running', label: 'Running' },
  { key: 'stopped', label: 'Stopped' },
  { key: 'error', label: 'Needs attention' },
];

function ServerCard({ server, onAction }: { server: Server; onAction: (server: Server, action: 'start' | 'stop') => void }) {
  const busy = server.status === 'starting' || server.status === 'stopping';
  const action = server.status === 'running' ? 'stop' : 'start';
  return (
    <article className="server-card panel">
      <div className="server-card-top">
        <div className="server-game-mark"><Icon name="box" size={24} /></div>
        <StatusBadge status={server.status} directoryMissing={server.directoryExists === false} />
      </div>
      <Link to={`/servers/${encodeURIComponent(server.id)}`} className="server-card-title">
        <h3>{server.name}</h3>
        <span>{[titleCase(server.software ?? server.distribution), server.version].filter(Boolean).join(' · ') || 'Minecraft'}</span>
      </Link>
      <div className="server-card-meta">
        <span><Icon name="activity" size={15} /> Port {server.port ?? 'Auto'}</span>
        <span><Icon name="database" size={15} /> {server.memoryMb ? `${server.memoryMb} MB` : server.memory?.limitBytes ? `${Math.round(server.memory.limitBytes / 1024 / 1024)} MB` : 'Default memory'}</span>
      </div>
      {server.directoryExists === false ? (
        <p className="card-error"><Icon name="warning" size={15} /> Server folder does not exist on disk</p>
      ) : server.error ? (
        <p className="card-error"><Icon name="warning" size={15} /> {server.error}</p>
      ) : null}
      <div className="server-card-footer">
        <span className="updated-label">{server.updatedAt ? `Updated ${formatDate(server.updatedAt)}` : 'Local server'}</span>
        <div className="server-card-actions">
          <button
            className={`icon-button ${action === 'start' ? 'start-action' : 'stop-action'}`}
            onClick={() => onAction(server, action)}
            disabled={busy || (action === 'start' && server.directoryExists === false)}
            title={server.directoryExists === false && action === 'start' ? 'Cannot start: server folder is missing' : `${titleCase(action)} server`}
            aria-label={`${titleCase(action)} ${server.name}`}
          >
            <Icon name={action === 'start' ? 'play' : 'square'} size={15} />
          </button>
          <Link className="icon-button" to={`/servers/${encodeURIComponent(server.id)}`} title="Manage server" aria-label={`Manage ${server.name}`}>
            <Icon name="chevronRight" size={18} />
          </Link>
        </div>
      </div>
    </article>
  );
}

export function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [actionId, setActionId] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      setServers(await api.servers());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const displayedServers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return servers.filter((server) => {
      const matchesFilter = filter === 'all' || server.status === filter;
      const matchesSearch = !needle || [server.name, server.version, server.software, server.distribution, server.port]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
      return matchesFilter && matchesSearch;
    });
  }, [servers, filter, search]);

  const runAction = async (server: Server, action: 'start' | 'stop') => {
    setActionId(server.id);
    try {
      setError(undefined);
      const updated = await api.lifecycle(server.id, action);
      setServers((current) => current.map((item) => item.id === server.id ? { ...item, ...updated } : item));
    } catch (cause) {
      setError(`${server.name}: ${errorMessage(cause)}`);
    } finally {
      setActionId(undefined);
    }
  };

  return (
    <section className="servers-page page-enter">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOCAL GAME SERVERS</p>
          <h2>Servers</h2>
          <p>Start, stop, and manage every server running on this machine.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary button-icon" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={17} className={loading ? 'spin' : ''} /> Refresh
          </button>
          <Link to="/servers/import" className="button button-secondary"><Icon name="folder" size={18} /> Import</Link>
          <Link to="/servers/new" className="button button-primary"><Icon name="plus" size={18} /> Create server</Link>
        </div>
      </div>

      {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={19} /><div><strong>Couldn’t complete that request.</strong><span>{error}</span></div></div>}

      <div className="server-toolbar panel">
        <label className="search-field">
          <Icon name="server" size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search servers" aria-label="Search servers" />
          {search && <button type="button" className="input-clear" aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}
        </label>
        <div className="filter-tabs" aria-label="Filter servers">
          {filters.map((item) => (
            <button key={item.key} className={filter === item.key ? 'is-selected' : ''} onClick={() => setFilter(item.key)}>{item.label}</button>
          ))}
        </div>
      </div>

      {loading && <div className="servers-grid loading-cards"><div /><div /><div /></div>}
      {!loading && !error && displayedServers.length === 0 && (
        <div className="empty-state panel large-empty">
          <div className="empty-icon"><Icon name={servers.length ? 'server' : 'plus'} size={29} /></div>
          <h3>{servers.length ? 'No matching servers' : 'Create your first server'}</h3>
          <p>{servers.length ? 'Try a different search or status filter.' : 'NodePilot will download, configure, and manage a local Minecraft server for you.'}</p>
          {!servers.length && <div className="empty-action-row"><Link to="/servers/new" className="button button-primary"><Icon name="plus" size={18} /> New Minecraft server</Link><Link to="/servers/import" className="button button-secondary"><Icon name="folder" size={18} /> Import existing server</Link></div>}
        </div>
      )}
      {!loading && displayedServers.length > 0 && (
        <div className="servers-grid">
          {displayedServers.map((server) => (
            <div key={server.id} className={actionId === server.id ? 'server-card-wrap is-busy' : 'server-card-wrap'}>
              <ServerCard server={server} onAction={runAction} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
