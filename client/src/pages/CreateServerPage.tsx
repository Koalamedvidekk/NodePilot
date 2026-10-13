import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import type { JavaDiscovery, MinecraftRequirements, MinecraftVersion, ProvisionableServerSoftware } from '../types';
import { errorMessage, titleCase } from '../utils';

type WizardStep = 1 | 2 | 3;

const steps: Array<{ number: WizardStep; title: string; detail: string }> = [
  { number: 1, title: 'Choose software', detail: 'Pick a Minecraft distribution and version.' },
  { number: 2, title: 'Configure', detail: 'Name the server and review its local runtime.' },
  { number: 3, title: 'Review & create', detail: 'Accept the EULA and create the server.' },
];

const softwareOptions: Array<{ id: ProvisionableServerSoftware; label: string; detail: string; source: string }> = [
  { id: 'vanilla', label: 'Vanilla', detail: 'Official Minecraft server', source: 'Mojang release metadata' },
  { id: 'paper', label: 'Paper', detail: 'Performance and Bukkit plugins', source: 'Paper downloads service' },
  { id: 'spigot', label: 'Spigot', detail: 'Bukkit plugin ecosystem', source: 'Official BuildTools (Git required)' },
  { id: 'purpur', label: 'Purpur', detail: 'Paper-compatible customization', source: 'Purpur project API' },
  { id: 'fabric', label: 'Fabric', detail: 'Lightweight mod loader', source: 'Fabric Meta and installer' },
  { id: 'forge', label: 'Forge', detail: 'Established mod loader', source: 'Forge Maven installer' },
  { id: 'neoforge', label: 'NeoForge', detail: 'Modern Forge-family loader', source: 'NeoForge Maven installer' },
  { id: 'quilt', label: 'Quilt', detail: 'Fabric-family mod loader', source: 'Quilt Meta and installer' },
];

function latestVersion(versions: MinecraftVersion[]): string {
  return versions.find((version) => version.stable !== false)?.id ?? versions[0]?.id ?? '';
}

function versionRequirement(version: MinecraftVersion | undefined): string | undefined {
  return version?.javaMajor ? `Java ${version.javaMajor}+ required for this version.` : undefined;
}

