import { readFile, readdir, lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import * as nbt from 'prismarine-nbt';

import { AppError } from '../lib/errors.js';
import { resolveInside, resolveManagedServerRoot } from '../lib/paths.js';
import type { ServerRuntime } from './server-runtime.js';
import type { ServerEvent, ServerRecord } from '../types.js';
import { PlayerBridgeManager, type BridgeStatus } from './player-bridge.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PLAYER_DATA_BYTES = 20 * 1024 * 1024;
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export type PlayerLocation = {
  world?: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
};

export type PlayerInventoryItem = {
  slot: number;
  itemId: string;
  count: number;
  displayName?: string;
};

export type PlayerRecord = {
  uuid?: string;
  name: string;
  online: boolean;
  op: boolean;
  banned: boolean;
  skinUrl?: string;
  lastSeen?: string;
  health?: number;
  hunger?: number;
  xpLevel?: number;
  xpProgress?: number;
  gameMode?: string;
  location?: PlayerLocation;
  dataSource: 'bridge' | 'offline' | 'cache';
};

export type PlayerDetails = PlayerRecord & {
  inventory?: PlayerInventoryItem[];
  inventorySource?: 'bridge' | 'offline';
  inventoryMessage?: string;
};

export type PlayerAction = 'op' | 'deop' | 'kick' | 'ban' | 'unban' | 'heal' | 'teleport' | 'gamemode' | 'inventory';

export type PlayerActionInput = {
  reason?: string;
  gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator';
  teleport?: { x: number; y: number; z: number; world?: string };
  inventory?: Array<{ slot: number; itemId?: string; count?: number }>;
};

type CachedPlayer = { uuid?: string; name: string; expiresOn?: string };
type StoredOperator = { uuid?: string; name?: string };
type StoredBan = { uuid?: string; name?: string; created?: string };

type OfflinePlayerData = {
  health?: number;
  hunger?: number;
  xpLevel?: number;
  xpProgress?: number;
  gameMode?: string;
  location?: PlayerLocation;
  inventory?: PlayerInventoryItem[];
};

type LivePlayer = PlayerRecord & { inventory?: PlayerInventoryItem[] };

export function canonicalUuid(value: string | undefined): string | undefined {
  if (!value || !UUID.test(value)) return undefined;
  const compact = value.replace(/-/g, '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function gameModeFromId(value: unknown): string | undefined {
  const id = numberValue(value);
  if (id === 0) return 'survival';
  if (id === 1) return 'creative';
  if (id === 2) return 'adventure';
  if (id === 3) return 'spectator';
  return undefined;
}

function skinUrl(uuid: string | undefined): string | undefined {
  return uuid ? `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/96` : undefined;
}

function strictPlayerName(value: unknown): string | undefined {
  return typeof value === 'string' && PLAYER_NAME.test(value) ? value : undefined;
}

function parseInventory(value: unknown): PlayerInventoryItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry): PlayerInventoryItem[] => {
    const item = objectValue(entry);
    const slot = numberValue(item.Slot ?? item.slot);
    const itemId = stringValue(item.id ?? item.itemId ?? item.type);
    const count = numberValue(item.Count ?? item.count);
    if (slot === undefined || !itemId || count === undefined || count <= 0) return [];
    const display = stringValue(item.displayName ?? objectValue(item.components)['minecraft:custom_name']);
    return [{ slot, itemId: itemId.slice(0, 160), count: Math.min(Math.floor(count), 64), displayName: display?.slice(0, 200) }];
  });
  return items.sort((left, right) => left.slot - right.slot);
}

