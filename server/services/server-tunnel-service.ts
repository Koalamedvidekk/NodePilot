import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import type { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import type { PlayitService } from './playit-service.js';
import type { PlayitStatus, ServerTunnel, TunnelStatus } from '../types.js';

export class ServerTunnelService {
  constructor(
    private readonly repository: ServerTunnelRepository,
    private readonly serverRepo: ServerRepository,
    private readonly playit: PlayitService,
    private readonly settingsRepo?: ServerSettingsRepository,
  ) {}

  /**
   * Get tunnel and Playit agent status for a given server.
   */
  async getStatus(serverId: string): Promise<{ tunnel: ServerTunnel | null; playit: PlayitStatus }> {
    const tunnel = this.repository.find(serverId);
    let playit = await this.playit.getStatus();

    if (!tunnel) {
      return { tunnel: null, playit };
    }

    // Auto-revive agent if tunnel is configured, credentials exist, but process is currently stopped
    if (!playit.isRunning && tunnel.tunnelId && playit.installed && playit.secretExists) {
      try {
        playit = await this.playit.startAgent();
      } catch {
        // ignore background attempt, will report actual state below
      }
    }

    // Live status check: if agent is stopped, tunnel cannot be connected
    let effectiveStatus: TunnelStatus = tunnel.status;
    if (!playit.installed || !playit.secretExists) {
      effectiveStatus = 'error';
    } else if (!playit.isRunning && tunnel.tunnelId) {
      effectiveStatus = 'disconnected';
    } else if (playit.isRunning && tunnel.tunnelId) {
      effectiveStatus = 'connected';
    }

    if (effectiveStatus !== tunnel.status) {
      const updated = this.repository.update(serverId, { status: effectiveStatus });
      return { tunnel: updated ?? tunnel, playit };
    }

    return { tunnel, playit };
  }

  /**
   * Reconcile/verify tunnel for a server against Playit account.
   */
  async reconcile(serverId: string, localPort: number): Promise<{ tunnel: ServerTunnel; playit: PlayitStatus }> {
    const playit = await this.playit.getStatus();
    const existing = this.repository.find(serverId);

    // If agent is installed and authenticated but stopped, launch it
    let running = playit.isRunning;
    if (playit.installed && playit.secretExists && !running) {
      try {
        const launched = await this.playit.startAgent();
        running = launched.isRunning;
      } catch {
        // Continue and report state
      }
    }

    let status: TunnelStatus = 'connecting';
    let lastError: string | null = null;
    let matchingTunnel: Awaited<ReturnType<typeof this.playit.findTunnelForPort>> = null;

    if (!playit.installed) {
      status = 'error';
      lastError = 'Playit CLI is not installed on this host.';
    } else if (!playit.secretExists) {
      status = 'connecting';
      lastError = 'Playit account is not yet linked. Link account in Host Settings or Playit setup.';
    } else {
      // Query Playit API for matching tunnel on this local port
      try {
        matchingTunnel = await this.playit.findTunnelForPort(localPort);
        if (!matchingTunnel) {
          const settings = this.settingsRepo?.find(serverId);
          const server = this.serverRepo.find(serverId);
          if (settings?.autoWake && server && localPort === server.port) {
            const defaultWakePort = server.port >= 55535 ? server.port - 10000 : server.port + 10000;
            const wakePort = settings.wakeProxyPort ?? defaultWakePort;
            const altTunnel = await this.playit.findTunnelForPort(wakePort);
            if (altTunnel) {
              matchingTunnel = altTunnel;
              if (altTunnel.localPort) {
                localPort = altTunnel.localPort;
              }
            }
          }
        }
        if (matchingTunnel) {
          status = running ? 'connected' : 'disconnected';
          lastError = null;
        } else {
          status = 'connecting';
          lastError = `No Playit tunnel configured for local port ${localPort} yet. Create a tunnel targeting port ${localPort} in your Playit.gg dashboard.`;
        }
      } catch (err) {
        status = 'error';
        lastError = `Failed to query Playit API: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const saved = this.repository.save({
      serverId,
      tunnelId: matchingTunnel?.id ?? existing?.tunnelId ?? null,
      tunnelName: matchingTunnel?.name ?? existing?.tunnelName ?? null,
      publicAddress: matchingTunnel?.publicAddress ?? existing?.publicAddress ?? null,
      publicPort: matchingTunnel?.publicPort ?? existing?.publicPort ?? null,
      connectionAddress: matchingTunnel?.connectionAddress ?? existing?.connectionAddress ?? null,
      localPort,
      status,
      lastVerifiedAt: new Date().toISOString(),
      lastError,
    });

    return { tunnel: saved, playit: await this.playit.getStatus() };
  }

  /**
   * Enable tunnel tracking for an existing server.
   */
  async enable(serverId: string): Promise<{ tunnel: ServerTunnel; playit: PlayitStatus }> {
    const server = this.serverRepo.find(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found.`);
    }

    return this.reconcile(serverId, server.port);
  }

  /**
   * Re-verify tunnel against Playit cloud.
   */
  async verify(serverId: string): Promise<{ tunnel: ServerTunnel; playit: PlayitStatus }> {
    const server = this.serverRepo.find(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found.`);
    }

    const tunnel = this.repository.find(serverId);
    const localPort = tunnel?.localPort ?? server.port;

    return this.reconcile(serverId, localPort);
  }

  /**
   * Handle server port changes.
   */
  async handlePortChanged(serverId: string, newPort: number): Promise<ServerTunnel | null> {
    const existing = this.repository.find(serverId);
    if (!existing) return null;

    if (existing.localPort === newPort) return existing;

    const res = await this.reconcile(serverId, newPort);
    return res.tunnel;
  }

  /**
   * Remove tunnel mapping for a server (keeps Minecraft server untouched).
   */
  async remove(serverId: string): Promise<boolean> {
    return this.repository.delete(serverId);
  }
}