export function CreateServerPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>(1);
  const [software, setSoftware] = useState<ProvisionableServerSoftware>('paper');
  const [versions, setVersions] = useState<MinecraftVersion[]>([]);
  const [version, setVersion] = useState('');
  const [java, setJava] = useState<JavaDiscovery>();
  const [requirements, setRequirements] = useState<MinecraftRequirements>();
  const [requirementsError, setRequirementsError] = useState<string>();
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [loadingJava, setLoadingJava] = useState(true);
  const [loadingRequirements, setLoadingRequirements] = useState(false);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [memoryMb, setMemoryMb] = useState('2048');
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingVersions(true);
    setError(undefined);
    setVersions([]);
    setVersion('');
    void api.minecraftVersions(software)
      .then((result) => {
        if (!active) return;
        setVersions(result);
        setVersion(latestVersion(result));
      })
      .catch((cause) => active && setError(`Couldn’t load ${titleCase(software)} versions: ${errorMessage(cause)}`))
      .finally(() => active && setLoadingVersions(false));
    return () => { active = false; };
  }, [software]);

  useEffect(() => {
    let active = true;
    setLoadingJava(true);
    void api.java()
      .then((result) => active && setJava(result))
      .catch((cause) => active && setJava({ installations: [], message: errorMessage(cause) }))
      .finally(() => active && setLoadingJava(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!version) {
      setRequirements(undefined);
      return;
    }
    let active = true;
    setLoadingRequirements(true);
    setRequirements(undefined);
    setRequirementsError(undefined);
    void api.minecraftRequirements(software, version)
      .then((result) => active && setRequirements(result))
      .catch((cause) => {
        if (!active) return;
        setRequirements(undefined);
        setRequirementsError(`Couldn’t confirm the Java requirement: ${errorMessage(cause)}`);
      })
      .finally(() => active && setLoadingRequirements(false));
    return () => { active = false; };
  }, [software, version]);

  const selectedVersion = useMemo(() => versions.find((item) => item.id === version), [versions, version]);
  const requiredJava = requirements?.requiredJavaMajor ?? selectedVersion?.javaMajor;
  const compatibleJava = requirements?.compatibleJava ?? java?.installations.filter((item) => !requiredJava || !item.major || item.major >= requiredJava) ?? [];
  const javaReady = Boolean(requirements) && compatibleJava.length > 0;
  const normalizedPort = port.trim() ? Number(port) : undefined;
  const normalizedMemory = memoryMb.trim() ? Number(memoryMb) : undefined;
  const formError = !name.trim()
    ? 'Give the server a name.'
    : !version
      ? 'Choose a Minecraft version.'
      : normalizedPort !== undefined && (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535)
        ? 'Port must be a whole number from 1 to 65535.'
        : normalizedMemory !== undefined && (!Number.isInteger(normalizedMemory) || normalizedMemory < 256)
          ? 'Memory must be at least 256 MB.'
          : undefined;

  const moveForward = () => {
    if (step === 1 && !version) {
      setError('Choose a Minecraft version before continuing.');
      return;
    }
    if (step === 2 && formError) {
      setError(formError);
      return;
    }
    setError(undefined);
    setStep((current) => Math.min(3, current + 1) as WizardStep);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (formError) {
      setError(formError);
      setStep(2);
      return;
    }
    if (!eulaAccepted) {
      setError('Minecraft’s EULA must be accepted before a server can be created.');
      return;
    }
    if (!javaReady) {
      setError(requirementsError ?? `Install Java ${requiredJava ?? ''} or later, then refresh this page.`.trim());
      return;
    }
    setCreating(true);
    setError(undefined);
    try {
      const server = await api.createServer({
        name: name.trim(),
        game: 'minecraft',
        software,
        version,
        port: normalizedPort,
        memoryMb: normalizedMemory,
        eulaAccepted: true,
      });
      if (!server.id) throw new Error('The server was created, but NodePilot did not return its identifier.');
      navigate(`/servers/${encodeURIComponent(server.id)}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="create-page page-enter">
      <div className="creation-topline">
        <Link to="/servers" className="back-link"><Icon name="arrowLeft" size={17} /> Servers</Link>
        <span className="local-pill"><span /> Local setup</span>
      </div>
      <div className="page-heading create-heading">
        <div>
          <p className="eyebrow">NEW LOCAL INSTANCE</p>
          <h2>Create a Minecraft server</h2>
          <p>NodePilot downloads official server files and keeps every file on your machine.</p>
        </div>
      </div>

      <ol className="wizard-steps" aria-label="Server creation steps">
        {steps.map((item) => (
          <li key={item.number} className={step === item.number ? 'is-current' : step > item.number ? 'is-complete' : ''}>
            <span className="step-number">{step > item.number ? <Icon name="check" size={15} /> : item.number}</span>
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
          </li>
        ))}
      </ol>

      <form onSubmit={create} className="creation-layout">
        <section className="panel wizard-panel">
          {error && (
            <div className="inline-alert alert-error" role="alert">
              <Icon name="warning" size={19} />
              <div><strong>Check the server setup.</strong><span>{error}</span></div>
              <button type="button" className="text-button" onClick={() => setError(undefined)}>Dismiss</button>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-section">
              <div className="section-heading"><div><p className="eyebrow">GAME & SOFTWARE</p><h3>Minecraft: Java Edition</h3></div></div>
              <div className="game-selection"><div className="game-tile is-selected"><div className="game-tile-mark"><Icon name="box" size={30} /></div><div><strong>Minecraft Java</strong><span>Official server software for local play</span></div><Icon name="check" size={20} /></div></div>

              <fieldset className="field-group"><legend>Server software</legend><p className="field-help">Choose a supported implementation. NodePilot only offers versions that its trusted source reports for that software.</p>
                <div className="flavor-cards">
                  {softwareOptions.map((option) => <label key={option.id} className={`flavor-card ${software === option.id ? 'is-selected' : ''}`}>
                    <input type="radio" name="software" value={option.id} checked={software === option.id} onChange={() => setSoftware(option.id)} />
                    <span className={`flavor-icon ${option.id}-icon`}>{option.label[0]}</span>
                    <span><strong>{option.label}</strong><small>{option.detail}</small><small className="software-source">{option.source}</small></span>
                    <span className="radio-indicator" />
                  </label>)}
                </div>
              </fieldset>

              <label className="field-group form-field"><span>Minecraft version</span>
                <div className="select-wrap">
                  <select value={version} onChange={(event) => setVersion(event.target.value)} disabled={loadingVersions} aria-label="Minecraft version">
                    {loadingVersions && <option value="">Loading official versions…</option>}
                    {!loadingVersions && versions.length === 0 && <option value="">No versions available</option>}
                    {versions.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.id}{item.stable === false ? ' (pre-release)' : ''}</option>)}
                  </select>
                  <Icon name="chevronDown" size={17} />
                </div>
                {selectedVersion?.releaseDate && <small className="input-note">Released {selectedVersion.releaseDate}</small>}
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-section">
              <div className="section-heading"><div><p className="eyebrow">LOCAL CONFIGURATION</p><h3>Server details</h3></div></div>
              <div className="form-grid">
                <label className="field-group form-field form-field-wide"><span>Server name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="My Minecraft server" /><small className="input-note">Used only in NodePilot. Server files get a safe directory name automatically.</small></label>
                <label className="field-group form-field"><span>Game port <em>optional</em></span><input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} placeholder="Auto-select" /><small className="input-note">Leave blank for a free local port.</small></label>
                <label className="field-group form-field"><span>Memory limit (MB)</span><input inputMode="numeric" value={memoryMb} onChange={(event) => setMemoryMb(event.target.value.replace(/[^0-9]/g, ''))} placeholder="2048" /><small className="input-note">Java heap allocation.</small></label>
              </div>

              <section className={`java-check ${!loadingJava && !javaReady ? 'has-problem' : ''}`}>
                <div className="java-check-icon"><Icon name="java" size={21} /></div>
                <div className="java-check-copy">
                  <strong>{loadingJava || loadingRequirements ? 'Checking local Java…' : requiredJava ? `Java ${requiredJava}+ requirement` : 'Local Java runtime'}</strong>
                  <p>{loadingJava
                    ? 'Searching your PATH and common Java installations.'
                    : !javaReady
                      ? requirementsError ?? `No compatible Java ${requiredJava ?? ''} installation was found. Install Java ${requiredJava ?? ''} or later, then reload NodePilot.`
                      : compatibleJava.length > 0
                        ? `${compatibleJava[0].version}${compatibleJava[0].vendor ? ` · ${compatibleJava[0].vendor}` : ''} is ready for this server.`
                        : java?.message ?? versionRequirement(selectedVersion) ?? 'NodePilot will validate Java again before launching the server.'}</p>
                  {!loadingJava && java?.installations.length === 0 && javaReady && <p className="subtle-warning"><Icon name="info" size={15} /> No Java runtime was reported yet; creation will verify it safely.</p>}
                </div>
                <span className={`java-state ${loadingJava || loadingRequirements ? 'checking' : javaReady ? 'ready' : 'missing'}`}>
                  {loadingJava || loadingRequirements ? 'Checking' : javaReady ? 'Ready' : 'Missing'}
                </span>
              </section>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-section review-section">
              <div className="section-heading"><div><p className="eyebrow">FINAL CHECK</p><h3>Ready to create</h3><p>NodePilot will create the directory, download the server JAR, write configuration, and persist this server locally.</p></div></div>
              <dl className="review-list">
                <div><dt>Server</dt><dd>{name || 'Unnamed server'}</dd></div>
                <div><dt>Software</dt><dd>{titleCase(software)} {version || '—'}</dd></div>
                <div><dt>Port</dt><dd>{normalizedPort ?? 'Auto-select a free port'}</dd></div>
                <div><dt>Memory</dt><dd>{normalizedMemory ? `${normalizedMemory} MB` : 'NodePilot default'}</dd></div>
                <div><dt>Java</dt><dd>{requiredJava ? `Java ${requiredJava}+` : 'Validated on create'}</dd></div>
              </dl>
              <label className={`eula-agreement ${eulaAccepted ? 'is-accepted' : ''}`}>
                <input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} />
                <span className="checkbox-mark"><Icon name="check" size={15} /></span>
                <span><strong>I accept the Minecraft EULA</strong><small>By creating this server, you agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft End User License Agreement</a>. NodePilot will write this acceptance to this server only.</small></span>
              </label>
              <div className="safe-note prominent-safe-note"><Icon name="check" size={17} /><span>This is a local-only installation. NodePilot does not upload your server files or EULA acceptance.</span></div>
            </div>
          )}

          <div className="wizard-actions">
            {step > 1 ? <button type="button" className="button button-secondary" onClick={() => { setError(undefined); setStep((current) => (current - 1) as WizardStep); }} disabled={creating}><Icon name="arrowLeft" size={17} /> Back</button> : <Link className="button button-ghost" to="/servers">Cancel</Link>}
            {step < 3 ? <button type="button" className="button button-primary" onClick={moveForward} disabled={loadingVersions}>{step === 1 ? 'Continue' : 'Review server'} <Icon name="chevronRight" size={17} /></button> : <button type="submit" className="button button-primary create-submit" disabled={creating || !eulaAccepted || !javaReady}>{creating ? <><span className="button-loader" /> Creating server…</> : <><Icon name="plus" size={18} /> Create server</>}</button>}
          </div>
        </section>

        <aside className="creation-aside">
          <section className="panel aside-card">
            <div className="aside-icon"><Icon name="folder" size={20} /></div>
            <h3>What NodePilot sets up</h3>
            <ul className="check-list"><li><Icon name="check" size={16} /> A protected local server directory</li><li><Icon name="check" size={16} /> Trusted server files or an official loader installer</li><li><Icon name="check" size={16} /> A valid server.properties file</li><li><Icon name="check" size={16} /> Persistent runtime configuration</li></ul>
          </section>
          <section className="panel aside-card subtle-card">
            <Icon name="circleHelp" size={20} />
            <div><h3>Need a particular port?</h3><p>Leave it blank to let NodePilot choose a free one. A requested port is checked before anything is started.</p></div>
          </section>
        </aside>
      </form>
    </section>
  );
}