function parseOfflineData(value: unknown): OfflinePlayerData {
  const data = objectValue(value);
  const pos = Array.isArray(data.Pos) ? data.Pos : Array.isArray(data.pos) ? data.pos : [];
  const rotation = Array.isArray(data.Rotation) ? data.Rotation : Array.isArray(data.rotation) ? data.rotation : [];
  const x = numberValue(pos[0]);
  const y = numberValue(pos[1]);
  const z = numberValue(pos[2]);
  const location = x === undefined || y === undefined || z === undefined ? undefined : {
    world: stringValue(data.Dimension ?? data.dimension),
    x,
    y,
    z,
    yaw: numberValue(rotation[0]),
    pitch: numberValue(rotation[1]),
  };
  return {
    health: numberValue(data.Health ?? data.health),
    hunger: numberValue(data.foodLevel ?? data.hunger),
    xpLevel: numberValue(data.XpLevel ?? data.xpLevel),
    xpProgress: numberValue(data.XpP ?? data.xpProgress),
    gameMode: stringValue(data.gameMode) ?? gameModeFromId(data.playerGameType ?? data.gameType),
    location,
    inventory: parseInventory(data.Inventory ?? data.inventory),
  };
}

function parseLivePlayer(value: unknown): LivePlayer | undefined {
  const raw = objectValue(value);
  const name = strictPlayerName(raw.name);
  if (!name) return undefined;
  const uuid = canonicalUuid(stringValue(raw.uuid));
  const locationRaw = objectValue(raw.location);
  const x = numberValue(locationRaw.x);
  const y = numberValue(locationRaw.y);
  const z = numberValue(locationRaw.z);
  const location = x === undefined || y === undefined || z === undefined ? undefined : {
    world: stringValue(locationRaw.world), x, y, z, yaw: numberValue(locationRaw.yaw), pitch: numberValue(locationRaw.pitch),
  };
  return {
    uuid,
    name,
    online: raw.online !== false,
    op: raw.op === true,
    banned: raw.banned === true,
    skinUrl: skinUrl(uuid),
    health: numberValue(raw.health),
    hunger: numberValue(raw.hunger),
    xpLevel: numberValue(raw.xpLevel),
    xpProgress: numberValue(raw.xpProgress),
    gameMode: stringValue(raw.gameMode),
    location,
    dataSource: 'bridge',
    inventory: parseInventory(raw.inventory),
  };
}

