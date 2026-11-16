import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AddonCatalogResult, BundlePreview, BundleSelection, ServerTemplate } from '../types';
import { CustomSelect } from './CustomSelect';
import { Icon } from './Icon';
import { errorMessage, formatBytes } from '../utils';

export function BundleSummary({ preview }: { preview?: BundlePreview }) {
  if (!preview?.compatible) return null;
  return <div className="bundle-summary">
    {preview.artifacts.length ? <><strong>{preview.artifacts.length} verified download{preview.artifacts.length === 1 ? '' : 's'}</strong>
      <ul>{preview.artifacts.map(file => <li key={file.source + file.projectId}><span><strong>{file.name}</strong> {file.versionName}<small>{file.fileName} · {formatBytes(file.size)}{file.requiredBy.length ? ` · Required by ${file.requiredBy.join(', ')}` : ''}</small></span><span className="java-state ready">Server-side</span></li>)}</ul>
      <p className="input-note">Exact versions and publisher checksums are pinned until {preview.expiresAt ? new Date(preview.expiresAt).toLocaleTimeString() : 'creation'}. No client mods are required.</p></> : <p className="input-note">No plugins or mods selected.</p>}
    {preview.configurationChanges.map(change => <p className="input-note" key={change.file}><code>{change.file}</code> — {change.description}</p>)}
  </div>;
}

export function TemplateAddonsPicker({ template, software, version, selections, onChange, preview, loading, error, onRefresh, onVersionChange }: {
  template: ServerTemplate; software: string; version: string; selections: BundleSelection[]; onChange: (value: BundleSelection[]) => void;
  preview?: BundlePreview; loading: boolean; error?: string; onRefresh: () => void; onVersionChange: (value: string) => void;
}) {
  const type = ['paper', 'purpur'].includes(software) ? 'plugin' : ['fabric', 'neoforge'].includes(software) ? 'mod' : null;
  const [source, setSource] = useState<'modrinth' | 'hangar'>('modrinth');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddonCatalogResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const sequence = useRef(0);
  useEffect(() => { sequence.current += 1; setResults([]); setQuery(''); setSearching(false); setSearchError(undefined); setSource('modrinth'); }, [software, version, template.id]);
  const search = async () => {
    if (!type || !query.trim()) return;
    const current = ++sequence.current;
    setSearching(true); setSearchError(undefined);
    try { const found = await api.searchTemplateAddons({ software, version, type, source, query: query.trim() }); if (current === sequence.current) setResults(found); }
    catch (cause) { if (current === sequence.current) setSearchError(errorMessage(cause)); }
    finally { if (current === sequence.current) setSearching(false); }
  };
  return <section className="template-settings bundle-picker" aria-label="Included plugins and mods">
    <div className="section-heading"><div><h3>Included {type === 'mod' ? 'mods' : 'plugins'}</h3><p className="field-help">Edit your bundle before creation. Dependencies are resolved automatically.</p></div></div>
    <ul className="bundle-selections">{selections.map(item => <li key={item.source + item.projectId}><span><strong>{item.name ?? preview?.artifacts.find(file => file.source === item.source && file.projectId === item.projectId)?.name ?? item.projectId}</strong><small>{item.source}</small></span><button type="button" className="text-button" onClick={() => onChange(selections.filter(value => value !== item))} aria-label={`Remove ${item.name ?? item.projectId}`}>Remove</button></li>)}</ul>
    {!type || template.id === 'pure-vanilla' ? <p className="input-note">{template.id === 'pure-vanilla' ? 'Pure Vanilla always stays free of plugins and mods.' : 'Choose Paper/Purpur for plugins or Fabric/NeoForge for these server-only mod bundles.'}</p> : <>
      {!selections.length && <p className="input-note">No add-ons selected. This template will use its gameplay settings only.</p>}
      <div className="bundle-search">
        {type === 'plugin' && <CustomSelect aria-label="Template add-on catalogue" value={source} options={['modrinth', 'hangar'].map(value => ({ value, label: value === 'hangar' ? 'Hangar' : 'Modrinth' }))} onChange={value => { sequence.current += 1; setSource(value as typeof source); setResults([]); }} />}
        <input aria-label="Search template add-ons" placeholder={`Find a ${type}…`} maxLength={100} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} />
        <button type="button" className="button button-secondary" disabled={searching || !query.trim()} onClick={() => void search()}>{searching ? 'Searching…' : 'Search'}</button>
      </div>
      {searchError && <p className="input-note" role="alert">{searchError}</p>}
      {!!results.length && <ul className="bundle-results">{results.map(item => {
        const selected = selections.some(value => value.source === item.source && value.projectId === item.projectId);
        return <li key={item.source + item.projectId}><span><strong>{item.title}</strong><small>{item.description}</small>{!item.compatible && <small>{item.compatibilityMessage}</small>}</span><button type="button" className="button button-secondary button-small" disabled={selected || !item.compatible || selections.length >= 32} onClick={() => onChange([...selections, { source: item.source, projectId: item.projectId, name: item.title }])}>{selected ? 'Selected' : 'Add'}</button></li>;
      })}</ul>}
    </>}
    {loading && <p className="input-note" role="status"><span className="button-loader" /> Checking stable versions and required dependencies…</p>}
    {(error || preview?.reason) && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><div><strong>Review the selected bundle</strong><span>{error ?? preview?.reason}</span></div></div>}
    {preview && !preview.compatible && !!preview.versions.length && <div className="field-group form-field"><span>Compatible Minecraft version</span><CustomSelect aria-label="Bundle-compatible Minecraft version" value="" placeholder="Choose a compatible release" options={preview.versions.map(value => ({ value, label: value }))} onChange={onVersionChange} /></div>}
    <BundleSummary preview={preview} />
    {!!selections.length && <button type="button" className="text-button" disabled={loading} onClick={onRefresh}>Refresh compatibility preview</button>}
  </section>;
}
