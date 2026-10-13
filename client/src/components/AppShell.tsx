import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

interface NavigationItem {
  label: string;
  to: string;
  icon: IconName;
  end?: boolean;
}

const primaryNav: NavigationItem[] = [
  { label: 'Overview', to: '/', icon: 'dashboard', end: true },
  { label: 'Servers', to: '/servers', icon: 'server', end: true },
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

function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Overview';
  if (pathname === '/servers') return 'Servers';
  if (pathname === '/servers/new') return 'Create server';
  if (pathname === '/servers/import') return 'Import server';
  return 'Server management';
}

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="box" size={23} /></div>
          <div>
            <span className="brand-name">NodePilot</span>
            <span className="brand-caption">LOCAL CONTROL PLANE</span>
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
          <div className="local-host-card">
            <span className="host-pulse" />
            <div>
              <strong>Local host</strong>
              <span>127.0.0.1</span>
            </div>
          </div>
          <p>NodePilot runs entirely on this machine.</p>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="topbar-title">
            <span className="eyebrow">NODEPILOT / LOCAL</span>
            <h1>{titleForPath(location.pathname)}</h1>
          </div>
          <div className="topbar-status">
            <span className="connection-indicator"><span /> Local mode</span>
          </div>
        </header>
        <div className="content-area">{children}</div>
      </main>
    </div>
  );
}
