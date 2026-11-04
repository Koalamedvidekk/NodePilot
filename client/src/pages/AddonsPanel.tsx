import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { ApiError, api } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { AddonCatalogResult, AddonList, AddonMutationResult, AddonType, AddonUpdate, PendingAddonChange, Server } from '../types';
import { errorMessage, formatBytes, formatDate, titleCase } from '../utils';

function updateKey(type: AddonType, fileName: string): string {
  return `${type}:${fileName.toLowerCase()}`;
}

function queuedLabel(action: PendingAddonChange['action']): string {
  return action === 'remove' ? 'Removal queued' : action === 'update' ? 'Update queued' : 'Install queued';
}

function savedMessage(result: AddonMutationResult, name: string, action: 'installed' | 'uploaded' | 'updated' | 'removed'): string {
  return result.queued
    ? `${name}: ${queuedLabel(result.pendingChange?.action ?? (action === 'removed' ? 'remove' : action === 'updated' ? 'update' : 'install')).toLowerCase()} for the next server start or restart. Current JAR files have not changed.`
    : `${name} was ${action} on disk.${action === 'removed' ? ' A backup was saved.' : ''} It takes effect when the server next starts.`;
}

function missingDependencyIds(cause: unknown): string[] {
  if (!(cause instanceof ApiError) || !cause.details || typeof cause.details !== 'object') return [];
  const response = cause.details as { details?: { missingDependencies?: unknown } };
  const dependencies = response.details?.missingDependencies;
  return Array.isArray(dependencies) ? dependencies.filter((item): item is string => typeof item === 'string') : [];
}

