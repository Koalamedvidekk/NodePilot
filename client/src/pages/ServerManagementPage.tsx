import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, websocketUrl } from '../api';
import { AddonsPanel } from './AddonsPanel';
import { PlayersPanel } from './PlayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { UsagePanel } from './UsagePanel';
import { ServerSettingsPanel } from './ServerSettingsPanel';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { ServerTunnelCard } from '../components/ServerTunnelCard';
import type { ConsoleLine, FileEntry, Server } from '../types';
import { errorMessage, formatBytes, formatDate, relativePath, titleCase } from '../utils';

type ManagementTab = 'overview' | 'usage' | 'console' | 'players' | 'addons' | 'properties' | 'files' | 'settings';

export type AddonCategory = 'plugins' | 'mods' | null;

export function getAddonCategory(software?: string, flavor?: string): AddonCategory {
  const target = (software && software !== 'unknown' ? software : flavor)?.toLowerCase();
  if (!target) return null;
  if (['paper', 'spigot', 'purpur'].includes(target)) return 'plugins';
  if (['forge', 'neoforge', 'fabric', 'quilt'].includes(target)) return 'mods';
  return null;
}

function tabFromPath(pathname: string): ManagementTab {
  if (pathname.endsWith('/usage')) return 'usage';
  if (pathname.endsWith('/console')) return 'console';
  if (pathname.endsWith('/players')) return 'players';
  if (pathname.endsWith('/addons') || pathname.endsWith('/plugins') || pathname.endsWith('/mods')) return 'addons';
  if (pathname.endsWith('/properties')) return 'properties';
  if (pathname.endsWith('/files')) return 'files';
  if (pathname.endsWith('/settings')) return 'settings';
  return 'overview';
}

function parseConsolePayload(payload: unknown): ConsoleLine | undefined {
  if (typeof payload === 'string') {
    try {
      return parseConsolePayload(JSON.parse(payload));
    } catch {
      return { message: payload };
    }
  }
  if (!payload || typeof payload !== 'object') return undefined;
  const raw = payload as Record<string, unknown>;
  if (raw.type === 'log' && raw.line) return parseConsolePayload(raw.line);
  if (raw.type === 'status') {
    const status = typeof raw.status === 'string' ? raw.status : 'unknown';
    const detail = typeof raw.error === 'string' && raw.error ? ` — ${raw.error}` : '';
    return { timestamp: new Date().toISOString(), stream: 'system', message: `Server status: ${status}${detail}` };
  }
  if (typeof raw.message === 'string') {
    return {
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
      stream: typeof raw.stream === 'string' ? raw.stream : undefined,
      message: raw.message,
    };
  }
  return undefined;
}

