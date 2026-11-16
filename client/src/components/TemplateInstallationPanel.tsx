import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TemplateInstallation } from '../types';
import { errorMessage, formatBytes } from '../utils';

export function TemplateInstallationPanel({ serverId }: { serverId: string }) {
  const [operation, setOperation] = useState<TemplateInstallation | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const result = await api.templateInstallation(serverId); if (!active) return; setOperation(result); setError(undefined); if (result?.state === 'running') timer = setTimeout(() => void load(), 1000); }
      catch (cause) { if (active) setError(errorMessage(cause)); }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [serverId, busy]);
  if (!operation || operation.state === 'succeeded') return null;
  const act = async (action: 'retry' | 'cancel') => {
    setBusy(true); setError(undefined);
    try { setOperation(await api.templateInstallationAction(serverId, action)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const downloading = operation.phase.startsWith('Downloading');
  return <section className="panel bundle-installation" aria-label="Template installation">
    <strong>Template installation</strong><p role="status">{operation.phase}</p>
    {operation.state === 'running' && <progress aria-label="Template download progress" max={operation.totalBytes || 1} {...(downloading ? { value: operation.downloadedBytes } : {})} />}
    <p className="input-note">{operation.completedFiles}/{operation.totalFiles} add-ons verified · {formatBytes(operation.downloadedBytes)} / {formatBytes(operation.totalBytes)}. Minecraft stays stopped.</p>
    {(error || operation.error) && <p role="alert">{error ?? operation.error}</p>}
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => void act(operation.state === 'running' ? 'cancel' : 'retry')}>{busy ? 'Working…' : operation.state === 'running' ? 'Cancel installation' : 'Retry installation'}</button>
  </section>;
}
