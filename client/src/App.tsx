import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { CreateServerPage } from './pages/CreateServerPage';
import { DashboardPage } from './pages/DashboardPage';
import { ImportServerPage } from './pages/ImportServerPage';
import { ServerManagementPage } from './pages/ServerManagementPage';
import { ServersPage } from './pages/ServersPage';

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('NodePilot interface error', error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="app-error-state">
          <div className="brand-mark">N</div>
          <h1>NodePilot needs a refresh</h1>
          <p>The interface hit an unexpected error. Your local servers have not been changed.</p>
          <button className="button button-primary" onClick={() => window.location.reload()}>Reload NodePilot</button>
        </main>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <AppErrorBoundary>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/servers/new" element={<CreateServerPage />} />
          <Route path="/servers/import" element={<ImportServerPage />} />
          <Route path="/servers/:serverId/*" element={<ServerManagementPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AppErrorBoundary>
  );
}
