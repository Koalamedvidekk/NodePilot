import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { ApiError, api } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { AddonCatalogResult, AddonList, AddonType, AddonUpdate, Server } from '../types';
import { errorMessage, formatBytes, formatDate, titleCase } from '../utils';

function updateKey(type: AddonType, fileName: string): string {
  return `${type}:${fileName.toLowerCase()}`;
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await api.addons(server.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (type === 'mod') setSource('modrinth');
  }, [type]);

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
  const stopped = server.status === 'stopped';

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
    if (!stopped || !result.compatible || !supported) return;
    setBusy(`install:${result.projectId}`);
    setError(undefined);
    setNotice(undefined);
    try {
      if (result.source === 'hangar') {
        await api.installHangarAddon(server.id, result.projectId);
      } else {
        try {
          await api.installModrinthAddon(server.id, type, result.projectId);
        } catch (cause) {
          const dependencies = missingDependencyIds(cause);
          if (!dependencies.length || !window.confirm(`This add-on requires ${dependencies.length} dependency${dependencies.length === 1 ? '' : 'ies'} that NodePilot cannot find locally. Install it anyway?\n\n${dependencies.join('\n')}`)) throw cause;
          await api.installModrinthAddon(server.id, type, result.projectId, true);
        }
      }
      setNotice(`${result.title} was installed. Start or restart the server before it loads.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const chooseUpload = () => {
    if (stopped && supported && !busy) fileInput.current?.click();
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.jar$/i.test(file.name)) {
      setError('Choose a .jar plugin or mod file.');
      return;
    }
    if (!stopped || !supported) return;
    setBusy('upload');
    setError(undefined);
    setNotice(undefined);
    try {
      await api.uploadAddon(server.id, type, file);
      setNotice(`${file.name} was uploaded. Start or restart the server before it loads.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (fileName: string) => {
    if (!stopped || !window.confirm(`Remove ${fileName}? NodePilot will create a backup before deleting the active copy.`)) return;
    setBusy(`remove:${fileName}`);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.removeAddon(server.id, type, fileName);
      setNotice(`${fileName} was removed and backed up. Start or restart the server before the change takes effect.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
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
    if (!stopped || !window.confirm(`Update ${fileName}? NodePilot will back up the current JAR first.`)) return;
    setBusy(`update:${fileName}`);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.updateAddon(server.id, type, fileName);
      setNotice(`${fileName} was updated. Start or restart the server before it loads.`);
      await Promise.all([load(), checkUpdates()]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
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
    {notice && <div className="inline-alert alert-info" role="status"><Icon name="info" size={18} /><div><strong>Saved locally.</strong><span>{notice}</span></div><button type="button" className="text-button" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
    {!stopped && <div className="inline-alert alert-info"><Icon name="info" size={18} /><div><strong>Stop the server to change add-ons.</strong><span>Listing and update checks remain available, but install, upload, update, and removal are locked while it is active.</span></div></div>}
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
          <div className="addon-card-title"><div><h4>Find {type === 'plugin' ? 'plugins' : 'mods'}</h4><p>Search official catalogue APIs for this server version and software.</p></div><button className="button button-secondary" type="button" onClick={chooseUpload} disabled={!stopped || !supported || Boolean(busy)}><Icon name="plus" size={16} /> {type === 'plugin' ? 'Upload plugin JAR' : 'Upload mod JAR'}</button><input className="sr-only" ref={fileInput} type="file" accept=".jar,application/java-archive" onChange={(event) => void upload(event)} /></div>
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
                      disabled={!stopped || !result.compatible || !supported || Boolean(busy)}
                      onClick={() => void install(result)}
                    >
                      <Icon name="plus" size={15} />
                      {busy === `install:${result.projectId}` ? 'Installing…' : 'Install'}
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
          <div className="addon-card-title"><div><h4>Installed {type === 'plugin' ? 'plugins' : 'mods'}</h4><p>{installed.length ? `${installed.length} JAR${installed.length === 1 ? '' : 's'} found in this server directory.` : 'No JAR files found in this add-on directory.'}</p></div></div>
          <div className="addon-installed-list">{installed.map((addon) => {
            const updateInfo = updateByFile.get(updateKey(type, addon.fileName));
            return <article className="addon-installed-row" key={addon.fileName}><div className="addon-file-icon"><Icon name="box" size={18} /></div><div className="addon-installed-copy"><strong>{addon.metadata?.name || addon.fileName}</strong><span>{addon.metadata?.version ? `v${addon.metadata.version} · ` : ''}{formatBytes(addon.size)} · {titleCase(addon.source)}</span><small>{addon.fileName} · changed {formatDate(addon.modifiedAt)}</small>{!addon.compatible && <em>{addon.compatibilityMessage ?? 'NodePilot could not confirm compatibility.'}</em>}{updateInfo?.message && <em>{updateInfo.message}</em>}{updateInfo?.available && <em className="addon-update-available">Update available: {updateInfo.versionName ?? 'new version'}</em>}</div><div className="addon-row-actions">{updateInfo?.available && <button className="button button-secondary" type="button" disabled={!stopped || Boolean(busy)} onClick={() => void update(addon.fileName)}>{busy === `update:${addon.fileName}` ? 'Updating...' : 'Update'}</button>}<button className="icon-button destructive-soft" type="button" title={`Remove ${addon.fileName}`} aria-label={`Remove ${addon.fileName}`} disabled={!stopped || Boolean(busy)} onClick={() => void remove(addon.fileName)}><Icon name="trash" size={16} /></button></div></article>;
          })}</div>
          {!installed.length && <div className="addon-empty"><Icon name="box" size={24} /><span>{supported ? `Search a catalogue or upload a compatible ${type === 'plugin' ? 'plugin' : 'mod'} JAR.` : 'Existing files are listed here, but this server software cannot load this type.'}</span></div>}
        </div>
      </div>
    </>}
  </section>;
}
