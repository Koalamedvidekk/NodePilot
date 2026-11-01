import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ApiError } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { Server } from '../types';
import { errorMessage, formatBytes, formatDate, titleCase } from '../utils';
import { downloadWorldExport, worldApi } from '../world-api';
import type { WorldDetails, WorldDifficulty, WorldGenerationOptions, WorldImportInspection, WorldList, WorldOperation, WorldSummary } from '../world-types';

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'].map(value => ({ value, label: titleCase(value) }));
const DEFAULT_GENERATION: WorldGenerationOptions = { seed: '', preset: 'minecraft:normal', generatorSettings: '{}', structures: true, hardcore: false, difficulty: 'normal', enabledPacks: ['vanilla'], disabledPacks: [] };
type ResetSection = 'all' | 'settings' | 'rules' | 'packs' | 'none';

function worldError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404 && typeof cause.details === 'object' && cause.details !== null && 'error' in cause.details && cause.details.error === 'not_found') {
    return 'The running NodePilot backend does not have the Worlds API. Restart NodePilot after updating both the backend and browser app.';
  }
  if (cause instanceof ApiError && cause.status === 409) return errorMessage(cause) + ' Your unsaved fields are still here. Refresh the world before retrying if its saved data changed.';
  return errorMessage(cause);
}

function worldState(world: WorldSummary): string {
  if (world.deleted) return 'Deleted · backup retained';
  if (world.state === 'prepared') return 'Prepared—not generated yet';
  if (world.state === 'generated') return world.active ? 'Selected for server start' : 'Saved world';
  return titleCase(world.state);
}

