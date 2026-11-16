import type { SqliteDatabase } from '../db.js';
import type { BundleOperation, BundlePlan } from '../template-bundle-types.js';

export class TemplateBundleRepository {
  constructor(readonly database: SqliteDatabase) {}
  savePlan(plan: BundlePlan): void {
    this.database.prepare('DELETE FROM template_bundle_plans WHERE server_id IS NULL AND expires_at < ?').run(new Date().toISOString());
    this.database.prepare('INSERT INTO template_bundle_plans(id,payload,expires_at,server_id) VALUES(?,?,?,?)')
      .run(plan.id, JSON.stringify(plan), plan.expiresAt, plan.serverId);
  }
  plan(id: string): BundlePlan | null {
    const row = this.database.prepare('SELECT payload,server_id FROM template_bundle_plans WHERE id=?').get(id) as { payload: string; server_id: string | null } | undefined;
    return row ? { ...JSON.parse(row.payload), serverId: row.server_id } : null;
  }
  claim(planId: string, serverId: string): boolean {
    return this.database.prepare('UPDATE template_bundle_plans SET server_id=? WHERE id=? AND server_id IS NULL').run(serverId, planId).changes === 1;
  }
  save(operation: BundleOperation): void {
    operation.updatedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO template_installations(server_id,id,payload,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(operation.serverId, operation.id, JSON.stringify(operation), operation.updatedAt);
  }
  find(serverId: string): BundleOperation | null {
    const row = this.database.prepare('SELECT payload FROM template_installations WHERE server_id=?').get(serverId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  list(): BundleOperation[] {
    return (this.database.prepare('SELECT payload FROM template_installations').all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload));
  }
}
