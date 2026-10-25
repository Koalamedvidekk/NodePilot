import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { ImportInspection, ProvisionableServerSoftware } from '../types';
import { errorMessage, formatBytes, titleCase } from '../utils';

type SourceMode = 'directory' | 'archive';

const supportedSoftware: Array<{ id: ProvisionableServerSoftware; label: string }> = [
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'paper', label: 'Paper' },
  { id: 'spigot', label: 'Spigot' },
  { id: 'purpur', label: 'Purpur' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'quilt', label: 'Quilt' },
];

function inspectedSoftware(inspection: ImportInspection): ProvisionableServerSoftware {
  if (inspection.suggestedSoftware && supportedSoftware.some((item) => item.id === inspection.suggestedSoftware)) return inspection.suggestedSoftware;
  if (supportedSoftware.some((item) => item.id === inspection.detectedSoftware)) return inspection.detectedSoftware as ProvisionableServerSoftware;
  return inspection.suggestedFlavor ?? 'paper';
}

function FindingList({ inspection }: { inspection: ImportInspection }) {
  if (!inspection.findings.length) return null;
  return <div className="import-findings">
    {inspection.findings.map((finding) => <div className={`import-finding ${finding.level}`} key={`${finding.code}-${finding.message}`}>
      <Icon name={finding.level === 'error' ? 'warning' : finding.level === 'warning' ? 'info' : 'check'} size={16} />
      <span>{finding.message}</span>
    </div>)}
  </div>;
}

function InspectionSummary({ inspection }: { inspection: ImportInspection }) {
  return <section className="panel import-summary">
    <div className="panel-heading"><div><p className="eyebrow">IMPORT INSPECTION</p><h3>Existing server detected</h3><p>Nothing has been copied or changed yet.</p></div><span className={inspection.canImport ? 'import-ready-badge' : 'import-error-badge'}>{inspection.canImport ? 'Ready to configure' : 'Needs attention'}</span></div>
    <dl className="import-detail-grid">
      <div><dt>Detected software</dt><dd>{titleCase(inspection.detectedSoftware)}</dd></div>
      <div><dt>Minecraft version</dt><dd>{inspection.minecraftVersion ?? 'Could not detect'}</dd></div>
      <div><dt>Server JAR</dt><dd><code>{inspection.serverJar ?? 'Not found'}</code></dd></div>
      <div><dt>Original port</dt><dd>{inspection.port ?? 'Not detected'}</dd></div>
      <div><dt>Worlds</dt><dd>{inspection.worlds.length ? inspection.worlds.join(', ') : 'None detected'}</dd></div>
      <div><dt>Players</dt><dd>{inspection.playerDataFiles ? `${inspection.playerDataFiles} saved player record${inspection.playerDataFiles === 1 ? '' : 's'}` : 'No player data detected'}</dd></div>
      <div><dt>Plugins</dt><dd>{inspection.plugins.length}</dd></div>
      <div><dt>Mods</dt><dd>{inspection.mods.length}</dd></div>
      <div><dt>Files</dt><dd>{inspection.fileCount.toLocaleString()} · {formatBytes(inspection.totalBytes)}</dd></div>
      <div><dt>Existing EULA file</dt><dd>{inspection.eulaAccepted ? 'Accepted in source' : 'Not accepted / missing'}</dd></div>
    </dl>
    <FindingList inspection={inspection} />
  </section>;
}

