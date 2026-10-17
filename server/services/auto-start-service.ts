import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerRuntime } from './server-runtime.js';
import type { PlayitService } from './playit-service.js';
import type { JavaService } from './java-service.js';

export interface AutoStartDiagnosticEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export class AutoStartService {
  private hasRun = false;
  private readonly diagnostics: AutoStartDiagnosticEntry[] = [];

  constructor(
    private readonly serverRepo: ServerRepository,
    private readonly runtime: ServerRuntime,
    private readonly playitService: PlayitService,
    private readonly javaService?: JavaService,
  ) {}

  log(level: 'info' | 'warn' | 'error', message: string): void {
    const entry: AutoStartDiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 200) {
      this.diagnostics.shift();
    }
    if (level === 'error') {
      console.error(`[NodePilot Host] ${message}`);
    } else if (level === 'warn') {
      console.warn(`[NodePilot Host] ${message}`);
    } else {
      console.log(`[NodePilot Host] ${message}`);
    }
  }

  getDiagnostics(): AutoStartDiagnosticEntry[] {
    return [...this.diagnostics];
  }

  /**
   * Execute auto-start sequence on system boot/startup.
   * Ensures that marked servers start exactly once per process boot.
   */
  async runBootSequence(): Promise<void> {
    if (this.hasRun) {
      this.log('info', 'Boot sequence already completed; skipping duplicate run.');
      return;
    }
    this.hasRun = true;
    this.log('info', 'Initiating NodePilot startup sequence...');

    // 1. Playit coordination
    try {
      const playitStatus = await this.playitService.getStatus();
      if (playitStatus.installed && playitStatus.secretExists) {
        if (!playitStatus.isRunning) {
          this.log('info', 'Starting Playit.gg network tunnel agent...');
          await this.playitService.startAgent();
          this.log('info', 'Playit.gg agent successfully launched.');
        } else {
          this.log('info', 'Playit.gg agent is already running.');
        }
      } else if (playitStatus.installed && !playitStatus.secretExists) {
        this.log('warn', 'Playit CLI found but no credentials claimed. Skipping auto-launch.');
      }
    } catch (err) {
      this.log('warn', `Playit.gg auto-coordination skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Discover auto-start servers
    const servers = this.serverRepo.list();
    const autoStartServers = servers.filter((server) => server.autoStart === 'always');

    if (autoStartServers.length === 0) {
      this.log('info', 'No Minecraft servers configured for auto-start.');
      return;
    }

    this.log('info', `Found ${autoStartServers.length} server(s) configured for auto-start.`);

    for (const server of autoStartServers) {
      if (server.installState !== 'ready') {
        this.log('warn', `Server "${server.name}" (${server.id}) is not in ready state (${server.installState}); skipping auto-start.`);
        continue;
      }

      if (server.status === 'running' || server.status === 'starting') {
        this.log('info', `Server "${server.name}" (${server.id}) is already ${server.status}.`);
        continue;
      }

      try {
        let javaPath = server.javaPath;
        let warning: string | undefined;

        if (server.software !== 'bedrock' && server.startupConfig.mode !== 'executable') {
          if (this.javaService) {
            const usableJava = await this.javaService.findUsable(server.requiredJavaMajor, server.javaPath);
            if (!usableJava) {
              this.log('error', `Cannot auto-start "${server.name}": Required Java runtime (${server.requiredJavaMajor ?? 'any'}) not found.`);
              continue;
            }
            javaPath = usableJava.installation.path;
            warning = usableJava.warning;
          }

          if (!javaPath) {
            this.log('error', `Cannot auto-start "${server.name}": No Java path configured or detected.`);
            continue;
          }
        }

        this.log('info', `Starting auto-start server "${server.name}" (${server.id})...`);
        await this.runtime.start(server, javaPath ?? undefined, warning);
        this.log('info', `Successfully started "${server.name}" on port ${server.port}.`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log('error', `Failed to auto-start server "${server.name}": ${errorMsg}`);
      }
    }
  }
}