async function parseJsonArray(root: string, relative: string): Promise<unknown[]> {
  try {
    const target = await resolveInside(root, relative);
    const details = await stat(target);
    if (!details.isFile() || details.size > MAX_JSON_BYTES) return [];
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readCachedPlayers(values: unknown[]): CachedPlayer[] {
  return values.flatMap((value): CachedPlayer[] => {
    const entry = objectValue(value);
    const name = strictPlayerName(entry.name);
    if (!name) return [];
    return [{ uuid: canonicalUuid(stringValue(entry.uuid)), name, expiresOn: stringValue(entry.expiresOn) }];
  });
}

function playerIds(values: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const entry = objectValue(value);
    const uuid = canonicalUuid(stringValue(entry.uuid));
    if (uuid) ids.add(uuid);
  }
  return ids;
}

function playerNames(values: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    const name = strictPlayerName(objectValue(value).name);
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

function bridgePlayers(value: unknown): LivePlayer[] {
  const raw = objectValue(value);
  const players = Array.isArray(raw.players) ? raw.players : [];
  return players.flatMap((player): LivePlayer[] => {
    const parsed = parseLivePlayer(player);
    return parsed ? [parsed] : [];
  });
}

function bridgePlayer(value: unknown): LivePlayer | undefined {
  return parseLivePlayer(objectValue(value).player ?? value);
}

function safeReason(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 160 || /[^\p{L}\p{N} .,!?()'"_-]/u.test(normalized)) {
    throw new AppError(400, 'invalid_player_reason', 'Reasons may use letters, numbers, spaces, and basic punctuation up to 160 characters.');
  }
  return normalized;
}

function commandTarget(player: PlayerRecord): string {
  if (!PLAYER_NAME.test(player.name)) {
    throw new AppError(422, 'player_name_unavailable', 'This saved player record has no usable Minecraft name. Connect the Paper bridge to manage it by UUID.');
  }
  return player.name;
}

function directCommand(action: PlayerAction, player: PlayerRecord, input: PlayerActionInput): string | undefined {
  const target = commandTarget(player);
  if (action === 'op') return `op ${target}`;
  if (action === 'deop') return `deop ${target}`;
  if (action === 'kick') return `kick ${target}${safeReason(input.reason) ? ` ${safeReason(input.reason)}` : ''}`;
  if (action === 'ban') return `ban ${target}${safeReason(input.reason) ? ` ${safeReason(input.reason)}` : ''}`;
  if (action === 'unban') return `pardon ${target}`;
  if (action === 'heal') return `effect give ${target} minecraft:instant_health 1 255 true`;
  if (action === 'gamemode' && input.gamemode) return `gamemode ${input.gamemode} ${target}`;
  if (action === 'teleport' && input.teleport) {
    const { x, y, z } = input.teleport;
    return `tp ${target} ${x} ${y} ${z}`;
  }
  return undefined;
}

export class PlayerService {
  private readonly onlineNames = new Map<string, Set<string>>();
  private readonly lastListCommand = new Map<string, number>();

  constructor(
    private readonly serversDirectory: string,
    private readonly runtime: ServerRuntime,
    private readonly bridge: PlayerBridgeManager,
  ) {
    this.runtime.on('event', (event: ServerEvent) => this.observeRuntime(event));
  }

  getOnlinePlayerCount(serverId: string): number {
    return this.onlineNames.get(serverId)?.size ?? 0;
  }

  bridgeStatus(server: ServerRecord): BridgeStatus & { available: boolean; message?: string } {
    const status = this.bridge.status(server.id);
    if (server.software !== 'paper') {
      return { ...status, available: false, message: 'The NodePilot Bridge is a Paper plugin. Vanilla and mod-loader servers can use command-based player actions only.' };
    }
    return { ...status, available: true };
  }

  createBridgeCredentials(server: ServerRecord): { token: string; createdAt: string; rotatedAt: string } {
    if (server.software !== 'paper') {
      throw new AppError(422, 'bridge_unsupported', 'The NodePilot Bridge can only be installed on Paper servers.');
    }
    return this.bridge.credentials(server.id);
  }

  async list(server: ServerRecord): Promise<{
    players: PlayerRecord[];
    capabilities: {
      commandActions: boolean;
      offlineData: boolean;
      inventoryView: boolean;
      inventoryModify: boolean;
      bridge: ReturnType<PlayerService['bridgeStatus']>;
    };
    bridgeWarning?: string;
  }> {
    const root = await resolveManagedServerRoot(this.serversDirectory, server.directory);
    const [cachedRaw, operatorsRaw, bansRaw, uuids] = await Promise.all([
      parseJsonArray(root, 'usercache.json'),
      parseJsonArray(root, 'ops.json'),
      parseJsonArray(root, 'banned-players.json'),
      this.playerDataUuids(root),
    ]);
    const cached = readCachedPlayers(cachedRaw);
    const ops = playerIds(operatorsRaw);
    const opNames = playerNames(operatorsRaw);
    const bans = playerIds(bansRaw);
    const banNames = playerNames(bansRaw);
    const bridge = this.bridgeStatus(server);
    let live: LivePlayer[] = [];
    let bridgeWarning: string | undefined;
    if (bridge.connected) {
      try {
        live = bridgePlayers(await this.bridge.request(server.id, 'players.list', {}));
      } catch (error) {
        bridgeWarning = error instanceof Error ? error.message : 'The Paper bridge did not return player data.';
      }
    } else if (server.status === 'running') {
      this.requestVanillaList(server.id);
    }

    const results = new Map<string, PlayerRecord>();
    const merge = (candidate: PlayerRecord) => {
      const key = candidate.uuid ?? `name:${candidate.name.toLowerCase()}`;
      const existing = results.get(key);
      const uuid = candidate.uuid ?? existing?.uuid;
      const name = candidate.name || existing?.name || 'Unknown';
      const op = candidate.op || existing?.op || Boolean(uuid && ops.has(uuid)) || opNames.has(name.toLowerCase());
      const banned = candidate.banned || existing?.banned || Boolean(uuid && bans.has(uuid)) || banNames.has(name.toLowerCase());
      results.set(key, {
        ...existing,
        ...candidate,
        uuid,
        name,
        op,
        banned,
        skinUrl: candidate.skinUrl ?? existing?.skinUrl ?? skinUrl(uuid),
        dataSource: candidate.dataSource === 'bridge' ? 'bridge' : existing?.dataSource ?? candidate.dataSource,
      });
    };
    for (const entry of cached) merge({ uuid: entry.uuid, name: entry.name, online: false, op: Boolean(entry.uuid && ops.has(entry.uuid)) || opNames.has(entry.name.toLowerCase()), banned: Boolean(entry.uuid && bans.has(entry.uuid)) || banNames.has(entry.name.toLowerCase()), skinUrl: skinUrl(entry.uuid), lastSeen: entry.expiresOn, dataSource: 'cache' });
    for (const uuid of uuids) merge({ uuid, name: cached.find((entry) => entry.uuid === uuid)?.name ?? uuid, online: false, op: ops.has(uuid), banned: bans.has(uuid), skinUrl: skinUrl(uuid), dataSource: 'offline' });
    for (const player of live) merge(player);
    if (!bridge.connected) {
      const online = this.onlineNames.get(server.id) ?? new Set<string>();
      for (const name of online) {
        const known = cached.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        merge({ uuid: known?.uuid, name: known?.name ?? name, online: true, op: Boolean(known?.uuid && ops.has(known.uuid)) || opNames.has(name.toLowerCase()), banned: Boolean(known?.uuid && bans.has(known.uuid)) || banNames.has(name.toLowerCase()), skinUrl: skinUrl(known?.uuid), dataSource: 'cache' });
      }
    }
    const players = [...results.values()].sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
    return {
      players,
      capabilities: {
        commandActions: server.status === 'running',
        offlineData: true,
        inventoryView: bridge.connected || players.some((player) => player.dataSource === 'offline'),
        inventoryModify: bridge.connected,
        bridge,
      },
      bridgeWarning,
    };
  }

  async details(server: ServerRecord, reference: string): Promise<PlayerDetails> {
    const listing = await this.list(server);
    const player = this.findPlayer(listing.players, reference);
    const root = await resolveManagedServerRoot(this.serversDirectory, server.directory);
    let offline: OfflinePlayerData | undefined;
    if (player.uuid) offline = await this.readOfflinePlayer(root, player.uuid);
    let live: LivePlayer | undefined;
    if (listing.capabilities.bridge.connected) {
      try {
        live = bridgePlayer(await this.bridge.request(server.id, 'players.get', { uuid: player.uuid, name: player.name }));
      } catch {
        // A player may have disconnected between list and detail requests. Offline data is still useful.
      }
    }
    const primary = live ?? player;
    return {
      ...player,
      ...offline,
      ...live,
      uuid: live?.uuid ?? player.uuid,
      name: live?.name ?? player.name,
      skinUrl: live?.skinUrl ?? player.skinUrl,
      dataSource: live ? 'bridge' : offline ? 'offline' : player.dataSource,
      inventory: live?.inventory ?? offline?.inventory,
      inventorySource: live?.inventory ? 'bridge' : offline?.inventory ? 'offline' : undefined,
      inventoryMessage: live?.inventory
        ? undefined
        : offline?.inventory
          ? 'Offline inventory is read from the saved player data. Changes require the Paper bridge and an online player.'
          : primary.online
            ? 'Live inventory details require the NodePilot Paper bridge.'
            : 'No saved inventory data was found for this player.',
    };
  }

  async action(server: ServerRecord, reference: string, action: PlayerAction, input: PlayerActionInput): Promise<{ mode: 'bridge' | 'command'; message: string }> {
    const listing = await this.list(server);
    const player = this.findPlayer(listing.players, reference);
    const bridge = this.bridgeStatus(server);
    if (bridge.connected) {
      await this.bridge.request(server.id, 'players.action', {
        action,
        player: { uuid: player.uuid, name: player.name },
        ...input,
      });
      return { mode: 'bridge', message: `${titleForAction(action)} was applied through the NodePilot Paper bridge.` };
    }
    if (action === 'inventory') {
      throw new AppError(422, 'bridge_required', 'Inventory changes require the NodePilot Paper bridge and an online player.');
    }
    if (server.status !== 'running') {
      throw new AppError(409, 'server_not_running', 'Start the server before sending player-management commands.');
    }
    const command = directCommand(action, player, input);
    if (!command) throw new AppError(422, 'player_action_unavailable', 'This player action requires the NodePilot Paper bridge.');
    this.runtime.sendCommand(server.id, command);
    return { mode: 'command', message: `${titleForAction(action)} was queued in the server console.` };
  }

  private findPlayer(players: PlayerRecord[], reference: string): PlayerRecord {
    const normalizedUuid = canonicalUuid(reference);
    const normalizedName = reference.toLowerCase();
    const player = players.find((candidate) => (normalizedUuid && candidate.uuid === normalizedUuid) || candidate.name.toLowerCase() === normalizedName);
    if (!player) throw new AppError(404, 'player_not_found', 'That player was not found in this server\'s known player data. Refresh the Players tab and try again.');
    return player;
  }

  private async playerDataUuids(root: string): Promise<string[]> {
    const directories = await this.playerDataDirectories(root);
    const found = new Set<string>();
    for (const directory of directories) {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink() || !/\.dat$/i.test(entry.name)) continue;
          const uuid = canonicalUuid(entry.name.slice(0, -4));
          if (uuid) found.add(uuid);
        }
      } catch { /* inaccessible data folder is simply unavailable */ }
    }
    return [...found];
  }

  private async playerDataDirectories(root: string): Promise<string[]> {
    const candidates = ['playerdata'];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.slice(0, 128)) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(`${entry.name}/playerdata`);
      }
    } catch { return []; }
    const valid: string[] = [];
    for (const candidate of candidates) {
      try {
        const resolved = await resolveInside(root, candidate);
        const details = await lstat(resolved);
        if (details.isDirectory() && !details.isSymbolicLink()) valid.push(resolved);
      } catch { /* not every world has player data */ }
    }
    return valid;
  }

  private async readOfflinePlayer(root: string, uuid: string): Promise<OfflinePlayerData | undefined> {
    const names = [uuid, uuid.replace(/-/g, '')].map((name) => `${name}.dat`);
    for (const directory of await this.playerDataDirectories(root)) {
      for (const name of names) {
        const filePath = path.join(directory, name);
        try {
          const details = await lstat(filePath);
          if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_PLAYER_DATA_BYTES) continue;
          const parsed = await nbt.parse(await readFile(filePath));
          return parseOfflineData(nbt.simplify(parsed.parsed));
        } catch {
          // A corrupt player data file must not block the rest of the Players page.
        }
      }
    }
    return undefined;
  }

  private observeRuntime(event: ServerEvent): void {
    if (event.type !== 'log') return;
    const message = event.line.message;
    const joined = message.match(/:\s*([A-Za-z0-9_]{3,16}) joined the game\.?$/i)?.[1];
    const left = message.match(/:\s*([A-Za-z0-9_]{3,16}) left the game\.?$/i)?.[1];
    if (joined) {
      const names = this.onlineNames.get(event.serverId) ?? new Set<string>();
      names.add(joined);
      this.onlineNames.set(event.serverId, names);
      return;
    }
    if (left) {
      this.onlineNames.get(event.serverId)?.delete(left);
      return;
    }
    const listMatch = message.match(/There are\s+\d+\s+of a max of\s+\d+\s+players online:\s*(.*)$/i);
    if (listMatch) {
      const names = new Set(listMatch[1].split(',').map((value) => value.trim()).filter((value) => PLAYER_NAME.test(value)));
      this.onlineNames.set(event.serverId, names);
    }
  }

  private requestVanillaList(serverId: string): void {
    const now = Date.now();
    if (now - (this.lastListCommand.get(serverId) ?? 0) < 5_000) return;
    this.lastListCommand.set(serverId, now);
    try { this.runtime.sendCommand(serverId, 'list'); } catch { /* lifecycle race: page will update next refresh */ }
  }
}

function titleForAction(action: PlayerAction): string {
  return action === 'deop' ? 'De-op' : action === 'unban' ? 'Unban' : action[0].toUpperCase() + action.slice(1);
}
