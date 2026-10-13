export type ServerStatus = 'running' | 'stopped' | 'installing' | 'starting' | 'stopping' | 'error' | 'unknown';

export type ServerSoftware = 'vanilla' | 'paper' | 'spigot' | 'purpur' | 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'unknown';
export type ProvisionableServerSoftware = Exclude<ServerSoftware, 'unknown'>;
/** @deprecated Kept as an alias while older NodePilot responses use “distribution”. */
export type Distribution = ProvisionableServerSoftware;

export type ServerStartupConfig =
  | { mode: 'jar'; jarPath: string; gameArguments: string[] }
  | { mode: 'arg-files'; windowsArgFile: string; linuxArgFile: string; jvmArgFiles: string[]; gameArguments: string[] };

export interface Server {
  id: string;
  machineId?: string;
  name: string;
  game: 'minecraft' | string;
  distribution?: Distribution | string;
  software?: ServerSoftware | string;
  version?: string;
  loaderVersion?: string;
  startupConfig?: ServerStartupConfig;
  status: ServerStatus;
  port?: number;
  directory?: string;
  directoryExists?: boolean;
  createdAt?: string;
  updatedAt?: string;
  pid?: number;
  memory?: { usedBytes?: number; limitBytes?: number };
  memoryMb?: number;
  requiredJavaMajor?: number;
  installState?: 'installing' | 'ready' | 'failed' | string;
  javaPath?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  players?: { online: number; max: number };
  error?: string;
}

export interface SystemMetrics {
  cpu?: { usagePercent?: number; cores?: number; model?: string };
  memory?: { usedBytes?: number; totalBytes?: number; usagePercent?: number };
  disk?: { usedBytes?: number; totalBytes?: number; usagePercent?: number; path?: string };
  platform?: string;
  hostname?: string;
  uptimeSeconds?: number;
  activeServers?: number;
}

/** A capability reports whether the host can provide a measurement, not a server value. */
export interface UsageMetricCapability {
  available?: boolean;
  reason?: string;
}

export interface ServerHeapUsage extends UsageMetricCapability {
  usedBytes?: number;
  committedBytes?: number;
  maxBytes?: number;
}

export interface ServerDiskUsage extends UsageMetricCapability {
  directoryBytes?: number;
  readBytesPerSecond?: number;
  writeBytesPerSecond?: number;
}

export interface ServerNetworkUsage extends UsageMetricCapability {
  receivedBytesPerSecond?: number;
  sentBytesPerSecond?: number;
}

/** One real process measurement captured by the local NodePilot host. */
export interface ServerUsageSample {
  timestamp?: string;
  /** CPU time used by this process as a percentage of total logical-machine capacity. */
  cpuPercent?: number;
  /** Resident memory used by the server process, in bytes. */
  memoryBytes?: number;
  heap?: ServerHeapUsage;
  disk?: ServerDiskUsage;
  network?: ServerNetworkUsage;
  uptimeMs?: number;
}

export interface ServerUsageCapabilities {
  cpu?: UsageMetricCapability;
  memory?: UsageMetricCapability;
  heap?: UsageMetricCapability;
  disk?: UsageMetricCapability;
  network?: UsageMetricCapability;
}

export interface ServerUsage {
  serverId: string;
  status: ServerStatus;
  current?: ServerUsageSample;
  history: ServerUsageSample[];
  capabilities?: ServerUsageCapabilities;
}

export interface DashboardData {
  servers?: Server[];
  system?: SystemMetrics;
}

export interface MinecraftVersion {
  id: string;
  label?: string;
  releaseDate?: string;
  stable?: boolean;
  javaMajor?: number;
}

export interface JavaInstallation {
  path: string;
  version: string;
  major?: number;
  vendor?: string;
  compatible?: boolean;
}

export interface JavaDiscovery {
  installations: JavaInstallation[];
  recommended?: JavaInstallation;
  message?: string;
}

export interface MinecraftRequirements {
  requiredJavaMajor?: number;
  compatibleJava?: JavaInstallation[];
  message?: string;
}

export interface CreateServerInput {
  name: string;
  game: 'minecraft';
  software: ProvisionableServerSoftware;
  version: string;
  port?: number;
  eulaAccepted: boolean;
  javaPath?: string;
  memoryMb?: number;
}

export interface UpdateServerInput {
  name?: string;
  port?: number;
  memoryMb?: number;
  javaPath?: string | null;
}

