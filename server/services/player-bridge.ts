import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { SqliteDatabase } from '../db.js';
import { AppError } from '../lib/errors.js';

const MAX_BRIDGE_MESSAGE_BYTES = 512 * 1024;
const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

type BridgeSocket = {
  OPEN: number;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
};

type BridgeCredentialRow = {
  token_hash: string;
  created_at: string;
  rotated_at: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type BridgeConnection = {
  socket: BridgeSocket;
  connectedAt: string;
  pluginVersion?: string;
  capabilities: string[];
  pending: Map<string, PendingRequest>;
};

export type BridgeStatus = {
  configured: boolean;
  connected: boolean;
  connectedAt?: string;
  pluginVersion?: string;
  capabilities: string[];
};

/** Hashes are stored instead of bridge secrets. The plaintext token is emitted once on rotation. */
export function bridgeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isServerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseMessage(raw: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
  const buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
  if (buffer.byteLength > MAX_BRIDGE_MESSAGE_BYTES) return undefined;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Maintains authenticated, loopback WebSocket sessions opened by the optional Paper bridge.
 * The public panel never connects to a game process directly; it only calls this local manager.
 */
export class PlayerBridgeManager {
  private readonly connections = new Map<string, BridgeConnection>();

  constructor(private readonly database: SqliteDatabase) {}

  credentials(serverId: string): { token: string; createdAt: string; rotatedAt: string } {
    if (!isServerId(serverId)) throw new AppError(400, 'invalid_server_id', 'The bridge server identifier is invalid.');
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO bridge_credentials (server_id, token_hash, created_at, rotated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET token_hash = excluded.token_hash, rotated_at = excluded.rotated_at
    `).run(serverId, bridgeTokenHash(token), now, now);
    this.disconnect(serverId, 4001, 'Bridge credential rotated');
    return { token, createdAt: now, rotatedAt: now };
  }

  status(serverId: string): BridgeStatus {
    const credential = this.database.prepare('SELECT token_hash, created_at, rotated_at FROM bridge_credentials WHERE server_id = ?').get(serverId) as BridgeCredentialRow | undefined;
    const connection = this.connections.get(serverId);
    return {
      configured: Boolean(credential),
      connected: Boolean(connection),
      connectedAt: connection?.connectedAt,
      pluginVersion: connection?.pluginVersion,
      capabilities: connection?.capabilities ?? [],
    };
  }

  /** Accepts the socket before authentication; the bridge must send a `hello` object first. */
  accept(socket: BridgeSocket): void {
    let serverId: string | undefined;
    let authenticated = false;
    const helloTimeout = setTimeout(() => {
      if (!authenticated) socket.close(4003, 'Bridge hello timed out');
    }, BRIDGE_REQUEST_TIMEOUT_MS);
    helloTimeout.unref();

    const close = () => {
      clearTimeout(helloTimeout);
      if (serverId) this.removeConnection(serverId, socket);
    };
    socket.on('close', close);
    socket.on('error', close);
    socket.on('message', (raw) => {
      const message = parseMessage(raw);
      if (!message) {
        socket.close(4002, 'Invalid bridge message');
        return;
      }
      if (!authenticated) {
        if (message.type !== 'hello' || !isServerId(message.serverId) || typeof message.token !== 'string') {
          socket.close(4003, 'Bridge authentication required');
          return;
        }
        const credential = this.database.prepare('SELECT token_hash FROM bridge_credentials WHERE server_id = ?').get(message.serverId) as Pick<BridgeCredentialRow, 'token_hash'> | undefined;
        if (!credential || !sameHash(credential.token_hash, bridgeTokenHash(message.token))) {
          socket.close(4003, 'Invalid bridge credential');
          return;
        }
        serverId = message.serverId;
        authenticated = true;
        clearTimeout(helloTimeout);
        const old = this.connections.get(serverId);
        if (old && old.socket !== socket) this.disconnect(serverId, 4000, 'Replaced by a newer bridge connection');
        const capabilities = Array.isArray(message.capabilities)
          ? message.capabilities.filter((value): value is string => typeof value === 'string' && value.length <= 80).slice(0, 64)
          : [];
        this.connections.set(serverId, {
          socket,
          connectedAt: new Date().toISOString(),
          pluginVersion: typeof message.pluginVersion === 'string' ? message.pluginVersion.slice(0, 80) : undefined,
          capabilities,
          pending: new Map(),
        });
        this.send(socket, { type: 'hello-ack', protocol: 1 });
        return;
      }
      this.handleResponse(serverId as string, message);
    });
  }

  async request(serverId: string, method: string, body: unknown): Promise<unknown> {
    const connection = this.connections.get(serverId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
      throw new AppError(409, 'bridge_unavailable', 'The NodePilot Paper bridge is not connected to this server.');
    }
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(method)) throw new AppError(500, 'invalid_bridge_method', 'NodePilot generated an invalid bridge request.');
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new AppError(504, 'bridge_timeout', 'The NodePilot Paper bridge did not respond in time.'));
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      timer.unref();
      connection.pending.set(id, { resolve, reject, timer });
      try {
        this.send(connection.socket, { type: 'request', id, method, body });
      } catch (error) {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(error instanceof AppError ? error : new AppError(503, 'bridge_send_failed', 'NodePilot could not reach the Paper bridge.'));
      }
    });
  }

  disconnect(serverId: string, code = 1000, reason = 'NodePilot closed bridge connection'): void {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError(503, 'bridge_disconnected', 'The NodePilot Paper bridge disconnected before the action completed.'));
    }
    connection.pending.clear();
    try { connection.socket.close(code, reason); } catch { /* socket is already closed */ }
  }

  shutdown(): void {
    for (const serverId of [...this.connections.keys()]) this.disconnect(serverId, 1001, 'NodePilot is shutting down');
  }

  private removeConnection(serverId: string, socket: BridgeSocket): void {
    const connection = this.connections.get(serverId);
    if (!connection || connection.socket !== socket) return;
    this.connections.delete(serverId);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError(503, 'bridge_disconnected', 'The NodePilot Paper bridge disconnected before the action completed.'));
    }
    connection.pending.clear();
  }

  private handleResponse(serverId: string, message: Record<string, unknown>): void {
    if (message.type !== 'response' || typeof message.id !== 'string') return;
    const pending = this.connections.get(serverId)?.pending.get(message.id);
    if (!pending) return;
    const connection = this.connections.get(serverId);
    connection?.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok !== true) {
      const error = typeof message.error === 'string' ? message.error.slice(0, 500) : 'The Paper bridge rejected this request.';
      pending.reject(new AppError(422, 'bridge_action_failed', error));
      return;
    }
    pending.resolve(message.body);
  }

  private send(socket: BridgeSocket, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_BRIDGE_MESSAGE_BYTES) {
      throw new AppError(413, 'bridge_message_too_large', 'A bridge request exceeded NodePilot\'s safety limit.');
    }
    if (socket.readyState !== socket.OPEN) throw new AppError(503, 'bridge_disconnected', 'The NodePilot Paper bridge is disconnected.');
    socket.send(encoded);
  }
}
