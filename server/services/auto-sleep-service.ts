import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import type { ServerRuntime } from './server-runtime.js';
import type { PlayerService } from './player-service.js';

export interface AutoSleepStatus {
  enabled: boolean;
  idleTimeoutMinutes: number;
  isIdle: boolean;
  countdownSeconds: number | null;
  onlinePlayersCount: number;
}

export class AutoSleepService {
  private readonly idleSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverRepo: ServerRepository,
    private readonly settingsRepo: ServerSettingsRepository,
    private readonly runtime: ServerRuntime,
    private readonly playerService: PlayerService,
  ) {}

  start(intervalMs = 3_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.idleSince.clear();
  }

  getStatus(serverId: string): AutoSleepStatus {
    const settings = this.settingsRepo.find(serverId);
    const enabled = settings?.autoSleep ?? false;
    const idleTimeoutMinutes = settings?.idleTimeoutMinutes ?? 15;
    const server = this.serverRepo.find(serverId);

    if (!server || server.status !== 'running') {
      return {
        enabled,
        idleTimeoutMinutes,
        isIdle: false,
        countdownSeconds: null,
        onlinePlayersCount: 0,
      };
    }

    const onlinePlayersCount = this.playerService.getOnlinePlayerCount(serverId);
    if (onlinePlayersCount > 0) {
      return {
        enabled,
        idleTimeoutMinutes,
        isIdle: false,
        countdownSeconds: null,
        onlinePlayersCount,
      };
    }

    const since = this.idleSince.get(serverId);
    if (!since || !enabled) {
      return {
        enabled,
        idleTimeoutMinutes,
        isIdle: true,
        countdownSeconds: null,
        onlinePlayersCount: 0,
      };
    }

    const timeoutMs = idleTimeoutMinutes * 60 * 1000;
    const remainingMs = Math.max(0, since + timeoutMs - Date.now());
    const countdownSeconds = Math.ceil(remainingMs / 1000);

    return {
      enabled,
      idleTimeoutMinutes,
      isIdle: true,
      countdownSeconds,
      onlinePlayersCount: 0,
    };
  }

  async tick(): Promise<void> {
    const servers = this.serverRepo.list();

    for (const server of servers) {
      if (server.status !== 'running') {
        this.idleSince.delete(server.id);
        continue;
      }

      const settings = this.settingsRepo.find(server.id);
      if (!settings || !settings.autoSleep) {
        this.idleSince.delete(server.id);
        continue;
      }

      const onlineCount = this.playerService.getOnlinePlayerCount(server.id);
      if (onlineCount > 0) {
        // Player is online; reset and cancel any active countdown
        this.idleSince.delete(server.id);
        continue;
      }

      // 0 players online: server is idle
      let since = this.idleSince.get(server.id);
      if (!since) {
        since = Date.now();
        this.idleSince.set(server.id, since);
      }

      const timeoutMs = settings.idleTimeoutMinutes * 60 * 1000;
      if (Date.now() - since >= timeoutMs) {
        // Time to shut down gracefully!
        this.idleSince.delete(server.id);
        console.log(
          `[Auto-Sleep] Server "${server.name}" (${server.id}) has been idle for ${settings.idleTimeoutMinutes} minutes. Initiating graceful shutdown...`,
        );
        try {
          await this.runtime.stop(server);
        } catch (error) {
          console.error(`[Auto-Sleep] Failed to gracefully stop server ${server.id}:`, error);
        }
      }
    }
  }
}