export interface ImportFinding {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface ImportInspection {
  sourceType: 'directory' | 'archive';
  sourceLabel: string;
  suggestedName: string;
  detectedSoftware: ServerSoftware | string;
  suggestedSoftware?: ProvisionableServerSoftware;
  /** @deprecated Present on older local backends. */
  suggestedFlavor?: Distribution;
  minecraftVersion?: string;
  loaderVersion?: string;
  startupConfig?: ServerStartupConfig;
  port?: number;
  eulaAccepted: boolean;
  serverJar?: string;
  worlds: string[];
  playerDataFiles: number;
  plugins: string[];
  mods: string[];
  fileCount: number;
  totalBytes: number;
  canImport: boolean;
  findings: ImportFinding[];
}

export interface ImportServerInput {
  source: { type: 'directory'; path: string } | { type: 'archive'; uploadId: string };
  name: string;
  software: ProvisionableServerSoftware;
  version?: string;
  port?: number;
  memoryMb?: number;
  eulaAccepted: true;
}

export type AddonType = 'plugin' | 'mod';
export type AddonSource = 'modrinth' | 'hangar' | 'upload' | 'import';

export interface AddonMetadata {
  name?: string;
  version?: string;
  software?: string;
  apiVersion?: string;
  loader?: string;
}

export interface AddonRecord {
  type: AddonType;
  fileName: string;
  size: number;
  modifiedAt: string;
  source: AddonSource;
  projectId?: string;
  versionId?: string;
  installedAt?: string;
  metadata?: AddonMetadata;
  compatible: boolean;
  compatibilityMessage?: string;
}

export interface AddonCatalogResult {
  source: 'modrinth' | 'hangar';
  projectId: string;
  title: string;
  author?: string;
  description?: string;
  iconUrl?: string;
  versions: string[];
  compatible: boolean;
  compatibilityMessage?: string;
  url: string;
}

export interface AddonUpdate {
  type: AddonType;
  fileName: string;
  source: 'modrinth' | 'hangar';
  projectId: string;
  installedVersionId?: string;
  available: boolean;
  versionName?: string;
  message?: string;
}

export interface AddonList {
  plugins: AddonRecord[];
  mods: AddonRecord[];
  capabilities: {
    plugins: boolean;
    mods: boolean;
    pluginMessage?: string;
    modMessage?: string;
  };
}

export interface PlayerLocation {
  world?: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
}

export interface PlayerInventoryItem {
  slot: number;
  itemId: string;
  count: number;
  displayName?: string;
}

export interface ManagedPlayer {
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
}

export interface PlayerDetails extends ManagedPlayer {
  inventory?: PlayerInventoryItem[];
  inventorySource?: 'bridge' | 'offline';
  inventoryMessage?: string;
}

export type PlayerAction = 'op' | 'deop' | 'kick' | 'ban' | 'unban' | 'heal' | 'teleport' | 'gamemode' | 'inventory';

export interface PlayerBridgeStatus {
  configured: boolean;
  connected: boolean;
  connectedAt?: string;
  pluginVersion?: string;
  capabilities: string[];
  available: boolean;
  message?: string;
}

export interface PlayerList {
  players: ManagedPlayer[];
  capabilities: {
    commandActions: boolean;
    offlineData: boolean;
    inventoryView: boolean;
    inventoryModify: boolean;
    bridge: PlayerBridgeStatus;
  };
  bridgeWarning?: string;
}

export interface PlayerActionInput {
  reason?: string;
  gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator';
  teleport?: { x: number; y: number; z: number; world?: string };
  inventory?: Array<{ slot: number; itemId?: string; count?: number }>;
}

export interface PlayerBridgeCredential {
  token: string;
  createdAt: string;
  rotatedAt: string;
}

export interface PlayerBridgeSetup {
  bridge: PlayerBridgeStatus;
  credential: PlayerBridgeCredential;
  config: { nodepilotUrl: string; serverId: string; token: string };
}

export type ServerProperties = Record<string, string>;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

export interface FileContent {
  path: string;
  content: string;
  encoding?: string;
}

export interface ConsoleLine {
  timestamp?: string;
  stream?: 'stdout' | 'stderr' | 'system' | string;
  message: string;
}

export interface ApiErrorShape {
  message?: string;
  error?: string;
  details?: unknown;
}

export interface NetworkInfo {
  host: string;
  port: number;
  isNetworkVisible: boolean;
  addresses: string[];
  accessUrls: { local: string; network: string[] };
  hasPin: boolean;
}

export interface UpdateNetworkInput {
  host: '127.0.0.1' | '0.0.0.0';
  pin?: string | null;
}

export interface AuthStatus {
  hasPin: boolean;
  authenticated: boolean;
}
