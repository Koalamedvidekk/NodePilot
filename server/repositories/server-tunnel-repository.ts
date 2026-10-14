import type { SqliteDatabase } from '../db.js';
import type { ServerTunnel, TunnelStatus } from '../types.js';

interface ServerTunnelRow {
  server_id: string;
  tunnel_id: string | null;
  tunnel_name: string | null;
  public_address: string | null;
  public_port: number | null;
  connection_address: string | null;
  local_port: number;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ServerTunnelRow): ServerTunnel {
  return {
    serverId: row.server_id,
    tunnelId: row.tunnel_id,
    tunnelName: row.tunnel_name,
    publicAddress: row.public_address,
    publicPort: row.public_port,
    connectionAddress: row.connection_address,
    localPort: row.local_port,
    status: row.status as TunnelStatus,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SaveServerTunnelInput {
  serverId: string;
  tunnelId?: string | null;
  tunnelName?: string | null;
  publicAddress?: string | null;
  publicPort?: number | null;
  connectionAddress?: string | null;
  localPort: number;
  status: TunnelStatus;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export class ServerTunnelRepository {
  constructor(private readonly database: SqliteDatabase) {}

  find(serverId: string): ServerTunnel | null {
    const row = this.database
      .prepare('SELECT * FROM server_tunnels WHERE server_id = ?')
      .get(serverId) as ServerTunnelRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByLocalPort(localPort: number): ServerTunnel | null {
    const row = this.database
      .prepare('SELECT * FROM server_tunnels WHERE local_port = ?')
      .get(localPort) as ServerTunnelRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(): ServerTunnel[] {
    const rows = this.database
      .prepare('SELECT * FROM server_tunnels ORDER BY created_at DESC')
      .all() as ServerTunnelRow[];
    return rows.map(mapRow);
  }

  save(tunnel: SaveServerTunnelInput): ServerTunnel {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO server_tunnels (
          server_id, tunnel_id, tunnel_name, public_address, public_port,
          connection_address, local_port, status, last_verified_at, last_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          tunnel_id = excluded.tunnel_id,
          tunnel_name = excluded.tunnel_name,
          public_address = excluded.public_address,
          public_port = excluded.public_port,
          connection_address = excluded.connection_address,
          local_port = excluded.local_port,
          status = excluded.status,
          last_verified_at = excluded.last_verified_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(
        tunnel.serverId,
        tunnel.tunnelId,
        tunnel.tunnelName,
        tunnel.publicAddress,
        tunnel.publicPort,
        tunnel.connectionAddress,
        tunnel.localPort,
        tunnel.status,
        tunnel.lastVerifiedAt,
        tunnel.lastError,
        now,
        now,
      );

    const saved = this.find(tunnel.serverId);
    if (!saved) throw new Error(`Failed to persist tunnel for server ${tunnel.serverId}`);
    return saved;
  }

  update(serverId: string, patch: Partial<ServerTunnel>): ServerTunnel | null {
    const existing = this.find(serverId);
    if (!existing) return null;

    const merged = { ...existing, ...patch, serverId };
    return this.save(merged);
  }

  delete(serverId: string): boolean {
    const result = this.database
      .prepare('DELETE FROM server_tunnels WHERE server_id = ?')
      .run(serverId);
    return result.changes > 0;
  }
}