function WorldModal({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
    (dialog.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const targets = focusable();
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return createPortal(<div className="world-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={dialog} className="world-modal panel" role="dialog" aria-modal="true" aria-labelledby="world-modal-title"><div className="world-modal-header"><div><p className="eyebrow">MINECRAFT WORLDS</p><h3 id="world-modal-title">{title}</h3></div><button className="button button-ghost button-small" type="button" aria-label="Close world dialog" onClick={onClose} disabled={busy}><Icon name="close" size={19} /></button></div>{children}</div></div>, document.body);
}

export function WorldsPanel({ server }: { server: Server }) {
  const [listing, setListing] = useState<WorldList>();
  const [details, setDetails] = useState<WorldDetails>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dispatching, setDispatching] = useState(false);
  const [operation, setOperation] = useState<WorldOperation>();
  const completed = useRef(new Set<string>());
  const resetAfter = useRef<ResetSection>('none');
  const [name, setName] = useState('');
  const [difficulty, setDifficulty] = useState<WorldDifficulty>('normal');
  const [hardcore, setHardcore] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Record<string, boolean | string>>({});
  const [ruleSearch, setRuleSearch] = useState('');
  const [enabledPacks, setEnabledPacks] = useState<string[]>([]);
  const dirty = useRef({ settings: false, rules: false, packs: false });
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [prepareSource, setPrepareSource] = useState<WorldDetails>();
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [generation, setGeneration] = useState<WorldGenerationOptions>({ ...DEFAULT_GENERATION });
  const [inspection, setInspection] = useState<WorldImportInspection>();
  const [candidateId, setCandidateId] = useState('');
  const [importName, setImportName] = useState('');
  const [compatibilityReviewed, setCompatibilityReviewed] = useState(false);
  const worldUpload = useRef<HTMLInputElement>(null);
  const packUpload = useRef<HTMLInputElement>(null);

  const settingsDirty = Boolean(details && (name !== details.world.name || difficulty !== (details.world.difficulty ?? details.generation.difficulty) || hardcore !== (details.world.hardcore ?? details.generation.hardcore)));
  const rulesDirty = Boolean(details?.gameRules.some(rule => rule.editable && String(ruleDraft[rule.id]) !== String(rule.value)));
  const packsDirty = Boolean(details && details.datapacks.some(pack => pack.enabled !== enabledPacks.includes(pack.id)));
  dirty.current = { settings: settingsDirty, rules: rulesDirty, packs: packsDirty };

  const acceptDetails = useCallback((next: WorldDetails, reset: ResetSection) => {
    const changedWorld = selectedRef.current !== next.world.id;
    if (changedWorld || reset === 'all' || reset === 'settings' || !dirty.current.settings) {
      setName(next.world.name); setDifficulty(next.world.difficulty ?? next.generation.difficulty); setHardcore(next.world.hardcore ?? next.generation.hardcore);
    }
    if (changedWorld || reset === 'all' || reset === 'rules' || !dirty.current.rules) setRuleDraft(Object.fromEntries(next.gameRules.map(rule => [rule.id, typeof rule.value === 'boolean' ? rule.value : String(rule.value)])));
    if (changedWorld || reset === 'all' || reset === 'packs' || !dirty.current.packs) setEnabledPacks(next.datapacks.filter(pack => pack.enabled).map(pack => pack.id));
    selectedRef.current = next.world.id; setSelectedId(next.world.id); setDetails(next);
  }, []);

  const reload = useCallback(async (preferredId?: string, reset: ResetSection = 'none') => {
    const next = await worldApi.list(server.id);
    setListing(next);
    if (next.operation?.state === 'running') setOperation(next.operation);
    const desired = preferredId ?? selectedRef.current;
    const id = next.worlds.find(world => world.id === desired)?.id ?? next.activeWorldId ?? next.worlds[0]?.id;
    if (id) {
      const value = await worldApi.details(server.id, id);
      acceptDetails(value, reset);
    } else { selectedRef.current = undefined; setSelectedId(undefined); setDetails(undefined); }
  }, [acceptDetails, server.id]);

  useEffect(() => {
    let mounted = true;
    setLoading(true); setListing(undefined); setDetails(undefined); setError(undefined); setNotice(undefined); setOperation(undefined);
    selectedRef.current = undefined; completed.current.clear(); dirty.current = { settings: false, rules: false, packs: false };
    void reload(undefined, 'all').catch(cause => { if (mounted) setError(worldError(cause)); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => { void worldApi.list(server.id).then(next => { setListing(next); if (next.operation?.state === 'running') setOperation(next.operation); }).catch(() => undefined); }, 20_000);
    return () => window.clearInterval(timer);
  }, [server.id]);

  const finish = useCallback(async (next: WorldOperation) => {
    if (completed.current.has(next.id)) return;
    completed.current.add(next.id);
    if (next.state === 'failed') { setError(next.error ?? 'The world operation failed.'); await reload().catch(() => undefined); return; }
    if (next.result?.inspection) {
      const value = next.result.inspection;
      setInspection(value); setCandidateId(value.candidates[0]?.id ?? ''); setImportName(value.candidates[0]?.name ?? ''); setCompatibilityReviewed(false);
    } else if (next.result?.downloadUrl) {
      await downloadWorldExport(server.id, next.result.downloadUrl);
      setNotice('The complete world archive is downloading.');
    } else {
      if (next.kind === 'prepare' || next.kind === 'create') { setPrepareOpen(false); setNewName(''); setGeneration({ ...DEFAULT_GENERATION }); }
      if (next.kind === 'import') setInspection(undefined);
      setNotice(next.kind === 'prepare' || next.kind === 'create' ? 'World prepared for the next server start. Your previous world is still saved.' : 'World operation completed.');
    }
    await reload(next.result?.worldId, resetAfter.current);
  }, [reload, server.id]);

  useEffect(() => {
    if (!operation || operation.state !== 'running') return;
    let active = true;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void worldApi.operation(server.id, operation.id).then(async next => {
        if (!active) return;
        setOperation(next);
        if (next.state !== 'running') await finish(next);
      }).catch(cause => { if (active) setError(worldError(cause)); }).finally(() => { polling = false; });
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [finish, operation?.id, operation?.state, server.id]);

  const busy = dispatching || operation?.state === 'running' || listing?.operation?.state === 'running';
  const stopped = server.status === 'stopped' || server.status === 'error';
  const mutable = Boolean(listing?.supported && listing.capabilities.canMutate && stopped && !busy);
  const canEdit = Boolean(mutable && details?.capabilities.canMutate && !details.world.readOnlyReason && !details.world.deleted);
  const canReadFiles = canEdit && details?.world.state === 'generated';
  const blockedReason = !stopped ? 'Stop the server before changing, backing up, or downloading worlds. Saved metadata may be older than the running world.' : listing?.capabilities.reason;
  const activeWorld = listing?.worlds.find(world => world.id === listing.activeWorldId);
  const visibleRules = useMemo(() => (details?.gameRules ?? []).filter(rule => (rule.label + ' ' + rule.id).toLowerCase().includes(ruleSearch.toLowerCase())), [details?.gameRules, ruleSearch]);
  const candidate = inspection?.candidates.find(value => value.id === candidateId);

  async function run(action: () => Promise<{ operation: WorldOperation }>, reset: ResetSection = 'none') {
    setDispatching(true); setError(undefined); setNotice(undefined); resetAfter.current = reset;
    try {
      const { operation: next } = await action();
      setOperation(next);
      if (next.state !== 'running') await finish(next);
      return next.state !== 'failed';
    } catch (cause) { setError(worldError(cause)); return false; }
    finally { setDispatching(false); }
  }

  async function selectWorld(world: WorldSummary) {
    if (world.id === selectedId) return;
    if (Object.values(dirty.current).some(Boolean) && !window.confirm('Discard unsaved world settings and view another world?')) return;
    setDetailsLoading(true); setError(undefined);
    try { acceptDetails(await worldApi.details(server.id, world.id), 'all'); setRuleSearch(''); }
    catch (cause) { setError(worldError(cause)); }
    finally { setDetailsLoading(false); }
  }

  async function refresh() {
    if (Object.values(dirty.current).some(Boolean) && !window.confirm('Refresh saved world data and discard unsaved fields?')) return;
    setDetailsLoading(true); setError(undefined);
    try { await reload(undefined, 'all'); } catch (cause) { setError(worldError(cause)); } finally { setDetailsLoading(false); }
  }

  async function prepare(event: FormEvent) {
    event.preventDefault(); if (!mutable || !listing || prepareLoading) return;
    try { const value: unknown = JSON.parse(generation.generatorSettings); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
    catch { setError('Generator settings must be a valid JSON object.'); return; }
    await run(() => worldApi.prepare(server.id, { ...generation, name: newName.trim(), revision: listing.revision }), 'all');
  }

  async function openPrepare() {
    if (!mutable || !listing) return;
    setPrepareLoading(true); setPrepareSource(undefined); setError(undefined);
    setNewName('');
    setGeneration({ ...DEFAULT_GENERATION, preset: listing.capabilities.presets[0]?.id ?? DEFAULT_GENERATION.preset });
    setPrepareOpen(true);
    try {
      if (listing.activeWorldId) {
        const source = await worldApi.details(server.id, listing.activeWorldId);
        setPrepareSource(source);
        setGeneration(current => ({ ...current, enabledPacks: ['vanilla', ...source.datapacks.filter(pack => pack.id !== 'vanilla' && pack.managed && pack.enabled).map(pack => pack.id)] }));
      }
    } catch (cause) { setError(worldError(cause)); setPrepareOpen(false); }
    finally { setPrepareLoading(false); }
  }

  async function saveRules(event: FormEvent) {
    event.preventDefault(); if (!details || !canEdit) return;
    const values: Record<string, boolean | number> = {};
    for (const rule of details.gameRules.filter(rule => rule.editable)) {
      const draft = ruleDraft[rule.id];
      if (String(draft) === String(rule.value)) continue;
      if (rule.type === 'boolean') values[rule.id] = draft === true;
      else {
        const numeric = Number(draft);
        if (typeof draft !== 'string' || !/^-?\d+$/.test(draft) || !Number.isSafeInteger(numeric) || (rule.minimum !== undefined && numeric < rule.minimum) || (rule.maximum !== undefined && numeric > rule.maximum)) { setError('Enter a valid integer for ' + rule.label + '.'); return; }
        values[rule.id] = numeric;
      }
    }
    await run(() => worldApi.rules(server.id, details.world.id, details.world.revision, values), 'rules');
  }

  async function activate() {
    if (!details || !canEdit) return;
    if (!window.confirm(`Select ${details.world.name} for the next server start?\n\nThe current world and its player progress remain saved. Review Minecraft version and mod compatibility before starting.`)) return;
    await run(() => worldApi.activate(server.id, details.world.id, details.world.revision, true), 'all');
  }

  async function removeWorld() {
    if (!details || !canEdit || details.world.active) return;
    const confirmation = window.prompt(`NodePilot will make a complete backup, then delete ${details.world.name} from the saved worlds.\n\nType its name to confirm:`);
    if (confirmation === null) return;
    if (confirmation !== details.world.name) { setError('The world name did not match. Nothing was deleted.'); return; }
    await run(() => worldApi.remove(server.id, details.world.id, details.world.revision, confirmation), 'all');
  }

  if (loading) return <section className="panel management-panel"><div className="management-loading"><span className="button-loader" /> Reading saved worlds…</div></section>;

  return <section className="worlds-panel">
    <div className="worlds-heading"><div><p className="eyebrow">MINECRAFT WORLDS</p><h3>Worlds</h3><p>A home for every adventure. Keep your worlds and their player progress, then choose where the server starts next.</p></div><div className="world-actions"><button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={busy || detailsLoading}><Icon name="refresh" size={16} /> Refresh worlds</button><button className="button button-primary" type="button" onClick={() => void openPrepare()} disabled={!mutable}><Icon name="plus" size={16} /> Prepare new world</button><button className="button button-secondary" type="button" onClick={() => worldUpload.current?.click()} disabled={!mutable}><Icon name="folder" size={16} /> Upload world ZIP</button><input ref={worldUpload} type="file" accept=".zip,application/zip" aria-label="World ZIP file" hidden disabled={!mutable} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => worldApi.inspect(server.id, file)); }} /></div></div>
    {error && !prepareOpen && !inspection && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><span>{error}</span></div>}
    {notice && <div className="inline-alert alert-info" role="status"><Icon name="check" size={18} /><span>{notice}</span></div>}
    {listing?.supported === false ? <section className="panel world-card"><h3>World management unavailable</h3><p>{listing.unsupportedReason ?? 'World management is currently available for supported Minecraft Java servers.'}</p></section> : <>
      {blockedReason && <div className="inline-alert alert-info"><Icon name="lock" size={18} /><span>{blockedReason}</span></div>}
      {operation?.state === 'running' && <div className="world-operation panel" role="status" aria-live="polite"><span className="button-loader" /><div><strong>{titleCase(operation.phase.replaceAll('_', ' '))}</strong><span>{operation.totalBytes !== null ? `${formatBytes(operation.processedBytes)} of ${formatBytes(operation.totalBytes)}` : 'NodePilot is processing the world files. Keep this page open to follow progress.'}</span></div>{operation.totalBytes !== null && operation.totalBytes > 0 && <progress value={operation.processedBytes} max={operation.totalBytes} aria-label="World operation progress" />}</div>}
      <section className="panel world-current"><div className="world-current-icon"><Icon name="box" size={27} /></div><div><p className="eyebrow">PRIMARY WORLD</p><h3>{activeWorld?.name ?? 'No world selected'}</h3><p>{activeWorld ? worldState(activeWorld) : 'Prepare or select a world to use on the next server start.'}</p></div>{activeWorld && <span className="world-pill">{activeWorld.minecraftVersion ?? (activeWorld.state === 'prepared' ? 'Next start' : 'Version unknown')}</span>}</section>
      {(listing?.warnings ?? []).map(warning => <p className="world-warning" key={warning}><Icon name="info" size={15} />{warning}</p>)}
      <div className="worlds-workspace"><aside className="panel world-library"><div className="world-library-heading"><h3>Saved worlds</h3><span>{listing?.worlds.length ?? 0}</span></div>{listing?.worlds.length ? listing.worlds.map(world => <button key={world.id} type="button" className={['world-library-item', selectedId === world.id ? 'is-selected' : '', world.deleted ? 'is-deleted' : ''].join(' ')} onClick={() => void selectWorld(world)} disabled={detailsLoading} aria-pressed={selectedId === world.id}><span className="world-library-symbol"><Icon name={world.deleted ? 'database' : 'box'} size={19} /></span><span><strong>{world.name}</strong><small>{worldState(world)}</small></span>{world.active && <Icon name="check" size={16} />}</button>) : <div className="world-empty"><Icon name="folder" size={28} /><p>No saved worlds were found.</p><small>Preparing a world keeps it here for future visits.</small></div>}</aside>
        <div className="world-detail-stack" aria-busy={detailsLoading}>
          {details ? <>
            <section className="panel world-card"><div className="world-section-heading"><div><p className="eyebrow">{details.metadataSource === 'last-saved' ? 'LAST SAVED STATE' : details.metadataSource === 'not-generated' ? 'GENERATION PREPARED' : 'SAVED WORLD DATA'}</p><h3>{details.world.name}</h3><p>{worldState(details.world)} · <span className="world-folder">{details.world.folder}</span></p></div><div className="world-actions"><button className="button button-primary button-small" type="button" onClick={() => void activate()} disabled={!canEdit || details.world.active}>Use on next start</button><button className="button button-secondary button-small" type="button" disabled={!canReadFiles} onClick={() => void run(() => worldApi.export(server.id, details.world.id, details.world.revision))}><Icon name="download" size={15} /> Download ZIP</button><button className="button button-danger-outline button-small" type="button" disabled={!canEdit || details.world.active} onClick={() => void removeWorld()}><Icon name="trash" size={15} /> Delete world</button></div></div>
              {details.world.readOnlyReason && <div className="inline-alert alert-warning"><Icon name="warning" size={17} /><span>{details.world.readOnlyReason}</span></div>}
              {details.world.deleted && <div className="inline-alert alert-info"><Icon name="database" size={17} /><span>The world files were deleted. Restore a retained backup below to recover this world.</span></div>}
              <div className="world-facts"><div><span>Actual saved seed</span><strong>{details.world.seed ?? 'Not available yet'}</strong>{details.world.seed !== null && <button className="button button-ghost button-small" type="button" aria-label="Copy world seed" onClick={() => { void Promise.resolve().then(() => { if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser. Select and copy the saved seed directly.'); return navigator.clipboard.writeText(details.world.seed!); }).then(() => setNotice('World seed copied.')).catch(cause => setError(errorMessage(cause))); }}><Icon name="copy" size={14} /></button>}</div><div><span>Minecraft version</span><strong>{details.world.minecraftVersion ?? 'Not available yet'}</strong></div><div><span>Saved difficulty</span><strong>{details.world.difficulty ? titleCase(details.world.difficulty) : 'Not available yet'}</strong></div><div><span>Saved hardcore</span><strong>{details.world.hardcore === null ? 'Not available yet' : details.world.hardcore ? 'Enabled' : 'Disabled'}</strong></div><div><span>World size</span><strong>{details.world.sizeBytes === null ? 'Unavailable' : formatBytes(details.world.sizeBytes)}</strong></div><div><span>Last saved</span><strong>{details.world.lastSavedAt ? formatDate(details.world.lastSavedAt) : 'Not saved yet'}</strong></div></div>
              <div className="world-chips" aria-label="World dimensions">{details.world.dimensions.map(dimension => <span className="world-chip" key={dimension}>{dimension}</span>)}{!details.world.dimensions.length && <span className="input-note">Dimensions appear after Minecraft generates the world.</span>}</div>
              {details.world.state === 'prepared' && <p className="world-generation-note">Requested seed: <strong>{details.generation.seed || 'Random, chosen by Minecraft on the next start'}</strong>. Preset: <strong>{details.generation.preset}</strong>. Preparing this world does not start Minecraft.</p>}
              {details.warnings.map(warning => <p className="world-warning" key={warning}><Icon name="warning" size={15} />{warning}</p>)}
            </section>

            <section className="panel world-card"><div className="world-section-heading"><div><h3>World settings</h3><p>Saved for this world. Changes apply when the server starts again.</p></div></div><form className="world-form" onSubmit={event => { event.preventDefault(); if (canEdit) void run(() => worldApi.settings(server.id, details.world.id, { revision: details.world.revision, name: name.trim(), difficulty, hardcore }), 'settings'); }}><label className="form-field"><span className="field-label">Display name</span><input className="text-input" value={name} onChange={event => setName(event.target.value)} maxLength={64} required disabled={!canEdit} /></label><div className="form-field"><label className="field-label" htmlFor="world-difficulty">Difficulty</label><CustomSelect id="world-difficulty" aria-label="World difficulty" value={difficulty} options={DIFFICULTIES} onChange={value => setDifficulty(value as WorldDifficulty)} disabled={!canEdit || hardcore} /></div><label className="world-toggle"><input type="checkbox" role="switch" checked={hardcore} onChange={event => { setHardcore(event.target.checked); if (event.target.checked) setDifficulty('hard'); }} disabled={!canEdit} /><span>Hardcore<small>Hard difficulty and permanent death rules</small></span></label><div className="world-form-footer"><button className="button button-primary" type="submit" disabled={!canEdit || !settingsDirty}>Save world settings</button></div></form></section>

            <section className="panel world-card"><div className="world-section-heading"><div><h3>Game rules</h3><p>Version-aware values from this world’s saved data.</p></div><label className="world-search"><Icon name="search" size={16} /><input type="search" aria-label="Search game rules" placeholder="Search game rules…" value={ruleSearch} onChange={event => setRuleSearch(event.target.value)} /></label></div>{details.world.state === 'prepared' ? <p className="world-empty-copy">Game rules become available after Minecraft generates this world and the server is stopped.</p> : <form onSubmit={event => void saveRules(event)}><div className="world-rule-grid">{visibleRules.map(rule => <label className="world-rule" key={rule.id}><span><strong>{rule.label}</strong><small>{rule.id}</small></span>{rule.type === 'boolean' ? <input type="checkbox" role="switch" aria-label={rule.label} checked={ruleDraft[rule.id] === true} onChange={event => setRuleDraft(current => ({ ...current, [rule.id]: event.target.checked }))} disabled={!canEdit || !rule.editable} /> : rule.type === 'integer' ? <input className="text-input world-rule-number" type="number" step={1} min={rule.minimum} max={rule.maximum} aria-label={rule.label} value={String(ruleDraft[rule.id] ?? rule.value)} onChange={event => setRuleDraft(current => ({ ...current, [rule.id]: event.target.value }))} disabled={!canEdit || !rule.editable} /> : <span className="world-rule-unknown">{String(rule.value)}</span>}</label>)}</div>{!visibleRules.length && <p className="world-empty-copy">{details.gameRules.length ? 'No game rules match your search.' : 'This world does not expose supported saved game-rule data.'}</p>}<div className="world-form-footer"><span className="input-note">Unrecognized rules are preserved and shown read-only.</span><button className="button button-primary" type="submit" disabled={!canEdit || !rulesDirty}>Save game rules</button></div></form>}</section>

            <section className="panel world-card"><div className="world-section-heading"><div><h3>Datapacks & features</h3><p>World content packs are separate from server plugins and mods.</p></div><button className="button button-secondary button-small" type="button" onClick={() => packUpload.current?.click()} disabled={!canEdit}><Icon name="plus" size={15} /> Upload datapack ZIP</button><input ref={packUpload} hidden type="file" accept=".zip,application/zip" aria-label="Datapack ZIP file" disabled={!canEdit} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => worldApi.uploadDatapack(server.id, details.world.id, details.world.revision, file), 'packs'); }} /></div><div className="world-feature-row"><span>Enabled features</span><div className="world-chips">{details.features.length ? details.features.map(feature => <span className="world-chip" key={feature}>{feature}</span>) : <span className="input-note">No saved feature flags are available yet.</span>}</div></div>
              {(['Enabled', 'Disabled', 'Incompatible', 'Software-managed'] as const).map(category => {
                const packs = details.datapacks.filter(pack => (pack.managed ? 'Software-managed' : pack.compatible === false ? 'Incompatible' : pack.enabled ? 'Enabled' : 'Disabled') === category);
                return packs.length ? <div className="world-pack-group" key={category}><h4>{category}<span>{packs.length}</span></h4>{packs.map(pack => <div className="world-pack" key={pack.id}><label><input type="checkbox" checked={enabledPacks.includes(pack.id)} aria-label={'Enable ' + pack.name} onChange={event => setEnabledPacks(current => event.target.checked ? [...current, pack.id] : current.filter(id => id !== pack.id))} disabled={!canEdit || pack.managed || (pack.compatible !== true && !pack.enabled) || (pack.generationPack && details.world.state !== 'prepared')} /><span><strong>{pack.name}</strong><small>{pack.description}</small>{pack.reason && <small className="world-pack-reason">{pack.reason}</small>}{pack.generationPack && !pack.managed && <small>World generation or experimental content</small>}</span></label>{pack.removable && <button className="button button-ghost button-small" type="button" aria-label={'Remove ' + pack.name} disabled={!canEdit || (pack.generationPack && details.world.state !== 'prepared')} onClick={() => { if (window.confirm('Remove datapack ' + pack.name + '? NodePilot keeps a recovery snapshot before changing its files.')) void run(() => worldApi.removeDatapack(server.id, details.world.id, pack.id, details.world.revision), 'packs'); }}><Icon name="trash" size={15} /></button>}</div>)}</div> : null;
              })}
              {!details.datapacks.length && <p className="world-empty-copy">No datapack information is available for this world.</p>}<div className="world-form-footer"><span className="input-note">Generation packs are locked after the world is generated.</span><button className="button button-primary" type="button" disabled={!canEdit || !packsDirty} onClick={() => void run(() => worldApi.selectDatapacks(server.id, details.world.id, details.world.revision, enabledPacks, details.datapacks.filter(pack => !enabledPacks.includes(pack.id)).map(pack => pack.id)), 'packs')}>Save datapack selection</button></div>
            </section>

            <section className="panel world-card"><div className="world-section-heading"><div><h3>Backups & recovery</h3><p>Complete backups include dimensions, player data, and world datapacks.</p></div><button className="button button-secondary button-small" type="button" disabled={!canReadFiles} onClick={() => void run(() => worldApi.backup(server.id, details.world.id, details.world.revision))}><Icon name="database" size={15} /> Create world backup</button></div>{details.backups.length ? <div className="world-backups">{details.backups.map(backup => <div className="world-backup" key={backup.id}><div><strong>{backup.name}</strong><small>{formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</small></div><button className="button button-secondary button-small" type="button" disabled={!mutable} onClick={() => { if (window.confirm('Restore this complete world backup? NodePilot will back up the current world files first when they exist. The server will stay stopped.')) void run(() => worldApi.restore(server.id, details.world.id, backup.id, details.world.revision), 'all'); }}>Restore backup</button></div>)}</div> : <p className="world-empty-copy">No complete world backups have been recorded yet.</p>}</section>
          </> : <section className="panel world-card world-empty"><Icon name="box" size={34} /><h3>Select a saved world</h3><p>Its generation settings, game rules, datapacks, and backups appear here.</p></section>}
        </div>
      </div><p className="world-footer-note">Inventories, XP, advancements, statistics, and player locations stay with each world. Server-wide plugin and mod progress remains managed by that software.</p>
    </>}

    {prepareOpen && <WorldModal title="Prepare a new world" busy={busy || prepareLoading} onClose={() => setPrepareOpen(false)}><form className="world-modal-form" onSubmit={event => void prepare(event)}>{error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><span>{error}</span></div>}<div className="inline-alert alert-info"><Icon name="info" size={18} /><span>Your current world stays saved. This selects a new world for the next server start; Minecraft will generate it when you start the server.</span></div><div className="world-form"><label className="form-field"><span className="field-label">World name</span><input className="text-input" autoComplete="off" value={newName} onChange={event => setNewName(event.target.value)} required maxLength={64} disabled={busy} /></label><label className="form-field"><span className="field-label">Seed</span><input className="text-input" aria-label="Seed" value={generation.seed} onChange={event => setGeneration(current => ({ ...current, seed: event.target.value }))} maxLength={256} placeholder="Random, or enter a numeric/text seed" disabled={busy} /><span className="input-note">Leave blank for a random seed chosen by Minecraft.</span></label><div className="form-field"><label className="field-label" htmlFor="new-world-preset">World preset</label><CustomSelect id="new-world-preset" aria-label="World preset" value={generation.preset} onChange={value => setGeneration(current => ({ ...current, preset: value }))} options={(listing?.capabilities.presets ?? []).map(preset => ({ value: preset.id, label: preset.name }))} disabled={busy} /></div><div className="form-field"><label className="field-label" htmlFor="new-world-difficulty">Difficulty</label><CustomSelect id="new-world-difficulty" aria-label="New world difficulty" value={generation.difficulty} onChange={value => setGeneration(current => ({ ...current, difficulty: value as WorldDifficulty }))} options={DIFFICULTIES} disabled={busy || generation.hardcore} /></div><label className="world-toggle"><input type="checkbox" checked={generation.structures} onChange={event => setGeneration(current => ({ ...current, structures: event.target.checked }))} disabled={busy} /><span>Generate structures<small>Villages, temples, and other generated structures</small></span></label><label className="world-toggle"><input type="checkbox" checked={generation.hardcore} onChange={event => setGeneration(current => ({ ...current, hardcore: event.target.checked, difficulty: event.target.checked ? 'hard' : current.difficulty }))} disabled={busy} /><span>Hardcore<small>Hard difficulty and permanent death rules</small></span></label></div><div className="world-new-packs"><h4>Initial datapacks</h4><p>Vanilla and required software packs stay enabled. Choose verified built-in experiments or compatible datapack ZIPs from the primary world. These generation choices are locked after the first save.</p>{prepareLoading && <p role="status">Reading compatible datapacks from the primary world…</p>}{prepareSource?.datapacks.filter(pack => !pack.managed && pack.compatible === true && (pack.id.endsWith('.zip') || !pack.id.startsWith('file/'))).map(pack => <label className="world-toggle" key={pack.id}><input type="checkbox" checked={generation.enabledPacks.includes(pack.id)} onChange={event => setGeneration(current => ({ ...current, enabledPacks: event.target.checked ? [...current.enabledPacks, pack.id] : current.enabledPacks.filter(id => id !== pack.id) }))} disabled={busy} /><span>{pack.name}</span></label>)}<div className="world-chips">{(prepareSource?.datapacks.filter(pack => pack.managed && pack.enabled) ?? [{ id: 'vanilla', name: 'Vanilla' }]).map(pack => <span className="world-chip" key={pack.id}>{pack.name}</span>)}</div></div><details className="world-advanced"><summary>Advanced generator settings</summary><label className="form-field"><span className="field-label">Generator JSON</span><textarea className="text-input world-json" aria-label="Generator JSON" value={generation.generatorSettings} onChange={event => setGeneration(current => ({ ...current, generatorSettings: event.target.value }))} maxLength={16384} rows={5} spellCheck={false} disabled={busy} /><span className="input-note">Use a JSON object supported by the selected Minecraft preset.</span></label></details><div className="world-modal-actions"><button className="button button-secondary" type="button" onClick={() => setPrepareOpen(false)} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={!mutable || prepareLoading || !newName.trim() || !(listing?.capabilities.presets.length)}>{busy ? <span className="button-loader" /> : <Icon name="plus" size={16} />} Prepare world</button></div></form></WorldModal>}

    {inspection && <WorldModal title="Import a saved world" busy={busy} onClose={() => setInspection(undefined)}><form className="world-modal-form" onSubmit={event => { event.preventDefault(); if (mutable && listing && candidate && compatibilityReviewed) void run(() => worldApi.import(server.id, { inspectionId: inspection.id, candidateId, name: importName.trim(), revision: listing.revision, confirmCompatibility: true }), 'all'); }}>{error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><span>{error}</span></div>}<div className="inline-alert alert-info"><Icon name="info" size={18} /><span>The source ZIP and your existing worlds are preserved. NodePilot imports the selected world into a new saved entry.</span></div><p>{inspection.fileCount.toLocaleString()} archive entries · {formatBytes(inspection.totalBytes)} uncompressed</p><div className="form-field"><label className="field-label" htmlFor="import-world-candidate">World to import</label><CustomSelect id="import-world-candidate" aria-label="World to import" value={candidateId} onChange={id => { setCandidateId(id); setImportName(inspection.candidates.find(value => value.id === id)?.name ?? ''); setCompatibilityReviewed(false); }} options={inspection.candidates.map(value => ({ value: value.id, label: value.name, description: value.minecraftVersion ?? 'Minecraft version uncertain' }))} disabled={busy} /></div><label className="form-field"><span className="field-label">Imported world name</span><input className="text-input" value={importName} onChange={event => setImportName(event.target.value)} required maxLength={64} disabled={busy} /></label>{candidate && <div className="world-import-summary"><p>Minecraft: <strong>{candidate.minecraftVersion ?? 'Unknown—review compatibility'}</strong></p><p>Saved seed: <strong>{candidate.seed ?? 'Unavailable'}</strong></p><div className="world-chips">{candidate.dimensions.map(value => <span className="world-chip" key={value}>{value}</span>)}</div></div>}{[...inspection.warnings, ...(candidate?.warnings ?? [])].map((warning, index) => <p className="world-warning" key={index}><Icon name="warning" size={15} />{warning}</p>)}<label className="world-toggle"><input type="checkbox" checked={compatibilityReviewed} onChange={event => setCompatibilityReviewed(event.target.checked)} disabled={busy} /><span>I reviewed Minecraft version and mod compatibility.<small>Known newer-world downgrades are blocked. Unknown compatibility may need manual review.</small></span></label><div className="world-modal-actions"><button className="button button-secondary" type="button" onClick={() => setInspection(undefined)} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={!mutable || !candidate || !importName.trim() || !compatibilityReviewed}>{busy ? <span className="button-loader" /> : <Icon name="folder" size={16} />} Import world</button></div></form></WorldModal>}
  </section>;
}
