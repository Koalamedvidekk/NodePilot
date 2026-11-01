export type WorldLayout = 'legacy-java' | 'legacy-paper' | 'modern-java' | 'modern-paper' | 'unknown';
export type WorldState = 'prepared' | 'generated' | 'missing' | 'unavailable';
export type WorldDifficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export interface WorldGenerationOptions {
  seed: string;
  preset: string;
  generatorSettings: string;
  structures: boolean;
  hardcore: boolean;
  difficulty: WorldDifficulty;
  enabledPacks: string[];
  disabledPacks: string[];
}

export interface WorldGroup {
  folder: string;
  members: string[];
  layout: WorldLayout;
  metadataFile: string | null;
  rulesFile: string | null;
  generationFile: string | null;
  playerDirectories: string[];
  dimensions: string[];
  readOnlyReason: string | null;
}

export interface WorldGameRule {
  id: string;
  label: string;
  type: 'boolean' | 'integer' | 'unknown';
  value: boolean | number | string;
  editable: boolean;
  minimum?: number;
  maximum?: number;
}

export interface WorldMetadata {
  generated: boolean;
  seed: string | null;
  minecraftVersion: string | null;
  dataVersion: number | null;
  difficulty: WorldDifficulty | null;
  hardcore: boolean | null;
  preset: string | null;
  structures: boolean | null;
  lastSavedAt: string | null;
  features: string[];
  enabledPacks: string[];
  disabledPacks: string[];
  gameRules: WorldGameRule[];
  warnings: string[];
  readOnlyReason: string | null;
}

export interface WorldSummary {
  id: string;
  deleted: boolean;
  name: string;
  folder: string;
  active: boolean;
  state: WorldState;
  layout: WorldLayout;
  seed: string | null;
  minecraftVersion: string | null;
  dataVersion: number | null;
  difficulty: WorldDifficulty | null;
  hardcore: boolean | null;
  dimensions: string[];
  sizeBytes: number | null;
  lastSavedAt: string | null;
  revision: string;
  readOnlyReason: string | null;
}

export interface WorldDatapack {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  compatible: boolean | null;
  managed: boolean;
  generationPack: boolean;
  reason: string | null;
  removable: boolean;
}

export interface WorldBackup {
  id: string;
  worldId: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
}

export interface WorldCapabilities {
  canMutate: boolean;
  reason: string | null;
  presets: Array<{ id: string; name: string }>;
}

export interface WorldList {
  supported: boolean;
  unsupportedReason: string | null;
  activeWorldId: string | null;
  worlds: WorldSummary[];
  capabilities: WorldCapabilities;
  operation: WorldOperation | null;
  warnings: string[];
  revision: string;
}

export interface WorldDetails {
  world: WorldSummary;
  generation: WorldGenerationOptions;
  gameRules: WorldGameRule[];
  features: string[];
  datapacks: WorldDatapack[];
  backups: WorldBackup[];
  capabilities: WorldCapabilities;
  warnings: string[];
  metadataSource: 'saved' | 'last-saved' | 'not-generated';
}

export interface WorldImportCandidate {
  id: string;
  name: string;
  layout: WorldLayout;
  minecraftVersion: string | null;
  seed: string | null;
  dimensions: string[];
  warnings: string[];
}

export interface WorldImportInspection {
  id: string;
  candidates: WorldImportCandidate[];
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface WorldOperation {
  id: string;
  serverId: string;
  worldId: string | null;
  kind: string;
  state: 'running' | 'succeeded' | 'failed';
  phase: string;
  processedBytes: number;
  totalBytes: number | null;
  error: string | null;
  result: { worldId?: string; backupId?: string; downloadUrl?: string; inspection?: WorldImportInspection } | null;
  createdAt: string;
  updatedAt: string;
}
