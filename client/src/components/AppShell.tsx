import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../api';
import { Icon, type IconName } from './Icon';
import { NetworkModal } from './NetworkModal';
import { PinModal } from './PinModal';
import type { AuthStatus, NetworkInfo } from '../types';

interface NavigationItem {
  label: string;
  to: string;
  icon: IconName;
  end?: boolean;
}

const primaryNav: NavigationItem[] = [
  { label: 'Overview', to: '/', icon: 'dashboard', end: true },
  { label: 'Servers', to: '/servers', icon: 'server', end: true },
  { label: 'Host Settings', to: '/settings', icon: 'settings', end: true },
];

function NavItem({ item, onClick }: { item: NavigationItem; onClick?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
    >
      <Icon name={item.icon} size={19} />
      <span>{item.label}</span>
    </NavLink>
  );
}

const bottomNavItems: Array<{ label: string; to: string; icon: IconName; isPrimary?: boolean; end?: boolean }> = [
  { label: 'Overview', to: '/', icon: 'dashboard', end: true },
  { label: 'Servers', to: '/servers', icon: 'server', end: true },
  { label: 'New', to: '/servers/new', icon: 'plus', isPrimary: true },
  { label: 'Settings', to: '/settings', icon: 'settings', end: true },
];

function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Overview';
  if (pathname === '/servers') return 'Servers';
  if (pathname === '/servers/new') return 'Create server';
  if (pathname === '/servers/import') return 'Import server';
  if (pathname === '/settings') return 'Host Settings & Startup';
  return 'Server management';
}

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const location = useLocation();

  const loadNetworkAndAuth = useCallback(async () => {
    try {
      const [net, authState] = await Promise.all([api.network(), api.authStatus()]);
      setNetwork(net);
      setAuth(authState);
    } catch {
      // Offline or network error
    }
  }, []);

  useEffect(() => {
    void loadNetworkAndAuth();
  }, [loadNetworkAndAuth]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const displayIp = network?.isNetworkVisible && network.addresses.length > 0
    ? network.addresses[0]
    : '127.0.0.1';

  return (
    <div className="app-shell">
      {auth?.hasPin && !auth.authenticated && (
        <PinModal onSuccess={() => void loadNetworkAndAuth()} />
      )}

      {networkModalOpen && network && (
        <NetworkModal
          network={network}
          onClose={() => setNetworkModalOpen(false)}
          onRefresh={() => void loadNetworkAndAuth()}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="box" size={23} /></div>
          <div>
            <span className="brand-name">NodePilot</span>
            <span className="brand-caption">{network?.isNetworkVisible ? 'LAN CONTROL PLANE' : 'LOCAL CONTROL PLANE'}</span>
          </div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <nav className="sidebar-nav">
          <p className="nav-label">Workspace</p>
          {primaryNav.map((item) => <NavItem key={item.to} item={item} onClick={() => setSidebarOpen(false)} />)}

          <p className="nav-label nav-label-spaced">Quick action</p>
          <NavLink to="/servers/new" className="new-server-link" onClick={() => setSidebarOpen(false)}>
            <Icon name="plus" size={18} />
            New server
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="local-host-card is-clickable"
            onClick={() => setNetworkModalOpen(true)}
            title="Click to view network and remote control settings"
          >
            <span className={`host-pulse ${network?.requiresRestart ? 'is-warning' : (network?.isNetworkVisible ? 'is-lan' : '')}`} />
            <div>
              <strong>{network?.requiresRestart ? 'Restart needed' : (network?.isNetworkVisible ? 'LAN host' : 'Local host')}</strong>
              <span>{displayIp}:{network?.port ?? 7420}</span>
            </div>
          </button>
          <p>
            {network?.requiresRestart
              ? 'Restart in terminal (npm start) to apply.'
              : (network?.isNetworkVisible
                ? 'Visible on local network. Click to manage.'
                : 'Local PC only. Click to make visible on LAN.')}
          </p>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="topbar-title">
            <span className="eyebrow">{network?.isNetworkVisible ? 'NODEPILOT / LAN' : 'NODEPILOT / LOCAL'}</span>
            <h1>{titleForPath(location.pathname)}</h1>
          </div>
          <div className="topbar-status">
            <button
              type="button"
              className={`connection-indicator is-button ${network?.requiresRestart ? 'is-warning' : (network?.isNetworkVisible ? 'is-lan' : '')}`}
              onClick={() => setNetworkModalOpen(true)}
              title={network?.requiresRestart ? 'Restart in terminal (npm start) to apply changes' : 'Click to view network access URLs'}
            >
              {network?.requiresRestart ? <Icon name="warning" size={13} /> : (network?.isNetworkVisible ? <Icon name="wifi" size={13} /> : <span />)}
              <span className="connection-text-desktop">
                {network?.requiresRestart ? 'Restart needed' : (network?.isNetworkVisible ? 'LAN mode' : 'Local mode')}
              </span>
              <span className="connection-text-mobile">
                {network?.requiresRestart ? 'Restart' : (network?.isNetworkVisible ? 'LAN' : 'Local')}
              </span>
            </button>
          </div>
        </header>

        <div className="content-area">{children}</div>

        <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
          {bottomNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `mobile-nav-link ${isActive ? 'is-active' : ''} ${item.isPrimary ? 'is-primary' : ''}`}
            >
              <span className="mobile-nav-icon">
                <Icon name={item.icon} size={item.isPrimary ? 21 : 19} />
              </span>
              <span className="mobile-nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </main>
    </div>
  );
}
