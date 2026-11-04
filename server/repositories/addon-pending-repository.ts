import type { SqliteDatabase } from '../db.js';
import type { AddonSource, AddonType } from '../services/addon-service.js';

export interface PendingAddonChange {
  id: string;
  serverId: string;
  type: AddonType;
  fileName: string;
  originalFileName?: string;
  action: 'install' | 'update' | 'remove';
  name?: string;
  version?: string;
  source: AddonSource;
  projectId?: string;
  createdAt: string;
  error?: string | null;
}

export interface PendingAddonRecord extends PendingAddonChange {
  software: string;
  minecraftVersion: string;
  artifactHash?: string;
  versionId?: string;
  baseline: Record<string, string | null>;
}

export interface AddonJournalTarget {
  type: AddonType;
  fileName: string;
  beforeHash: string | null;
  afterHash: string | null;
  backupIndex: number;
}

export interface AddonChangeJournal {
  id: string;
  serverId: string;
  state: 'applying' | 'recovery_required';
  targets: AddonJournalTarget[];
  beforeRows: Array<{file_name:string;addon_type:AddonType;source:AddonSource;project_id:string|null;version_id:string|null;installed_at:string;updated_at:string}>;
  createdAt: string;
  error?: string | null;
}

/** Filesystem paths never enter public queue payloads; artifacts use their opaque IDs. */
export class AddonPendingRepository {
  constructor(private readonly database: SqliteDatabase) {}
  list(serverId: string): PendingAddonRecord[] {
    return (this.database.prepare('SELECT payload FROM addon_pending_changes WHERE server_id=? ORDER BY created_at,id').all(serverId) as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
  }
  save(change: PendingAddonRecord): void {
    this.database.prepare(`INSERT INTO addon_pending_changes (id,server_id,addon_type,file_name,payload,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(change.id,change.serverId,change.type,change.fileName,JSON.stringify(change),change.createdAt);
  }
  remove(serverId: string, id: string): void {
    this.database.prepare('DELETE FROM addon_pending_changes WHERE server_id=? AND id=?').run(serverId,id);
  }
  journals(): AddonChangeJournal[] {
    return (this.database.prepare('SELECT payload FROM addon_change_journals').all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
  }
  journal(serverId: string): AddonChangeJournal | null {
    const row=this.database.prepare('SELECT payload FROM addon_change_journals WHERE server_id=?').get(serverId) as {payload:string}|undefined;
    return row?JSON.parse(row.payload):null;
  }
  saveJournal(journal: AddonChangeJournal): void {
    this.database.prepare(`INSERT INTO addon_change_journals (id,server_id,payload,created_at) VALUES (?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET id=excluded.id,payload=excluded.payload,created_at=excluded.created_at`).run(journal.id,journal.serverId,JSON.stringify(journal),journal.createdAt);
  }
  removeJournal(serverId: string): void {
    this.database.prepare('DELETE FROM addon_change_journals WHERE server_id=?').run(serverId);
  }
}
