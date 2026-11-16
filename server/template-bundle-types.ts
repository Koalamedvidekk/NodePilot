import type { ServerTemplateSettings } from './lib/server-templates.js';
import type { ProvisionableServerSoftware, ServerStartupConfig } from './types.js';

export interface BundleSelection { source: 'modrinth' | 'hangar'; projectId: string }
export interface BundleArtifact extends BundleSelection {
  type: 'plugin' | 'mod';
  name: string;
  versionId: string;
  versionName: string;
  fileName: string;
  downloadUrl: string;
  checksum: { algorithm: 'sha512' | 'sha256' | 'sha1'; value: string };
  size: number;
  requiredBy: string[];
  clientRequired: false;
}
export interface BundleInput {
  templateId: string;
  software: ProvisionableServerSoftware;
  version: string;
  templateSettings?: Partial<ServerTemplateSettings>;
  selections: BundleSelection[];
}
export interface BundlePlan extends BundleInput {
  id: string;
  expiresAt: string;
  artifacts: BundleArtifact[];
  config: Record<string, string>;
  serverId: string | null;
}
export interface BundlePreview {
  compatible: boolean;
  reason: string | null;
  versions: string[];
  artifacts: BundleArtifact[];
  configurationChanges: Array<{ file: string; description: string }>;
  planId: string | null;
  expiresAt: string | null;
}
export interface BundleInstallation {
  id: string;
  serverId: string;
  state: 'running' | 'failed' | 'cancelled' | 'succeeded';
  phase: string;
  error: string | null;
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
  updatedAt: string;
}
export interface BundleJournalTarget { file: string; before: string | null; beforeHash: string | null; afterHash: string }
export interface BundleOperation extends BundleInstallation {
  plan: BundlePlan;
  enablePlayit: boolean;
  runtime: { configuration: { software: ProvisionableServerSoftware; loaderVersion: string | null; startupConfig: ServerStartupConfig }; fingerprint: Record<string, string>; promoted: boolean } | null;
  journal: BundleJournalTarget[] | null;
}