export function ImportServerPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<SourceMode>('directory');
  const [directoryPath, setDirectoryPath] = useState('');
  const [archiveName, setArchiveName] = useState('');
  const [uploadId, setUploadId] = useState('');
  const [inspection, setInspection] = useState<ImportInspection>();
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [software, setSoftware] = useState<ProvisionableServerSoftware>('paper');
  const [version, setVersion] = useState('');
  const [port, setPort] = useState('');
  const [memoryMb, setMemoryMb] = useState('2048');
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);

  const adoptInspection = (next: ImportInspection) => {
    setInspection(next);
    setName((current) => current || next.suggestedName);
    setSoftware(inspectedSoftware(next));
    setVersion(next.minecraftVersion ?? '');
    setPort(next.port ? String(next.port) : '');
    setEulaAccepted(false);
  };

  const inspectDirectory = async () => {
    if (!directoryPath.trim()) {
      setError('Enter the absolute path to the existing server directory.');
      return;
    }
    setChecking(true);
    setError(undefined);
    try {
      adoptInspection(await api.inspectImportDirectory(directoryPath.trim()));
    } catch (cause) {
      setInspection(undefined);
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };

  const selectArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setError('Choose a .zip archive exported from an existing server directory.');
      return;
    }
    setChecking(true);
    setError(undefined);
    setArchiveName(file.name);
    setUploadId('');
    setInspection(undefined);
    try {
      const uploaded = await api.uploadImportArchive(file);
      if (!uploaded.uploadId) throw new Error('NodePilot did not return an archive import token.');
      setUploadId(uploaded.uploadId);
      adoptInspection(uploaded.inspection);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
      event.target.value = '';
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!inspection?.canImport) {
      setError('Inspect a source with a runnable server JAR or verified loader launch files before importing.');
      return;
    }
    if (!name.trim()) {
      setError('Give the imported server a name.');
      return;
    }
    if (!version.trim()) {
      setError('Confirm the Minecraft version. It can be corrected manually when detection is uncertain.');
      return;
    }
    const normalizedPort = port.trim() ? Number(port) : undefined;
    const normalizedMemory = Number(memoryMb);
    if (normalizedPort !== undefined && (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535)) {
      setError('Port must be a whole number from 1 to 65,535.');
      return;
    }
    if (!Number.isInteger(normalizedMemory) || normalizedMemory < 256 || normalizedMemory > 65_536) {
      setError('Maximum memory must be a whole number from 256 to 65,536 MB.');
      return;
    }
    if (!eulaAccepted) {
      setError('Minecraft’s EULA must be explicitly accepted before importing a server.');
      return;
    }
    if (mode === 'archive' && !uploadId) {
      setError('Upload the ZIP archive again before importing.');
      return;
    }
    setImporting(true);
    setError(undefined);
    try {
      const result = await api.importServer({
        source: mode === 'directory' ? { type: 'directory', path: directoryPath.trim() } : { type: 'archive', uploadId },
        name: name.trim(),
        software,
        version: version.trim(),
        port: normalizedPort,
        memoryMb: normalizedMemory,
        eulaAccepted: true,
      });
      if (!result.server.id) throw new Error('The server was copied, but NodePilot did not return its identifier.');
      navigate(`/servers/${encodeURIComponent(result.server.id)}`, { state: { importWarnings: result.warnings } });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
    }
  };

  return <section className="import-page page-enter">
    <div className="creation-topline"><Link to="/servers" className="back-link"><Icon name="arrowLeft" size={17} /> Servers</Link><span className="local-pill"><span /> Copy-only import</span></div>
    <div className="page-heading create-heading"><div><p className="eyebrow">EXISTING MINECRAFT SERVER</p><h2>Import a server</h2><p>NodePilot validates then copies your server into a new managed directory. The original stays untouched.</p></div></div>
    {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={19} /><div><strong>Couldn’t import that source.</strong><span>{error}</span></div><button type="button" className="text-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    <div className="import-layout">
      <form className="import-main" onSubmit={submit}>
        <section className="panel import-source-panel">
          <div className="section-heading"><div><p className="eyebrow">1 · SELECT SOURCE</p><h3>Where is the existing server?</h3><p>Choose a local directory or upload a ZIP archive. ZIP entries and links are inspected before extraction.</p></div></div>
          <div className="source-mode-tabs"><button type="button" className={mode === 'directory' ? 'is-selected' : ''} onClick={() => { setMode('directory'); setError(undefined); }}><Icon name="folder" size={17} /> Local directory</button><button type="button" className={mode === 'archive' ? 'is-selected' : ''} onClick={() => { setMode('archive'); setError(undefined); }}><Icon name="file" size={17} /> ZIP archive</button></div>
          {mode === 'directory' ? <div className="import-source-input"><label className="field-group form-field"><span>Absolute folder path</span><input value={directoryPath} onChange={(event) => { setDirectoryPath(event.target.value); setInspection(undefined); }} placeholder={navigator.platform.toLowerCase().includes('win') ? 'C:\\Minecraft\\my-server' : '/home/you/minecraft/my-server'} /><small className="input-note">The folder is read-only during inspection and copied during import. Links and NodePilot-managed directories are refused.</small></label><button className="button button-secondary" type="button" onClick={() => void inspectDirectory()} disabled={checking}>{checking ? <><span className="button-loader" /> Inspecting…</> : 'Inspect directory'}</button></div> : <label className="archive-dropzone"><input type="file" accept=".zip,application/zip" onChange={(event) => void selectArchive(event)} disabled={checking} /><Icon name="files" size={28} /><strong>{checking ? 'Uploading and validating archive…' : archiveName || 'Choose a ZIP archive'}</strong><span>Archives are streamed locally, path-checked, size-limited, and never extracted over existing files.</span></label>}
        </section>
        {inspection && <InspectionSummary inspection={inspection} />}
        {inspection && <section className="panel import-config-panel">
          <div className="section-heading"><div><p className="eyebrow">2 · CONFIRM CONFIGURATION</p><h3>Managed copy settings</h3><p>Detection can be uncertain. Confirm the software and version used by the existing server.</p></div></div>
          <div className="form-grid">
            <label className="field-group form-field form-field-wide"><span>Server name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></label>
            <div className="field-group form-field">
              <span>NodePilot software</span>
              <CustomSelect
                value={software}
                onChange={(val) => setSoftware(val as ProvisionableServerSoftware)}
                options={supportedSoftware.map((item) => ({ value: item.id, label: item.label }))}
                aria-label="NodePilot software"
              />
              <small className="input-note">Controls compatibility checks. Detected loader startup files are retained separately.</small>
            </div>
            <label className="field-group form-field"><span>Minecraft version</span><input value={version} onChange={(event) => setVersion(event.target.value.replace(/[^A-Za-z0-9._-]/g, ''))} placeholder="1.21.4" /></label>
            <label className="field-group form-field"><span>Game port <em>optional</em></span><input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} placeholder="Auto-select" /><small className="input-note">The original port is retained when free; otherwise NodePilot updates only the managed copy.</small></label>
            <div className="field-group form-field">
              <span>Maximum memory (MB)</span>
              <input inputMode="numeric" value={memoryMb} onChange={(event) => setMemoryMb(event.target.value.replace(/[^0-9]/g, ''))} />
              <div className="memory-presets" style={{ marginTop: '6px' }} aria-label="Memory presets">
                {[1_024, 2_048, 4_096, 6_144, 8_192, 12_288, 16_384].map((preset) => (
                  <button
                    className={Number(memoryMb) === preset ? 'is-selected' : ''}
                    type="button"
                    key={preset}
                    onClick={() => setMemoryMb(String(preset))}
                  >
                    {preset >= 1_024 ? `${preset / 1_024} GB` : `${preset} MB`}
                  </button>
                ))}
              </div>
              <small className="input-note">The Java heap ceiling; it can be changed again while stopped.</small>
            </div>
          </div>
          <label className={`eula-agreement ${eulaAccepted ? 'is-accepted' : ''}`}><input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} /><span className="checkbox-mark"><Icon name="check" size={15} /></span><span><strong>I accept the Minecraft EULA for this managed copy</strong><small>NodePilot will set eula=true only in the copied server directory. Your original source remains unchanged.</small></span></label>
          <div className="import-submit-row"><div className="safe-note"><Icon name="check" size={17} /><span>Source files are copied, never moved or overwritten.</span></div><button className="button button-primary" type="submit" disabled={importing || !inspection.canImport || !eulaAccepted}>{importing ? <><span className="button-loader" /> Copying server…</> : <><Icon name="plus" size={17} /> Import server</>}</button></div>
        </section>}
      </form>
      <aside className="import-aside"><section className="panel aside-card"><div className="aside-icon"><Icon name="files" size={20} /></div><h3>What is preserved</h3><ul className="check-list"><li><Icon name="check" size={16} /> Worlds and player data</li><li><Icon name="check" size={16} /> server.properties and configuration</li><li><Icon name="check" size={16} /> Existing plugins and mods</li><li><Icon name="check" size={16} /> Original source left untouched</li></ul></section><section className="panel aside-card subtle-card"><Icon name="warning" size={20} /><div><h3>About loader detection</h3><p>Fabric, Forge, NeoForge, and Quilt launch files are retained when they can be verified. Review any detection warning before starting an imported modded server.</p></div></section></aside>
    </div>
  </section>;
}