export function AddonsPanel({ server }: { server: Server }) {
  const serverSoftware = (server.software && server.software !== 'unknown' ? server.software : server.distribution)?.toLowerCase();
  const isPluginServer = ['paper', 'spigot', 'purpur'].includes(serverSoftware ?? '');
  const [type, setType] = useState<AddonType>(isPluginServer ? 'plugin' : 'mod');
  const [data, setData] = useState<AddonList>();
  const [updates, setUpdates] = useState<AddonUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'modrinth' | 'hangar'>('modrinth');
  const [results, setResults] = useState<AddonCatalogResult[]>([]);
  const [searching, setSearching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const loadInFlight = useRef(false);

  const load = useCallback(async (silent = false, force = false) => {
    if (silent && loadInFlight.current && !force) return;
    loadInFlight.current = true;
    const sequence = ++loadSequence.current;
    if (!silent) { setLoading(true); setError(undefined); }
    try {
      const next = await api.addons(server.id);
      if (sequence === loadSequence.current) setData(next);
    } catch (cause) {
      if (sequence === loadSequence.current) setError(errorMessage(cause));
    } finally {
      if (sequence === loadSequence.current) { loadInFlight.current = false; setLoading(false); }
    }
  }, [server.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { void load(true); }, [load, server.status]);

  useEffect(() => {
    if (!data?.pendingChanges?.length && data?.capabilities.canMutate !== false) return;
    const timer = setInterval(() => { if (!busy) void load(true); }, 3_000);
    return () => clearInterval(timer);
  }, [busy, data?.pendingChanges?.length, data?.capabilities.canMutate, load]);

  useEffect(() => {
    if (type === 'mod') setSource('modrinth');
    setResults([]); setUpdates([]); setQuery('');
  }, [server.id, type]);

  useEffect(() => {
    if (!data) return;
    if (data.capabilities.plugins && !data.capabilities.mods && type !== 'plugin') {
      setType('plugin');
    } else if (data.capabilities.mods && !data.capabilities.plugins && type !== 'mod') {
      setType('mod');
    }
  }, [data, type]);

  const hasDualSupport = Boolean(data?.capabilities.plugins && data?.capabilities.mods);
  const supported = type === 'plugin' ? data?.capabilities.plugins : data?.capabilities.mods;
  const unavailableMessage = type === 'plugin' ? data?.capabilities.pluginMessage : data?.capabilities.modMessage;
  const installed = type === 'plugin' ? data?.plugins ?? [] : data?.mods ?? [];
  const updateByFile = new Map(updates.map((update) => [updateKey(update.type, update.fileName), update]));
  const pending = data?.pendingChanges ?? [];
  const stopped = server.status === 'stopped' || server.status === 'error';
  const stableState = stopped || server.status === 'running';
  const canMutate = stableState && data?.capabilities.canMutate !== false && (!server.installState || server.installState === 'ready');
  const queuedMode = !stopped || pending.length > 0;
  const pendingForFile = (fileName: string) => pending.find(change => change.type === type && [change.fileName, change.originalFileName].some(name => name && updateKey(type, name) === updateKey(type, fileName)));
  const mutationMessage = data?.capabilities.mutationMessage ?? (!stableState ? `Wait until the server finishes ${server.status === 'starting' ? 'starting' : server.status === 'stopping' ? 'stopping' : 'its current operation'} before changing add-ons.` : server.installState && server.installState !== 'ready' ? 'Finish or repair the server installation before changing add-ons.' : data?.capabilities.canMutate === false ? 'Wait for the current add-on or server maintenance operation to finish.' : undefined);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || !supported) return;
    setSearching(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setResults(await api.searchAddons(server.id, type, source, normalized));
    } catch (cause) {
      setResults([]);
      setError(errorMessage(cause));
    } finally {
      setSearching(false);
    }
  };

  const install = async (result: AddonCatalogResult) => {
    if (!canMutate || busy || !result.compatible || !supported) return;
    setBusy(`install:${result.projectId}`);
    setError(undefined);
    setNotice(undefined);
    try {
      let response: AddonMutationResult;
      if (result.source === 'hangar') {
        response = await api.installHangarAddon(server.id, result.projectId);
      } else {
        try {
          response = await api.installModrinthAddon(server.id, type, result.projectId);
        } catch (cause) {
          const dependencies = missingDependencyIds(cause);
          if (!dependencies.length || !window.confirm(`This add-on requires ${dependencies.length} ${dependencies.length === 1 ? 'dependency' : 'dependencies'} that NodePilot cannot find locally. Install it anyway?\n\n${dependencies.join('\n')}`)) throw cause;
          response = await api.installModrinthAddon(server.id, type, result.projectId, true);
        }
      }
      setNotice(savedMessage(response, result.title, 'installed'));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true, true);
    } finally {
      setBusy(undefined);
    }
  };

  const chooseUpload = () => {
    if (canMutate && supported && !busy) fileInput.current?.click();
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.jar$/i.test(file.name)) {
      setError('Choose a .jar plugin or mod file.');
      return;
    }
    if (!canMutate || busy || !supported) return;
    setBusy('upload');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api.uploadAddon(server.id, type, file);
      setNotice(savedMessage(response, file.name, 'uploaded'));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true, true);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (fileName: string) => {
    if (!canMutate || busy || pendingForFile(fileName) || !window.confirm(queuedMode
      ? `Queue removal of ${fileName}? The current JAR stays in place until the next server start or restart. NodePilot will back it up before removal.`
      : `Remove ${fileName}? NodePilot will back up the current JAR before deleting it.`)) return;
    setBusy(`remove:${fileName}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api.removeAddon(server.id, type, fileName);
      setNotice(savedMessage(response, fileName, 'removed'));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true, true);
    } finally {
      setBusy(undefined);
    }
  };

  const checkUpdates = async () => {
    setCheckingUpdates(true);
    setError(undefined);
    try {
      const next = await api.addonUpdates(server.id);
      setUpdates(next);
      const count = next.filter((update) => update.available).length;
      setNotice(count ? `${count} catalogue update${count === 1 ? '' : 's'} available.` : 'No catalogue updates are available.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const update = async (fileName: string) => {
    if (!canMutate || busy || pendingForFile(fileName) || !window.confirm(queuedMode
      ? `Queue an update for ${fileName}? The current JAR stays in place until the next server start or restart. NodePilot will back it up before applying the update.`
      : `Update ${fileName}? NodePilot will back up the current JAR first.`)) return;
    setBusy(`update:${fileName}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api.updateAddon(server.id, type, fileName);
      setNotice(savedMessage(response, fileName, 'updated'));
      setUpdates(current => current.filter(entry => updateKey(entry.type, entry.fileName) !== updateKey(type, fileName)));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      await load(true, true);
    } finally {
      setBusy(undefined);
    }
  };

  const cancelPending = async (change: PendingAddonChange) => {
    if (!canMutate || busy) return;
    setBusy(`cancel:${change.id}`); setError(undefined); setNotice(undefined);
    try {
      await api.cancelPendingAddon(server.id, change.id);
      setNotice(`Cancelled the queued ${change.action === 'remove' ? 'removal' : change.action} for ${change.name ?? change.fileName}. Current JAR files were not changed.`);
      await load();
    } catch (cause) { setError(errorMessage(cause)); await load(true, true); }
    finally { setBusy(undefined); }
  };

  return <section className="addons-panel panel management-panel">
    <div className="panel-heading addons-heading">
      <div>
        <p className="eyebrow">{type === 'plugin' ? 'PLUGIN MANAGER' : type === 'mod' ? 'MOD MANAGER' : 'ADD-ON MANAGER'}</p>
        <h3>{type === 'plugin' ? 'Plugins' : type === 'mod' ? 'Mods' : 'Plugins & mods'}</h3>
        <p>{type === 'plugin' ? 'Only compatible Paper/Bukkit plugin JARs are installed. Existing files are backed up before replacement or removal.' : type === 'mod' ? `Only compatible ${titleCase(server.software)} mod JARs are installed. Existing files are backed up before replacement or removal.` : 'Only compatible JARs are installed. Existing files are backed up before replacement or removal.'}</p>
      </div>
      <div className="panel-heading-actions"><button className="button button-secondary button-icon" type="button" onClick={() => void checkUpdates()} disabled={checkingUpdates || Boolean(busy)}><Icon name="refresh" size={16} /> {checkingUpdates ? 'Checking...' : 'Check updates'}</button><button className="button button-secondary button-icon" type="button" onClick={() => void load()} disabled={loading || Boolean(busy)}><Icon name="refresh" size={16} /> Refresh</button></div>
    </div>
    {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><div><strong>Add-on action failed.</strong><span>{error}</span></div><button type="button" className="text-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    {notice && <div className="inline-alert alert-info" role="status"><Icon name="info" size={18} /><div><strong>Add-on status.</strong><span>{notice}</span></div><button type="button" className="text-button" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
    {!canMutate && mutationMessage && <div className="inline-alert alert-info"><Icon name="info" size={18} /><div><strong>Add-on changes are temporarily unavailable.</strong><span>{mutationMessage}</span></div></div>}
    {stableState && !stopped && <div className="inline-alert alert-info"><Icon name="info" size={18} /><div><strong>Changes apply on the next start or restart.</strong><span>Install, upload, update, or remove add-ons while the server runs. NodePilot keeps the current JAR files unchanged and applies the queue before the next server start.</span></div></div>}
    {data?.pendingError && <div className="inline-alert alert-error addon-pending-error" role="alert"><Icon name="warning" size={18} /><div><strong>Pending changes need attention.</strong><span>{data.pendingError}</span><span>Review this error before retrying a server start or cancelling a pending change.</span></div></div>}
    {pending.length > 0 && <section className="addon-pending-card" aria-labelledby="addon-pending-heading">
      <div className="addon-card-title"><div><h4 id="addon-pending-heading">Pending changes <span className="addon-pending-count">{pending.length}</span></h4><p>{stopped ? 'These changes are saved for the next start. Further changes join the same queue.' : 'These changes will apply before the next server start or restart.'} Backups are made before replacing or removing installed JARs.</p></div></div>
      <div className="addon-pending-list">{pending.map(change => <article className="addon-pending-row" key={change.id}>
        <div className="addon-file-icon"><Icon name={change.action === 'remove' ? 'trash' : 'box'} size={18} /></div>
        <div className="addon-pending-copy"><strong>{change.name || change.fileName}</strong><span><span className={`addon-pending-badge is-${change.action}`}>{queuedLabel(change.action)}</span> {titleCase(change.type)}{change.version ? ` · v${change.version}` : ''}</span><small>{change.originalFileName && change.originalFileName !== change.fileName ? `${change.originalFileName} → ${change.fileName}` : change.fileName}</small><small>Queued {formatDate(change.createdAt)} · {titleCase(change.source)}</small>{change.error && change.error !== data?.pendingError && <em>{change.error}</em>}</div>
        <button className="button button-secondary" type="button" onClick={() => void cancelPending(change)} disabled={!canMutate || Boolean(busy)} aria-label={`Cancel queued ${change.action === 'remove' ? 'removal' : change.action} of ${change.name || change.fileName}`}>{busy === `cancel:${change.id}` ? 'Cancelling...' : 'Cancel change'}</button>
      </article>)}</div>
    </section>}
    {hasDualSupport && (
      <div className="addon-type-tabs" role="tablist" aria-label="Add-on type">
        <button type="button" role="tab" aria-selected={type === 'plugin'} className={type === 'plugin' ? 'is-selected' : ''} onClick={() => setType('plugin')}>Plugins</button>
        <button type="button" role="tab" aria-selected={type === 'mod'} className={type === 'mod' ? 'is-selected' : ''} onClick={() => setType('mod')}>Mods</button>
      </div>
    )}
    {loading ? <div className="addon-loading"><span className="loading-bar" /><span className="loading-bar" /></div> : <>
      {!supported && <div className="addon-capability-note"><Icon name="circleHelp" size={18} /><div><strong>{type === 'plugin' ? 'Plugins are unavailable' : 'Mods are unavailable'}</strong><span>{unavailableMessage ?? 'NodePilot could not confirm this server supports this add-on type.'}</span></div></div>}
      <div className="addon-sections">
        <div className="addon-install-card">
          <div className="addon-card-title"><div><h4>Find {type === 'plugin' ? 'plugins' : 'mods'}</h4><p>Search official catalogue APIs for this server version and software.</p></div><button className="button button-secondary" type="button" onClick={chooseUpload} disabled={!canMutate || !supported || Boolean(busy)}><Icon name="plus" size={16} /> {type === 'plugin' ? 'Upload plugin JAR' : 'Upload mod JAR'}</button><input className="sr-only" ref={fileInput} type="file" accept=".jar,application/java-archive" aria-label={type === 'plugin' ? 'Plugin JAR file' : 'Mod JAR file'} disabled={!canMutate || !supported || Boolean(busy)} onChange={(event) => void upload(event)} /></div>
          <form className="addon-search" onSubmit={(event) => void search(event)}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} disabled={!supported || searching} placeholder={`Search ${type === 'plugin' ? 'Paper plugins' : `${titleCase(server.software)} mods`}`} maxLength={100} aria-label="Search add-ons" />
            {type === 'plugin' && (
              <CustomSelect
                value={source}
                onChange={(val) => setSource(val as 'modrinth' | 'hangar')}
                disabled={!supported || searching}
                options={[
                  { value: 'modrinth', label: 'Modrinth' },
                  { value: 'hangar', label: 'Hangar' },
                ]}
                aria-label="Catalogue source"
                className="addon-search-select"
              />
            )}
            <button className="button button-primary" type="submit" disabled={!supported || !query.trim() || searching}>{searching ? 'Searching...' : 'Search'}</button>
          </form>
          {results.length > 0 && (
            <div className="addon-catalog-results">
              {results.map((result) => (
                <article className={`addon-catalog-row ${result.compatible ? '' : 'is-incompatible'}`} key={`${result.source}:${result.projectId}`}>
                  <div className="addon-catalog-icon-wrap">
                    {result.iconUrl ? (
                      <img
                        className="addon-catalog-icon"
                        src={result.iconUrl}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLElement).style.display = 'none';
                          const fallback = (e.currentTarget as HTMLElement).parentElement?.querySelector('.addon-catalog-icon-fallback') as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <div
                      className="addon-catalog-icon-fallback"
                      style={{ display: result.iconUrl ? 'none' : 'flex' }}
                    >
                      <Icon name="box" size={26} />
                    </div>
                  </div>
                  <div className="addon-catalog-copy">
                    <div className="addon-catalog-header">
                      <strong className="addon-catalog-title">{result.title}</strong>
                      <span className="addon-source-badge">{result.source === 'hangar' ? 'Hangar' : 'Modrinth'}</span>
                      {result.author && <span className="addon-author-badge">by {result.author}</span>}
                    </div>
                    <p className="addon-catalog-description">{result.description || 'No description provided by the publisher.'}</p>
                    <div className="addon-catalog-meta">
                      {result.versions.length ? (
                        <span className="addon-version-pill">
                          {result.versions.slice(0, 3).join(', ')}{result.versions.length > 3 ? ` +${result.versions.length - 3}` : ''}
                        </span>
                      ) : (
                        <span className="addon-version-pill">Compatible</span>
                      )}
                      {!result.compatible && <em className="addon-compatibility-error">{result.compatibilityMessage}</em>}
                    </div>
                  </div>
                  <div className="addon-catalog-actions">
                    <button
                      className="button button-primary addon-install-btn"
                      type="button"
                      disabled={!canMutate || !result.compatible || !supported || Boolean(busy) || pending.some(change => change.type === type && change.source === result.source && change.projectId === result.projectId)}
                      onClick={() => void install(result)}
                    >
                      <Icon name="plus" size={15} />
                      {busy === `install:${result.projectId}` ? (queuedMode ? 'Queuing…' : 'Installing…') : pending.some(change => change.type === type && change.source === result.source && change.projectId === result.projectId) ? 'Queued' : queuedMode ? 'Queue install' : 'Install'}
                    </button>
                    <a className="addon-details-link" href={result.url} target="_blank" rel="noreferrer">
                      Details <Icon name="arrowUpRight" size={13} />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
          {!searching && query && results.length === 0 && <p className="addon-search-empty">Search results will appear here after a successful search.</p>}
        </div>
        <div className="addon-list-card">
          <div className="addon-card-title"><div><h4>Installed {type === 'plugin' ? 'plugins' : 'mods'}</h4><p>{installed.length ? `${installed.length} current JAR${installed.length === 1 ? '' : 's'} on disk. Pending changes are listed separately.` : 'No JAR files found in this add-on directory.'}</p></div></div>
          <div className="addon-installed-list">{installed.map((addon) => {
            const updateInfo = updateByFile.get(updateKey(type, addon.fileName));
            const pendingChange = pendingForFile(addon.fileName);
            return <article className="addon-installed-row" key={addon.fileName}><div className="addon-file-icon"><Icon name="box" size={18} /></div><div className="addon-installed-copy"><strong>{addon.metadata?.name || addon.fileName}</strong><span>{addon.metadata?.version ? `v${addon.metadata.version} · ` : ''}{formatBytes(addon.size)} · {titleCase(addon.source)}</span><small>{addon.fileName} · changed {formatDate(addon.modifiedAt)}</small>{pendingChange && <span className={`addon-pending-badge is-${pendingChange.action}`}>{queuedLabel(pendingChange.action)} · cancel it above to change this file again</span>}{!addon.compatible && <em>{addon.compatibilityMessage ?? 'NodePilot could not confirm compatibility.'}</em>}{updateInfo?.message && <em>{updateInfo.message}</em>}{updateInfo?.available && !pendingChange && <em className="addon-update-available">Update available: {updateInfo.versionName ?? 'new version'}</em>}</div><div className="addon-row-actions">{updateInfo?.available && <button className="button button-secondary" type="button" disabled={!canMutate || !supported || Boolean(busy) || Boolean(pendingChange)} onClick={() => void update(addon.fileName)}>{busy === `update:${addon.fileName}` ? 'Queuing...' : queuedMode ? 'Queue update' : 'Update'}</button>}<button className="icon-button destructive-soft" type="button" title={`Remove ${addon.fileName}`} aria-label={`Remove ${addon.fileName}`} disabled={!canMutate || !supported || Boolean(busy) || Boolean(pendingChange)} onClick={() => void remove(addon.fileName)}><Icon name="trash" size={16} /></button></div></article>;
          })}</div>
          {!installed.length && <div className="addon-empty"><Icon name="box" size={24} /><span>{supported ? `Search a catalogue or upload a compatible ${type === 'plugin' ? 'plugin' : 'mod'} JAR.` : 'Existing files are listed here, but this server software cannot load this type.'}</span></div>}
        </div>
      </div>
    </>}
  </section>;
}
