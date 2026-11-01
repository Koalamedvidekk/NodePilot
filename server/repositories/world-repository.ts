import type { SqliteDatabase } from '../db.js';
import type { WorldBackup, WorldGenerationOptions, WorldGroup, WorldOperation, WorldState } from '../world-types.js';

export interface WorldRecord {
  id: string; serverId: string; name: string; folder: string; group: WorldGroup;
  generation: WorldGenerationOptions; state: WorldState; deleted: boolean;
  createdAt: string; updatedAt: string;
}
export interface WorldBackupRecord extends WorldBackup { serverId: string; directory: string; group: WorldGroup; generation: WorldGenerationOptions }
export interface WorldOperationRecord extends WorldOperation { recovery: string | null; artifact: string | null }

export class WorldRepository {
  constructor(private readonly database: SqliteDatabase) {}
  list(serverId: string): WorldRecord[] {
    return (this.database.prepare('SELECT payload FROM worlds WHERE server_id = ? ORDER BY created_at, id').all(serverId) as Array<{payload:string}>).map(row => JSON.parse(row.payload));
  }
  find(id: string, serverId: string): WorldRecord | null {
    const row = this.database.prepare('SELECT payload FROM worlds WHERE id = ? AND server_id = ?').get(id, serverId) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  save(world: WorldRecord): WorldRecord {
    world.updatedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO worlds (id,server_id,folder,payload,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET folder=excluded.folder,payload=excluded.payload`).run(world.id,world.serverId,world.folder,JSON.stringify(world),world.createdAt);
    return world;
  }
  remove(id: string, serverId: string): void { this.database.prepare('DELETE FROM worlds WHERE id = ? AND server_id = ?').run(id,serverId); }
  backups(worldId: string, serverId: string): WorldBackupRecord[] {
    return (this.database.prepare('SELECT payload FROM world_backups WHERE world_id = ? AND server_id = ? ORDER BY created_at DESC').all(worldId,serverId) as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
  }
  findBackup(id: string, serverId: string): WorldBackupRecord | null {
    const row = this.database.prepare('SELECT payload FROM world_backups WHERE id = ? AND server_id = ?').get(id,serverId) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  saveBackup(backup: WorldBackupRecord): void {
    this.database.prepare('INSERT INTO world_backups (id,world_id,server_id,payload,created_at) VALUES (?,?,?,?,?)').run(backup.id,backup.worldId,backup.serverId,JSON.stringify(backup),backup.createdAt);
  }
  saveOperation(operation: WorldOperationRecord): void {
    operation.updatedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO world_operations (id,server_id,state,payload,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload`).run(operation.id,operation.serverId,operation.state,JSON.stringify(operation),operation.createdAt);
  }
  operation(id: string, serverId: string): WorldOperationRecord | null {
    const row = this.database.prepare('SELECT payload FROM world_operations WHERE id = ? AND server_id = ?').get(id,serverId) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  unfinished(): WorldOperationRecord[] {
    return (this.database.prepare("SELECT payload FROM world_operations WHERE state IN ('running','failed')").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload)).filter(op=>op.state==='running'||op.phase==='recovery_required');
  }
  unresolved(serverId: string): WorldOperationRecord[] {
    return (this.database.prepare("SELECT payload FROM world_operations WHERE server_id=? AND state='failed'").all(serverId) as Array<{payload:string}>).map(row=>JSON.parse(row.payload)).filter(op=>op.phase==='recovery_required');
  }
  resolveRecovery(serverId: string, worldId: string): void {
    for (const operation of this.unresolved(serverId)) if (operation.worldId === worldId) {
      operation.phase='recovered'; operation.recovery=null; this.saveOperation(operation);
    }
  }
}
