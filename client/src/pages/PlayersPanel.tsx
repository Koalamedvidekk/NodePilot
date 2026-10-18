import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { api } from '../api';
import { CustomSelect } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import type { ManagedPlayer, PlayerAction, PlayerBridgeSetup, PlayerDetails, PlayerList, Server } from '../types';
import { errorMessage, formatDate, titleCase } from '../utils';

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const;

function playerReference(player: ManagedPlayer): string {
  return player.uuid ?? player.name;
}

function coordinate(value?: number): string {
  return value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function actionLabel(action: PlayerAction): string {
  return action === 'deop' ? 'De-op' : action === 'unban' ? 'Unban' : action[0].toUpperCase() + action.slice(1);
}

function BridgeSetupCard({ setup, onDismiss }: { setup: PlayerBridgeSetup; onDismiss: () => void }) {
  const config = `nodepilot-url: ${setup.config.nodepilotUrl}\nserver-id: ${setup.config.serverId}\ntoken: ${setup.config.token}\n`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <div className="bridge-setup-card" role="status">
    <div className="bridge-setup-heading"><div><Icon name="check" size={19} /><div><strong>Bridge credential created</strong><span>Copy this once into <code>plugins/NodePilotBridge/config.yml</code>. The secret is not stored in NodePilot and will not be shown again after you dismiss this card.</span></div></div><button type="button" className="text-button" onClick={onDismiss}>Dismiss</button></div>
    <pre>{config}</pre>
    <div className="bridge-setup-actions"><button type="button" className="button button-secondary" onClick={() => void copy()}><Icon name="copy" size={15} /> {copied ? 'Copied' : 'Copy config'}</button><span>Companion source: <code>companion/nodepilot-paper-bridge</code></span></div>
  </div>;
}

function PlayerIdentity({ player, compact = false }: { player: ManagedPlayer; compact?: boolean }) {
  return <div className={`player-identity ${compact ? 'is-compact' : ''}`}>
    {player.skinUrl ? <img src={player.skinUrl} alt="" width="38" height="38" /> : <div className="player-avatar-fallback">{player.name.slice(0, 1).toUpperCase()}</div>}
    <div><strong>{player.name}</strong><span>{player.uuid ?? 'UUID unavailable'}</span></div>
  </div>;
}

export function PlayersPanel({ server }: { server: Server }) {
  const [data, setData] = useState<PlayerList>();
  const [selected, setSelected] = useState<PlayerDetails>();
  const [loading, setLoading] = useState(true);
  const [loadingPlayer, setLoadingPlayer] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [bridgeSetup, setBridgeSetup] = useState<PlayerBridgeSetup>();
  const [gameMode, setGameMode] = useState<'survival' | 'creative' | 'adventure' | 'spectator'>('survival');
  const [teleport, setTeleport] = useState({ x: '', y: '', z: '' });
  const [inventoryEdit, setInventoryEdit] = useState({ slot: '0', itemId: 'minecraft:stone', count: '1' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await api.players(server.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (selected?.gameMode && GAME_MODES.includes(selected.gameMode as typeof GAME_MODES[number])) setGameMode(selected.gameMode as typeof GAME_MODES[number]);
    if (selected?.location) setTeleport({ x: String(Math.round(selected.location.x ?? 0)), y: String(Math.round(selected.location.y ?? 64)), z: String(Math.round(selected.location.z ?? 0)) });
  }, [selected?.gameMode, selected?.location?.x, selected?.location?.y, selected?.location?.z]);

  const selectPlayer = async (player: ManagedPlayer) => {
    setLoadingPlayer(true);
    setError(undefined);
    try {
      setSelected(await api.player(server.id, playerReference(player)));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingPlayer(false);
    }
  };

  const refreshSelected = async (reference: string) => {
    try { setSelected(await api.player(server.id, reference)); } catch { setSelected(undefined); }
  };

  const execute = async (action: PlayerAction, input: Parameters<typeof api.playerAction>[3] = {}, confirmText?: string) => {
    if (!selected || busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.playerAction(server.id, selected, action, input);
      setNotice(result.message);
      await Promise.all([load(), refreshSelected(playerReference(selected))]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const reasonAction = (action: 'kick' | 'ban') => {
    if (!selected) return;
    const reason = window.prompt(`${actionLabel(action)} reason (optional):`, '') ?? undefined;
    if (reason === undefined) return;
    void execute(action, { reason }, `${actionLabel(action)} ${selected.name}?`);
  };

  const createBridgeCredential = async () => {
    if (!data?.capabilities.bridge.available || busy) return;
    const rotating = data.capabilities.bridge.configured;
    if (!window.confirm(rotating ? 'Rotate the bridge credential? The existing Paper bridge will disconnect until its config is updated.' : 'Create a credential for the NodePilot Paper bridge?')) return;
    setBusy('bridge');
    setError(undefined);
    try {
      const setup = await api.createPlayerBridgeCredentials(server.id);
      setBridgeSetup(setup);
      setData((current) => current ? { ...current, capabilities: { ...current.capabilities, bridge: setup.bridge } } : current);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const submitTeleport = (event: FormEvent) => {
    event.preventDefault();
    const x = Number(teleport.x); const y = Number(teleport.y); const z = Number(teleport.z);
    if (![x, y, z].every(Number.isFinite)) {
      setError('Enter numeric X, Y, and Z coordinates.');
      return;
    }
    void execute('teleport', { teleport: { x, y, z } }, `Teleport ${selected?.name ?? 'this player'} to ${x}, ${y}, ${z}?`);
  };

  const submitInventory = (event: FormEvent) => {
    event.preventDefault();
    const slot = Number(inventoryEdit.slot); const count = Number(inventoryEdit.count);
    if (!Number.isInteger(slot) || !Number.isInteger(count) || count < 1 || count > 64 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(inventoryEdit.itemId)) {
      setError('Provide a valid slot, namespaced item ID (for example minecraft:stone), and count from 1 to 64.');
      return;
    }
    void execute('inventory', { inventory: [{ slot, itemId: inventoryEdit.itemId, count }] }, `Replace slot ${slot} for ${selected?.name ?? 'this player'} with ${count} ${inventoryEdit.itemId}?`);
  };

  const onlineCount = useMemo(() => data?.players.filter((player) => player.online).length ?? 0, [data?.players]);
  const bridge = data?.capabilities.bridge;
  const actionLocked = !data?.capabilities.commandActions || Boolean(busy);

  return <section className="players-panel panel management-panel">
    <div className="panel-heading players-heading"><div><p className="eyebrow">PLAYER MANAGEMENT</p><h3>Players</h3><p>Browse known player data, manage the live server, and use the optional Paper bridge for real-time state and inventory changes.</p></div><div className="panel-heading-actions"><span className="players-online-count"><span /> {onlineCount} online</span><button type="button" className="button button-secondary button-icon" onClick={() => void load()} disabled={loading || Boolean(busy)}><Icon name="refresh" size={16} /> Refresh</button></div></div>
    {error && <div className="inline-alert alert-error" role="alert"><Icon name="warning" size={18} /><div><strong>Player action failed.</strong><span>{error}</span></div><button type="button" className="text-button" onClick={() => setError(undefined)}>Dismiss</button></div>}
    {notice && <div className="inline-alert alert-info" role="status"><Icon name="check" size={18} /><div><strong>Action sent.</strong><span>{notice}</span></div><button type="button" className="text-button" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
    {bridgeSetup && <BridgeSetupCard setup={bridgeSetup} onDismiss={() => setBridgeSetup(undefined)} />}
    {bridge && <div className={`bridge-status ${bridge.connected ? 'is-connected' : ''}`}><div className="bridge-status-copy"><Icon name={bridge.connected ? 'check' : 'info'} size={18} /><div><strong>{bridge.connected ? 'NodePilot Paper bridge connected' : bridge.available ? bridge.configured ? 'Paper bridge is waiting to connect' : 'Enable deeper Paper controls' : 'Paper bridge unavailable'}</strong><span>{bridge.connected ? `Live player state and inventory editing are available${bridge.pluginVersion ? ` through Bridge ${bridge.pluginVersion}` : ''}.` : bridge.message ?? (bridge.configured ? 'Start the server after placing the bridge plugin and its credential file.' : 'Install the companion plugin to unlock live health, location, and inventory controls.')}</span></div></div>{bridge.available && !bridge.connected && <button type="button" className="button button-secondary" onClick={() => void createBridgeCredential()} disabled={busy === 'bridge'}>{busy === 'bridge' ? 'Creating...' : bridge.configured ? 'Rotate credential' : 'Create credential'}</button>}</div>}
    {data?.bridgeWarning && <div className="input-note player-bridge-warning"><Icon name="warning" size={14} /> {data.bridgeWarning}</div>}
    {!data?.capabilities.commandActions && <div className="inline-alert alert-info"><Icon name="info" size={18} /><div><strong>Start the server to use player actions.</strong><span>NodePilot can still read saved player records while this server is stopped.</span></div></div>}
    {loading ? <div className="players-loading"><span className="loading-bar" /><span className="loading-bar" /></div> : <div className="players-workspace">
      <div className="players-list-wrap"><div className="players-list-header"><strong>Known players</strong><span>{data?.players.length ?? 0} total</span></div><div className="players-list">{data?.players.map((player) => <button type="button" key={playerReference(player)} className={`player-list-row ${selected && playerReference(selected) === playerReference(player) ? 'is-selected' : ''}`} onClick={() => void selectPlayer(player)}><span className={`online-dot ${player.online ? 'is-online' : ''}`} /><PlayerIdentity player={player} compact /><span className="player-row-flags">{player.op && <b>OP</b>}{player.banned && <b className="is-ban">BAN</b>}</span></button>)}{!data?.players.length && <div className="players-empty"><Icon name="users" size={27} /><strong>No player data yet</strong><span>Player records appear after people join this server. Saved player data is preserved on imports.</span></div>}</div></div>
      <div className="player-detail">{loadingPlayer && <div className="player-detail-empty"><span className="button-loader" /> Loading player details...</div>}{!loadingPlayer && !selected && <div className="player-detail-empty"><Icon name="users" size={30} /><strong>Select a player</strong><span>Choose a known player to view saved data and management controls.</span></div>}{!loadingPlayer && selected && <>
        <div className="player-detail-heading"><PlayerIdentity player={selected} /><div className="player-live-label"><span className={`online-dot ${selected.online ? 'is-online' : ''}`} /> {selected.online ? 'Online' : 'Offline'} · {selected.dataSource === 'bridge' ? 'Live bridge data' : selected.dataSource === 'offline' ? 'Saved player data' : 'Server cache'}</div></div>
        <div className="player-stat-grid"><div><span>Health</span><strong>{selected.health === undefined ? '—' : `${selected.health.toFixed(1)} / 20`}</strong></div><div><span>Hunger</span><strong>{selected.hunger === undefined ? '—' : `${selected.hunger} / 20`}</strong></div><div><span>XP level</span><strong>{selected.xpLevel ?? '—'}</strong></div><div><span>Game mode</span><strong>{titleCase(selected.gameMode)}</strong></div><div className="player-location"><span>Location</span><strong>{selected.location ? `${coordinate(selected.location.x)}, ${coordinate(selected.location.y)}, ${coordinate(selected.location.z)}` : '—'}</strong><small>{selected.location?.world ?? 'World unavailable'}</small></div><div><span>Last cached</span><strong>{formatDate(selected.lastSeen)}</strong></div></div>
        <div className="player-actions-section"><div className="player-section-title"><h4>Server actions</h4><p>Console actions work on running Minecraft servers. Actions that change access ask for confirmation.</p></div><div className="player-action-buttons"><button className="button button-secondary" type="button" disabled={actionLocked || selected.op} onClick={() => void execute('op', {}, `Grant operator access to ${selected.name}?`)}>Op</button><button className="button button-secondary" type="button" disabled={actionLocked || !selected.op} onClick={() => void execute('deop', {}, `Remove operator access from ${selected.name}?`)}>De-op</button><button className="button button-secondary" type="button" disabled={actionLocked} onClick={() => reasonAction('kick')}>Kick</button><button className="button button-danger-outline" type="button" disabled={actionLocked || selected.banned} onClick={() => reasonAction('ban')}>Ban</button><button className="button button-secondary" type="button" disabled={actionLocked || !selected.banned} onClick={() => void execute('unban', {}, `Unban ${selected.name}?`)}>Unban</button><button className="button button-secondary" type="button" disabled={actionLocked} onClick={() => void execute('heal')}>Heal</button></div></div>
        <div className="player-control-grid"><form className="player-control-card" onSubmit={(event) => { event.preventDefault(); void execute('gamemode', { gamemode: gameMode }, `Set ${selected.name}'s game mode to ${gameMode}?`); }}><div><h4>Game mode</h4><p>Uses the server command or the Paper bridge when connected.</p></div><div className="player-control-action"><CustomSelect value={gameMode} onChange={(val) => setGameMode(val as typeof gameMode)} disabled={actionLocked} options={GAME_MODES.map((mode) => ({ value: mode, label: titleCase(mode) }))} aria-label="Game mode" className="player-gamemode-select" /><button className="button button-secondary" type="submit" disabled={actionLocked}>Apply</button></div></form><form className="player-control-card" onSubmit={submitTeleport}><div><h4>Teleport</h4><p>{bridge?.connected ? 'Bridge preserves the player’s current world context.' : 'Uses coordinates in the server’s default command context.'}</p></div><div className="teleport-fields"><input value={teleport.x} onChange={(event) => setTeleport((current) => ({ ...current, x: event.target.value }))} inputMode="decimal" aria-label="Teleport X" placeholder="X" disabled={actionLocked} /><input value={teleport.y} onChange={(event) => setTeleport((current) => ({ ...current, y: event.target.value }))} inputMode="decimal" aria-label="Teleport Y" placeholder="Y" disabled={actionLocked} /><input value={teleport.z} onChange={(event) => setTeleport((current) => ({ ...current, z: event.target.value }))} inputMode="decimal" aria-label="Teleport Z" placeholder="Z" disabled={actionLocked} /><button className="button button-secondary" type="submit" disabled={actionLocked}>Teleport</button></div></form></div>
        <div className="inventory-section"><div className="player-section-title"><div><h4>Inventory</h4><p>{selected.inventoryMessage ?? (selected.inventorySource === 'bridge' ? 'Live inventory from the Paper bridge.' : 'Saved inventory from player data.')}</p></div><span className={`inventory-source ${selected.inventorySource ?? 'unavailable'}`}>{selected.inventorySource === 'bridge' ? 'Live bridge' : selected.inventorySource === 'offline' ? 'Saved data' : 'Unavailable'}</span></div><div className="inventory-grid">{selected.inventory?.map((item) => <div className="inventory-item" key={`${item.slot}-${item.itemId}`}><span className="inventory-slot">{item.slot}</span><div><strong>{item.displayName ?? item.itemId.replace(/^minecraft:/, '').replace(/_/g, ' ')}</strong><small>{item.itemId} · ×{item.count}</small></div>{data?.capabilities.inventoryModify && selected.online && <button type="button" className="icon-button destructive-soft" title={`Clear slot ${item.slot}`} aria-label={`Clear slot ${item.slot}`} disabled={Boolean(busy)} onClick={() => void execute('inventory', { inventory: [{ slot: item.slot, count: 0 }] }, `Clear slot ${item.slot} for ${selected.name}?`)}><Icon name="trash" size={15} /></button>}</div>)}{!selected.inventory?.length && <div className="inventory-empty">No readable inventory items were found.</div>}</div>{data?.capabilities.inventoryModify && selected.online ? <form className="inventory-edit" onSubmit={submitInventory}><strong>Replace a slot</strong><input value={inventoryEdit.slot} onChange={(event) => setInventoryEdit((current) => ({ ...current, slot: event.target.value.replace(/[^0-9-]/g, '') }))} inputMode="numeric" placeholder="Slot" aria-label="Inventory slot" /><input value={inventoryEdit.itemId} onChange={(event) => setInventoryEdit((current) => ({ ...current, itemId: event.target.value }))} placeholder="minecraft:stone" aria-label="Minecraft item ID" /><input value={inventoryEdit.count} onChange={(event) => setInventoryEdit((current) => ({ ...current, count: event.target.value.replace(/[^0-9]/g, '') }))} inputMode="numeric" placeholder="Count" aria-label="Item count" /><button className="button button-secondary" type="submit" disabled={Boolean(busy)}>Replace item</button></form> : <p className="inventory-lock"><Icon name="info" size={14} /> {selected.online ? 'Install and connect the NodePilot Paper bridge to modify inventories.' : 'Inventory modifications require the Paper bridge and an online player.'}</p>}</div>
      </>}</div>
    </div>}
  </section>;
}