function ConsolePanel({ server }: { server: Server }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const consoleRef = useRef<HTMLDivElement>(null);

  const append = useCallback((line: ConsoleLine) => {
    setLines((current) => [...current, line].slice(-1000));
  }, []);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    setLines([]);
    setLoading(true);
    setError(undefined);

    void api.logs(server.id)
      .then((entries) => {
        if (active) setLines((current) => current.length ? current : entries);
      })
      .catch((cause) => active && setError(`Couldn’t load console history: ${errorMessage(cause)}`))
      .finally(() => active && setLoading(false));

    function connect() {
      if (!active) return;
      setConnection('connecting');

      try {
        const ws = new WebSocket(websocketUrl(server.id));
        socket = ws;

        ws.onopen = () => {
          if (!active) return;
          setConnection('connected');
        };

        ws.onmessage = (event) => {
          const line = parseConsolePayload(event.data);
          if (active && line) append(line);
        };

        ws.onerror = () => {
          if (!active) return;
          setConnection('disconnected');
        };

        ws.onclose = () => {
          if (!active) return;
          setConnection('disconnected');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (active) connect();
          }, 2500);
        };
      } catch {
        if (active) {
          setConnection('disconnected');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (active) connect();
          }, 2500);
        }
      }
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [append, server.id]);

  useEffect(() => {
    const terminal = consoleRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [lines]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.sendCommand(server.id, value);
      append({ timestamp: new Date().toISOString(), stream: 'system', message: `> ${value}` });
      setCommand('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="management-panel console-panel panel">
      <div className="panel-heading console-heading">
        <div><h3>Live console</h3><p>Output is streamed from this local server.</p></div>
        <span className={`console-connection ${connection}`}><span /> {connection === 'connected' ? 'Live connection' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
      </div>
      {error && <div className="inline-alert alert-error console-alert" role="alert"><Icon name="warning" size={18} /><div><strong>Console request failed.</strong><span>{error}</span></div></div>}
      <div className="terminal-window" ref={consoleRef} aria-live="polite" aria-label="Server console output">
        {loading && <div className="terminal-placeholder">Loading saved console output…</div>}
        {!loading && lines.length === 0 && <div className="terminal-placeholder">No console output yet. Start the server to see its logs here.</div>}
        {lines.map((line, index) => {
          const time = line.timestamp ? new Date(line.timestamp) : undefined;
          const timeLabel = time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          return <div className={`console-line ${line.stream === 'stderr' ? 'is-error' : line.stream === 'system' ? 'is-system' : ''}`} key={`${line.timestamp ?? 'line'}-${index}`}><span className="console-time">{timeLabel}</span><span className="console-message">{line.message}</span></div>;
        })}
      </div>
      <form className="console-command" onSubmit={submit}>
        <span className="command-prompt">›</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={server.status === 'running' ? 'Type a server command, for example: say Hello' : 'Start the server to send commands'} disabled={server.status !== 'running' || sending} aria-label="Server command" />
        <button className="button button-primary command-send" disabled={!command.trim() || server.status !== 'running' || sending} aria-label="Send command"><Icon name="send" size={17} /></button>
      </form>
      {server.status !== 'running' && <p className="input-note console-hint"><Icon name="info" size={14} /> Commands are available while the server is running.</p>}
    </section>
  );
}

const PROTECTED_FILENAMES = new Set(['server.jar', 'eula.txt']);

function isProtectedFile(filename: string): boolean {
  return PROTECTED_FILENAMES.has(filename.toLowerCase());
}

type FileClipboard = {
  action: 'copy' | 'cut';
  path: string;
  name: string;
  type: 'file' | 'directory';
};

type FileModalState =
  | { type: 'new-file'; parentPath: string }
  | { type: 'new-folder'; parentPath: string }
  | { type: 'rename'; file: FileEntry }
  | { type: 'delete'; file: FileEntry }
  | null;

function FilesPanel({ serverId }: { serverId: string }) {
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<{ path: string; content: string }>();
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [activeModal, setActiveModal] = useState<FileModalState>(null);
  const [modalInput, setModalInput] = useState('');
  const [modalError, setModalError] = useState<string>();
  const [modalBusy, setModalBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.files(serverId, path);
      setFiles(result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)));
    } catch (cause) {
      setError(errorMessage(cause));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [path, serverId]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeModal && !modalBusy) {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, modalBusy]);

  const openFile = async (file: FileEntry) => {
    if (file.type === 'directory') {
      setSelected(undefined);
      setPath(file.path);
      return;
    }
    if (file.size !== undefined && file.size > 1_500_000) {
      setError('This file is larger than 1.5 MB and is not opened in the browser editor.');
      return;
    }
    setLoadingContent(true);
    setError(undefined);
    setSaved(false);
    try {
      const content = await api.fileContent(serverId, file.path);
      setSelected({ path: content.path, content: content.content });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingContent(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await api.saveFile(serverId, selected.path, selected.content);
      setSaved(true);
      void loadFiles();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const openModal = (modal: FileModalState) => {
    setActiveModal(modal);
    if (modal?.type === 'rename') {
      setModalInput(modal.file.name);
    } else {
      setModalInput('');
    }
    setModalError(undefined);
  };

  const closeModal = () => {
    setActiveModal(null);
    setModalInput('');
    setModalError(undefined);
  };

  const copyItem = (file: FileEntry) => {
    setClipboard({ action: 'copy', path: file.path, name: file.name, type: file.type });
  };

  const cutItem = (file: FileEntry) => {
    setClipboard({ action: 'cut', path: file.path, name: file.name, type: file.type });
  };

  const clearClipboard = () => {
    setClipboard(null);
  };

  const pasteItem = async () => {
    if (!clipboard || actionBusy) return;
    setActionBusy(true);
    setError(undefined);
    try {
      if (clipboard.action === 'copy') {
        await api.copyFile(serverId, clipboard.path, path);
      } else {
        await api.moveFile(serverId, clipboard.path, path);
        setClipboard(null);
      }
      await loadFiles();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const handleModalSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeModal || modalBusy) return;
    const trimmed = modalInput.trim();
    if (activeModal.type !== 'delete' && !trimmed) {
      setModalError('Please enter a valid name.');
      return;
    }
    setModalBusy(true);
    setModalError(undefined);
    try {
      if (activeModal.type === 'new-file') {
        const created = await api.createFile(serverId, activeModal.parentPath, trimmed);
        closeModal();
        await loadFiles();
        void openFile({
          name: trimmed,
          path: created.path,
          type: 'file',
        });
      } else if (activeModal.type === 'new-folder') {
        await api.createFolder(serverId, activeModal.parentPath, trimmed);
        closeModal();
        await loadFiles();
      } else if (activeModal.type === 'rename') {
        const renamed = await api.renameFile(serverId, activeModal.file.path, trimmed);
        if (selected && selected.path === activeModal.file.path) {
          setSelected({ path: renamed.path, content: selected.content });
        }
        if (clipboard && clipboard.path === activeModal.file.path) {
          setClipboard({ ...clipboard, path: renamed.path, name: trimmed });
        }
        closeModal();
        await loadFiles();
      } else if (activeModal.type === 'delete') {
        await api.deleteFile(serverId, activeModal.file.path);
        if (selected && (selected.path === activeModal.file.path || selected.path.startsWith(`${activeModal.file.path}/`))) {
          setSelected(undefined);
        }
        if (clipboard && (clipboard.path === activeModal.file.path || clipboard.path.startsWith(`${activeModal.file.path}/`))) {
          setClipboard(null);
        }
        closeModal();
        await loadFiles();
      }
    } catch (cause) {
      setModalError(errorMessage(cause));
    } finally {
      setModalBusy(false);
    }
  };

  const crumbs = relativePath(path);
  const goToCrumb = (index: number) => setPath(crumbs.slice(0, index + 1).join('/'));
  const parentPath = crumbs.slice(0, -1).join('/');

  return (
    <section className="management-panel file-manager panel">
      <div className="panel-heading file-heading">
        <div>
          <h3>Server files</h3>
          <p>Browse, manage, and edit text files within this server’s protected directory.</p>
        </div>
        <button className="button button-secondary button-icon" onClick={() => void loadFiles()} disabled={loading}>
          <Icon name="refresh" size={16} /> Refresh
        </button>
      </div>
      {error && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={18} />
          <div><strong>File action failed.</strong><span>{error}</span></div>
        </div>
      )}
      <div className="file-manager-grid">
        <div className="file-browser">
          <div className="file-toolbar">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => openModal({ type: 'new-file', parentPath: path })}
              title="Create new file in this folder"
            >
              <Icon name="plus" size={14} /> New file
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => openModal({ type: 'new-folder', parentPath: path })}
              title="Create new folder in this folder"
            >
              <Icon name="folder" size={14} /> New folder
            </button>
            {clipboard && (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void pasteItem()}
                disabled={actionBusy}
                title={`Paste ${clipboard.name} into ${path ? `/${path}` : 'root'}`}
              >
                <Icon name="clipboard" size={14} /> Paste
              </button>
            )}
          </div>
          {clipboard && (
            <div className="clipboard-banner">
              <div className="clipboard-info">
                <Icon name={clipboard.action === 'cut' ? 'scissors' : 'copy'} size={13} />
                <span>
                  {clipboard.action === 'cut' ? 'Cut' : 'Copied'}: <strong>{clipboard.name}</strong>
                </span>
              </div>
              <button
                type="button"
                className="button-icon-only"
                onClick={clearClipboard}
                title="Cancel clipboard"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
          <div className="breadcrumbs">
            <button type="button" onClick={() => setPath('')} className={!path ? 'is-current' : ''}>root</button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                <Icon name="chevronRight" size={14} />
                <button type="button" onClick={() => goToCrumb(index)} className={index === crumbs.length - 1 ? 'is-current' : ''}>{crumb}</button>
              </span>
            ))}
          </div>
          {path && (
            <button className="back-folder" type="button" onClick={() => { setSelected(undefined); setPath(parentPath); }}>
              <Icon name="arrowLeft" size={16} /> Up one folder
            </button>
          )}
          <div className="file-list" aria-label="Server files">
            {loading && <div className="loading-list"><span className="loading-bar" /><span className="loading-bar" /><span className="loading-bar" /></div>}
            {!loading && files.length === 0 && <div className="empty-inline">This folder is empty.</div>}
            {files.map((file) => {
              const isCut = clipboard?.action === 'cut' && clipboard.path === file.path;
              const protectedEntry = isProtectedFile(file.name);
              return (
                <div
                  className={`file-row ${selected?.path === file.path ? 'is-selected' : ''} ${isCut ? 'is-cut' : ''}`}
                  key={file.path}
                >
                  <button
                    type="button"
                    className="file-main"
                    onClick={() => void openFile(file)}
                    title={file.type === 'directory' ? `Open ${file.name}` : `Edit ${file.name}`}
                  >
                    <Icon name={file.type === 'directory' ? 'folder' : 'file'} size={18} />
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{file.type === 'directory' ? 'Folder' : formatBytes(file.size)}</span>
                    {file.type === 'directory' && <Icon name="chevronRight" size={16} />}
                  </button>
                  <div className="file-actions">
                    <button
                      type="button"
                      className="file-action-btn"
                      title="Copy"
                      onClick={(e) => { e.stopPropagation(); copyItem(file); }}
                    >
                      <Icon name="copy" size={13} />
                    </button>
                    <button
                      type="button"
                      className="file-action-btn"
                      title={protectedEntry ? 'Protected server file cannot be moved' : 'Cut'}
                      disabled={protectedEntry}
                      onClick={(e) => { e.stopPropagation(); cutItem(file); }}
                    >
                      <Icon name="scissors" size={13} />
                    </button>
                    <button
                      type="button"
                      className="file-action-btn"
                      title={protectedEntry ? 'Protected server file cannot be renamed' : 'Rename'}
                      disabled={protectedEntry}
                      onClick={(e) => { e.stopPropagation(); openModal({ type: 'rename', file }); }}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      type="button"
                      className="file-action-btn file-action-danger"
                      title={protectedEntry ? 'Protected server file cannot be deleted' : 'Delete'}
                      disabled={protectedEntry}
                      onClick={(e) => { e.stopPropagation(); openModal({ type: 'delete', file }); }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="file-editor">
          {loadingContent && <div className="editor-empty">Loading <span className="button-loader" /> </div>}
          {!loadingContent && !selected && <div className="editor-empty"><Icon name="files" size={30} /><strong>Select a text file</strong><span>Only files returned from this server directory can be opened.</span></div>}
          {!loadingContent && selected && (
            <>
              <div className="editor-toolbar">
                <div><Icon name="file" size={17} /><strong>{selected.path}</strong></div>
                <div>
                  {saved && <span className="saved-indicator"><Icon name="check" size={16} /> Saved</span>}
                  <button className="button button-primary" type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save file'}</button>
                </div>
              </div>
              <textarea
                spellCheck={false}
                value={selected.content}
                onChange={(event) => { setSelected({ ...selected, content: event.target.value }); setSaved(false); }}
                aria-label={`Edit ${selected.path}`}
              />
            </>
          )}
        </div>
      </div>

      {activeModal && (
        <div className="modal-backdrop" onClick={closeModal} role="presentation">
          <div
            className="modal file-action-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h4 id="file-modal-title">
                {activeModal.type === 'new-file' && 'New File'}
                {activeModal.type === 'new-folder' && 'New Folder'}
                {activeModal.type === 'rename' && `Rename ${activeModal.file.type === 'directory' ? 'Folder' : 'File'}`}
                {activeModal.type === 'delete' && `Delete ${activeModal.file.type === 'directory' ? 'Folder' : 'File'}`}
              </h4>
              <button type="button" className="button-icon-only" onClick={closeModal} aria-label="Close dialog">
                <Icon name="close" size={16} />
              </button>
            </div>
            <form onSubmit={(e) => void handleModalSubmit(e)}>
              <div className="modal-body">
                {activeModal.type === 'delete' ? (
                  <p className="delete-confirm-text">
                    Are you sure you want to delete <strong>{activeModal.file.name}</strong>
                    {activeModal.file.type === 'directory' ? ' and all its contents' : ''}? This action cannot be undone.
                  </p>
                ) : (
                  <label className="form-field">
                    <span className="field-label">
                      {activeModal.type === 'rename' ? 'New name' : activeModal.type === 'new-folder' ? 'Folder name' : 'File name'}
                    </span>
                    <input
                      autoFocus
                      className="input"
                      value={modalInput}
                      onChange={(e) => setModalInput(e.target.value)}
                      placeholder={
                        activeModal.type === 'new-folder'
                          ? 'e.g. world_backups'
                          : 'e.g. config.yml'
                      }
                      disabled={modalBusy}
                    />
                  </label>
                )}
                {modalError && (
                  <div className="inline-alert alert-error" role="alert">
                    <Icon name="warning" size={16} />
                    <span>{modalError}</span>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="button button-secondary" onClick={closeModal} disabled={modalBusy}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`button ${activeModal.type === 'delete' ? 'button-danger' : 'button-primary'}`}
                  disabled={modalBusy || (activeModal.type !== 'delete' && !modalInput.trim())}
                >
                  {modalBusy
                    ? 'Working…'
                    : activeModal.type === 'delete'
                      ? 'Delete permanently'
                      : activeModal.type === 'rename'
                        ? 'Rename'
                        : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

function MemoryAllocationControl({ server, onSave, actionBusy }: { server: Server; onSave: (memoryMb: number) => Promise<Server>; actionBusy: boolean }) {
  const currentMemory = server.memoryMb ?? 2_048;
  const [memoryMb, setMemoryMb] = useState(String(currentMemory));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const editable = server.status === 'stopped';
  const parsedMemory = Number(memoryMb);
  const validMemory = Number.isInteger(parsedMemory) && parsedMemory >= 256 && parsedMemory <= 65_536;

  useEffect(() => {
    setMemoryMb(String(currentMemory));
    setError(undefined);
    setSaved(false);
  }, [currentMemory, server.id]);

  const changeMemory = (value: string) => {
    setMemoryMb(value.replace(/[^0-9]/g, ''));
    setError(undefined);
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editable || saving || actionBusy) return;
    if (!validMemory) {
      setError('Choose a whole number between 256 MB and 65,536 MB.');
      return;
    }
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await onSave(parsedMemory);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (server.software === 'bedrock') {
    return (
      <div className="memory-allocation">
        <div className="memory-allocation-copy">
          <strong>Memory management</strong>
          <p>Bedrock Dedicated Server is a native C++ binary that manages memory dynamically without a Java heap.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-allocation">
      <div className="memory-allocation-copy">
        <strong>Maximum memory</strong>
        <p>Java can grow up to this limit. NodePilot starts with a smaller heap while the server is idle.</p>
      </div>
      {editable ? (
        <form className="memory-allocation-form" onSubmit={(event) => void submit(event)}>
          <div className="memory-presets" aria-label="Memory presets">
            {[1_024, 1_536, 2_048, 2_560].map((preset) => <button className={parsedMemory === preset ? 'is-selected' : ''} type="button" key={preset} onClick={() => changeMemory(String(preset))} disabled={saving || actionBusy}>{preset >= 1_024 ? `${preset / 1_024} GB` : `${preset} MB`}</button>)}
          </div>
          <label className="memory-input"><span className="sr-only">Maximum memory in megabytes</span><input inputMode="numeric" value={memoryMb} onChange={(event) => changeMemory(event.target.value)} aria-describedby="memory-help" disabled={saving || actionBusy} /><span>MB</span></label>
          <button className="button button-secondary" type="submit" disabled={saving || actionBusy || !validMemory || parsedMemory === currentMemory}>{saving ? 'Saving…' : 'Save memory'}</button>
          <p className="input-note" id="memory-help">Choose 1–2.5 GB for a small, lightly used server. The new limit applies on its next start.</p>
          {saved && <p className="memory-feedback success"><Icon name="check" size={15} /> Maximum memory saved.</p>}
          {error && <p className="memory-feedback error" role="alert"><Icon name="warning" size={15} /> {error}</p>}
        </form>
      ) : (
        <p className="memory-locked"><Icon name="info" size={15} /> Stop the server to change its maximum memory.</p>
      )}
    </div>
  );
}

function OverviewPanel({ server, onAction, onMemorySave, actionBusy }: { server: Server; onAction: (action: 'start' | 'stop' | 'restart') => void; onMemorySave: (memoryMb: number) => Promise<Server>; actionBusy: boolean }) {
  const canStart = server.status === 'stopped' || server.status === 'error' || server.status === 'unknown';
  const canStop = server.status === 'running' || server.status === 'starting';
  return (
    <div className="overview-grid">
      <ServerTunnelCard server={server} />
      <section className="panel overview-card runtime-card">
        <div className="panel-heading"><div><h3>Runtime</h3><p>Local process controls</p></div><StatusBadge status={server.status} directoryMissing={server.directoryExists === false} /></div>
        <div className="runtime-status-art"><div className={`status-orb status-${server.status}`}><Icon name={server.status === 'running' ? 'activity' : 'server'} size={29} /></div><div><strong>{server.directoryExists === false ? 'Server files missing' : server.status === 'running' ? 'Server is online' : server.status === 'installing' ? 'Preparing server files' : 'Server is offline'}</strong><p>{server.directoryExists === false ? 'The server directory was deleted from disk.' : server.status === 'running' ? `Listening locally on port ${server.port ?? '—'}.` : server.error ?? 'Start it when you are ready.'}</p></div></div>
        <div className="lifecycle-buttons">
          {canStart && <button className="button button-primary" type="button" onClick={() => onAction('start')} disabled={actionBusy || server.status === 'installing' || server.directoryExists === false} title={server.directoryExists === false ? 'Server directory does not exist on disk' : undefined}><Icon name="play" size={17} /> Start server</button>}
          {canStop && <button className="button button-danger" type="button" onClick={() => onAction('stop')} disabled={actionBusy}><Icon name="square" size={15} /> Stop server</button>}
          <button className="button button-secondary" type="button" onClick={() => onAction('restart')} disabled={actionBusy || server.status !== 'running'}><Icon name="refresh" size={16} /> Restart</button>
        </div>
      </section>
      <section className="panel overview-card details-card">
        <div className="panel-heading"><div><h3>Server details</h3><p>Persisted local configuration</p></div></div>
        <dl className="detail-list"><div><dt>Software</dt><dd>{titleCase(server.software ?? server.distribution)}</dd></div><div><dt>Version</dt><dd>{server.version ?? '—'}</dd></div><div><dt>Port</dt><dd>{server.port ?? '—'}</dd></div><div><dt>Maximum memory</dt><dd>{server.software === 'bedrock' ? 'Native process' : server.memoryMb ? `${server.memoryMb} MB` : 'Default'}</dd></div><div><dt>Required Java</dt><dd>{server.software === 'bedrock' ? 'None (Native binary)' : server.requiredJavaMajor ? `Java ${server.requiredJavaMajor}+` : 'Detected on start'}</dd></div><div><dt>Install state</dt><dd>{titleCase(server.installState)}</dd></div><div className="detail-wide"><dt>Directory</dt><dd><code>{server.directory ?? '—'}</code></dd></div></dl>
        <MemoryAllocationControl server={server} onSave={onMemorySave} actionBusy={actionBusy} />
      </section>
      <section className="panel overview-card activity-card">
        <div className="panel-heading"><div><h3>Activity</h3><p>Recent server lifecycle</p></div></div>
        <dl className="activity-list"><div><span className="activity-dot active" /><div><strong>Created</strong><small>{formatDate(server.createdAt)}</small></div></div><div><span className="activity-dot" /><div><strong>Last started</strong><small>{formatDate(server.lastStartedAt)}</small></div></div><div><span className="activity-dot" /><div><strong>Last stopped</strong><small>{formatDate(server.lastStoppedAt)}</small></div></div></dl>
      </section>
    </div>
  );
}

export function ServerManagementPage() {
  const { serverId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [server, setServer] = useState<Server>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tab = tabFromPath(location.pathname);
  const base = `/servers/${encodeURIComponent(serverId)}`;

  const load = useCallback(async () => {
    if (!serverId) return;
    try {
      setError(undefined);
      setServer(await api.server(serverId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (action: 'start' | 'stop' | 'restart') => {
    if (!server) return;
    setActionBusy(true);
    setError(undefined);
    try {
      const updated = await api.lifecycle(server.id, action);
      setServer((current) => current ? { ...current, ...updated } : updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const saveMemory = async (memoryMb: number): Promise<Server> => {
    if (!server) throw new Error('The server is no longer available.');
    const updated = await api.updateServer(server.id, { memoryMb });
    setServer((current) => current?.id === updated.id ? { ...current, ...updated } : updated);
    return updated;
  };

  const remove = async () => {
    if (!server || !window.confirm(`Delete “${server.name}” and its local server files? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteServer(server.id);
      navigate('/servers');
    } catch (cause) {
      setError(errorMessage(cause));
      setDeleting(false);
    }
  };

  if (loading && !server) return <section className="management-page page-enter"><div className="management-loading panel"><span className="button-loader" /> Loading local server…</div></section>;
  if (!server) return <section className="management-page page-enter"><div className="empty-state panel large-empty"><div className="empty-icon"><Icon name="warning" size={29} /></div><h3>Server unavailable</h3><p>{error ?? 'This server no longer exists on the local NodePilot host.'}</p><Link className="button button-primary" to="/servers">Back to servers</Link></div></section>;

  const addonCategory = getAddonCategory(server.software, server.distribution);
  const addonTab = addonCategory === 'plugins'
    ? { tab: 'addons' as const, label: 'Plugins', icon: 'box' as const, to: `${base}/plugins` }
    : addonCategory === 'mods'
      ? { tab: 'addons' as const, label: 'Mods', icon: 'box' as const, to: `${base}/mods` }
      : null;

  const tabs: Array<{ tab: ManagementTab; label: string; icon: 'dashboard' | 'activity' | 'terminal' | 'users' | 'box' | 'settings' | 'files' | 'sliders'; to: string }> = [
    { tab: 'overview', label: 'Overview', icon: 'dashboard', to: base },
    { tab: 'usage', label: 'Usage', icon: 'activity', to: `${base}/usage` },
    { tab: 'console', label: 'Console', icon: 'terminal', to: `${base}/console` },
    { tab: 'players', label: 'Players', icon: 'users', to: `${base}/players` },
    ...(addonTab ? [addonTab] : []),
    { tab: 'properties', label: 'Properties', icon: 'sliders', to: `${base}/properties` },
    { tab: 'files', label: 'Files', icon: 'files', to: `${base}/files` },
    { tab: 'settings', label: 'Settings', icon: 'settings', to: `${base}/settings` },
  ];

  return (
    <section className="management-page page-enter">
      <div className="management-backrow"><Link to="/servers" className="back-link"><Icon name="arrowLeft" size={17} /> All servers</Link><button className="button button-ghost refresh-server" type="button" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16} /> Refresh</button></div>
      <div className="management-title-row">
        <div className="server-identity"><div className="server-identity-icon"><Icon name="box" size={28} /></div><div><p className="eyebrow">{titleCase(server.software ?? server.distribution)} · {server.software === 'bedrock' || server.game === 'minecraft-bedrock' ? 'MINECRAFT BEDROCK' : 'MINECRAFT JAVA'}</p><h2>{server.name}</h2><span>Port {server.port ?? '—'} <i /> {server.version ?? 'Unknown version'}</span></div></div>
        <div className="management-header-actions"><StatusBadge status={server.status} directoryMissing={server.directoryExists === false} /><button className="button button-danger-outline" type="button" onClick={() => void remove()} disabled={deleting || actionBusy}>{deleting ? 'Deleting…' : <><Icon name="trash" size={16} /> Delete</>}</button></div>
      </div>
      {server.directoryExists === false && (
        <div className="inline-alert alert-error" role="alert">
          <Icon name="warning" size={19} />
          <div>
            <strong>Server folder not found.</strong>
            <span>The server folder in <code>.nodepilot/servers/{server.directory}</code> does not exist on disk. You can safely delete this server from NodePilot.</span>
          </div>
        </div>
      )}
      {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={19} /><div><strong>NodePilot couldn’t complete that action.</strong><span>{error}</span></div><button className="text-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
      {server.status === 'installing' && <div className="inline-alert alert-info"><Icon name="info" size={19} /><div><strong>Your server is being prepared.</strong><span>NodePilot is downloading and configuring files. This page refreshes automatically.</span></div></div>}

      <nav className="management-tabs" aria-label="Server management">
        {tabs.map((item) => <NavLink key={item.tab} to={item.to} end={item.tab === 'overview'} className={tab === item.tab ? 'is-active' : ''}><Icon name={item.icon} size={17} /> {item.label}</NavLink>)}
      </nav>

      {tab === 'overview' && <OverviewPanel server={server} onAction={act} onMemorySave={saveMemory} actionBusy={actionBusy} />}
      {tab === 'usage' && <UsagePanel server={server} />}
      {tab === 'console' && <ConsolePanel server={server} />}
      {tab === 'players' && <PlayersPanel server={server} />}
      {tab === 'addons' && (
        addonCategory ? (
          <AddonsPanel server={server} />
        ) : server.software === 'bedrock' ? (
          <section className="management-panel panel">
            <div className="panel-heading">
              <div>
                <h3>Bedrock Add-ons</h3>
                <p>Bedrock Dedicated Server uses behavior packs and resource packs. Place them in your server’s <code>behavior_packs</code> and <code>resource_packs</code> folders via the Files tab.</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="management-panel panel">
            <div className="panel-heading">
              <div>
                <h3>Add-ons not supported</h3>
                <p>Vanilla Minecraft servers do not support mods or plugins.</p>
              </div>
            </div>
          </section>
        )
      )}
      {tab === 'properties' && <PropertiesPanel serverId={server.id} />}
      {tab === 'files' && <FilesPanel serverId={server.id} />}
      {tab === 'settings' && (
        <ServerSettingsPanel
          server={server}
          onServerUpdated={load}
          onNavigateToTab={(target) => navigate(`${base}/${target}`)}
        />
      )}
    </section>
  );
}
