import net from 'node:net';
import type { ServerRecord } from '../types.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import type { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import type { PlayitService } from './playit-service.js';
import type { ServerRuntime } from './server-runtime.js';
import type { JavaService } from './java-service.js';
import {
  parseHandshake,
  readVarInt,
  createStatusResponsePacket,
  createPongPacket,
  createLoginDisconnectPacket,
  createPacket,
  writeString,
  probeMinecraftServer,
  type MinecraftHandshake,
  type ProbeResult,
} from '../lib/minecraft-protocol.js';
import { startupProgressFromLogs, type StartupProgress } from './startup-progress.js';

export interface WakeProxyStatus {
  status: 'active' | 'standby' | 'disabled' | 'unsupported';
  wakePort: number | null;
  minecraftPort: number;
  publicAddress: string | null;
  playitInstalled: boolean;
  playitRunning: boolean;
  tunnelConfigured: boolean;
  message?: string;
  starting?: boolean;
  startup?: StartupProgress;
  playerNotice?: string;
}

interface PendingClient {
  socket: net.Socket;
  bufferedChunks: Buffer[];
  remoteAddr: string;
  safetyTimer: NodeJS.Timeout;
  cleanup: () => void;
}

interface WakeProxyOptions { playerWaitMs?: number; startupTimeoutMs?: number; inspectionTimeoutMs?: number }
const MAX_WAITING_CLIENTS = 64;
const MAX_BUFFERED_BYTES = 128 * 1024;

export class WakeProxyService {
  private readonly listeners = new Map<string, net.Server>();
  private readonly listenerPorts = new Map<string, number>();
  private readonly listenerStarts = new Map<string, Promise<void>>();
  private readonly pendingQueues = new Map<string, PendingClient[]>();
  private readonly wakePromises = new Map<string, Promise<boolean>>();
  private readonly wakeStartedAt = new Map<string, string>();
  private readonly readyServers = new Map<string, string>();
  private readonly inspections = new Map<string, Set<net.Socket>>();
  private readonly statusClients = new Map<string, Set<net.Socket>>();
  private stopped = false;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverRepo: ServerRepository,
    private readonly settingsRepo: ServerSettingsRepository,
    private readonly tunnelRepo: ServerTunnelRepository,
    private readonly playitService: PlayitService,
    private readonly runtime: ServerRuntime,
    private readonly javaService?: JavaService,
    private readonly options: WakeProxyOptions = {},
  ) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
    this.timer.unref();
    void this.reconcileAll();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const [serverId, queue] of this.pendingQueues.entries()) {
      for (const client of [...queue]) {
        client.cleanup();
        this.sendDisconnectAndClose(
          client.socket,
          '§c[NodePilot Auto-Wake]\n\n§eNodePilot is restarting or shutting down.',
        );
      }
      this.pendingQueues.delete(serverId);
    }

    for (const [serverId, listener] of this.listeners.entries()) {
      try {
        listener.close();
      } catch {
        // ignore close error
      }
    }
    this.listeners.clear();
    this.listenerPorts.clear();
    this.listenerStarts.clear();
    this.wakePromises.clear();
    this.readyServers.clear();
    this.wakeStartedAt.clear();
    for (const sockets of [...this.inspections.values(), ...this.statusClients.values()]) for (const socket of sockets) socket.destroy();
    this.inspections.clear();
    this.statusClients.clear();
  }

  private launchKey(server: ServerRecord): string {
    return `${server.port}/${server.version}/${this.runtime.getProcessInfo?.(server.id)?.runtimeId ?? server.lastStartedAt ?? ''}`;
  }

  private isReady(server: ServerRecord): boolean {
    if (!['running', 'starting'].includes(server.status)) { this.readyServers.delete(server.id); return false; }
    return this.readyServers.get(server.id) === this.launchKey(server);
  }

  private observedProgress(server: ServerRecord): StartupProgress {
    const startedAt = this.runtime.getProcessInfo?.(server.id)?.startedAt ?? this.wakeStartedAt.get(server.id);
    return startupProgressFromLogs(this.runtime.getLogs?.(server.id, 1000) ?? [], startedAt);
  }

  private progress(server: ServerRecord): StartupProgress {
    if (this.isReady(server)) return { stage: 'Ready to join', percent: 100, isReady: true };
    const progress = this.observedProgress(server);
    return progress.isReady ? { stage: 'Checking server readiness', percent: null, isReady: false } : progress;
  }

  private async probeBackend(server: ServerRecord, timeoutMs: number): Promise<ProbeResult> {
    const probe = await probeMinecraftServer('127.0.0.1', server.port, timeoutMs);
    // enable-status=false is valid. A genuine Done line from this launch plus
    // an accepting local socket still establishes readiness without an SLP reply.
    if (!probe.ready && !this.stopped && this.observedProgress(server).isReady && await this.checkTcpPort('127.0.0.1', server.port, timeoutMs)) return { ready: true };
    return probe;
  }

  private isStarting(server: ServerRecord): boolean {
    return this.wakePromises.has(server.id) || ['starting', 'running'].includes(server.status) && !this.isReady(server);
  }

  private playerNotice(server: ServerRecord): string {
    const progress = this.progress(server);
    const stage = progress.stage + (progress.percent === null ? '' : ` — ${progress.percent}% of this stage`);
    return `§6[NodePilot Auto-Wake]\n\n§eStarting server…\n§f${stage}\n\n§7The server keeps starting in the background.\n§aBack → Refresh the server list for updated progress.\n§aJoin again when it is ready.`;
  }

  async getStatus(serverId: string): Promise<WakeProxyStatus> {
    const server = this.serverRepo.find(serverId);
    const settings = this.settingsRepo.find(serverId);
    const tunnel = this.tunnelRepo.find(serverId);
    const playit = await this.playitService.getStatus();
    // Runtime 'running' means the child spawned, not that Minecraft accepts logins.
    if (!this.stopped && server && ['running', 'starting'].includes(server.status) && !this.isReady(server)) {
      const generation = this.generation;
      const expectedLaunch = this.launchKey(server);
      const probe = await this.probeBackend(server, 800);
      if (!this.stopped && generation === this.generation) {
        const current = this.serverRepo.find(serverId);
        if (probe.ready && current && ['running', 'starting'].includes(current.status) && this.launchKey(current) === expectedLaunch) this.readyServers.set(serverId, expectedLaunch);
      }
    }

    const minecraftPort = server?.port ?? 25565;
    const defaultWakePort = minecraftPort >= 55535 ? minecraftPort - 10000 : minecraftPort + 10000;
    const wakePort = settings?.wakeProxyPort ?? defaultWakePort;
    const publicAddress = tunnel?.publicAddress ?? null;
    const enabled = settings?.autoWake ?? false;
    const starting = Boolean(server && this.isStarting(server));
    const startup = starting && server ? this.progress(server) : undefined;

    const playitInstalled = playit.installed;
    const playitRunning = playit.isRunning;
    const tunnelConfigured = Boolean(
      tunnel?.tunnelId &&
      (tunnel.status === 'connected' || tunnel.status === 'disconnected') &&
      tunnel.localPort === wakePort,
    );

    if (!enabled) {
      return {
        status: 'disabled',
        wakePort,
        minecraftPort,
        publicAddress,
        playitInstalled,
        playitRunning,
        tunnelConfigured,
        message: 'Auto-Wake is currently disabled for this server.',
      };
    }

    if (!playitInstalled || !playit.secretExists) {
      return {
        status: 'unsupported',
        wakePort,
        minecraftPort,
        publicAddress,
        playitInstalled,
        playitRunning,
        tunnelConfigured,
        message: 'Playit.gg is not installed or not linked. Set up Playit in Host Settings before enabling Auto-Wake.',
      };
    }

    if (server?.software === 'bedrock' || server?.game === 'minecraft-bedrock') {
      return { status: 'unsupported', wakePort, minecraftPort, publicAddress, playitInstalled, playitRunning, tunnelConfigured,
        message: 'This TCP Auto-Wake proxy supports Minecraft Java. Bedrock uses UDP and cannot use Java startup notices.' };
    }

    if (!tunnelConfigured) {
      return {
        status: 'unsupported',
        wakePort,
        minecraftPort,
        publicAddress,
        playitInstalled,
        playitRunning,
        tunnelConfigured,
        message: `Auto-Wake needs a Playit.gg tunnel targeting wake port ${wakePort}. A tunnel directly to Minecraft port ${minecraftPort} bypasses the wake proxy.`,
      };
    }

    if (!server) {
      return {
        status: 'disabled',
        wakePort,
        minecraftPort,
        publicAddress,
        playitInstalled,
        playitRunning,
        tunnelConfigured,
      };
    }

    const isListening = this.listeners.has(serverId);
    let message = 'Wake Proxy is waiting to bind.';
    if (isListening) {
      if (starting) {
        message = 'Server is starting. Players receive a startup notice after a short wait; refreshing the Minecraft server list shows the latest reported progress.';
      } else if (server.status === 'running') {
        message = `Listening on wake port ${wakePort}. Reverse-proxying active traffic to Minecraft port ${minecraftPort}.`;
      } else {
        message = `Listening on wake port ${wakePort}. Incoming connection will start "${server.name}".`;
      }
    }

    return {
      status: isListening ? 'active' : 'standby',
      wakePort,
      minecraftPort,
      publicAddress,
      playitInstalled,
      playitRunning,
      tunnelConfigured,
      message,
      starting,
      startup,
      playerNotice: 'Fast starts connect directly. Otherwise players see a Starting server notice; refresh the Minecraft server list for progress and join again when ready.',
    };
  }

  async reconcileAll(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    const servers = this.serverRepo.list();
    const playit = await this.playitService.getStatus();
    if (this.stopped || generation !== this.generation) return;

    for (const server of servers) {
      if (this.stopped || generation !== this.generation) return;
      if (!['starting', 'running'].includes(server.status)) this.readyServers.delete(server.id);
      const settings = this.settingsRepo.find(server.id);
      const shouldBeListening =
        server.software !== 'bedrock' && server.game !== 'minecraft-bedrock' &&
        Boolean(settings?.autoWake) &&
        playit.installed &&
        playit.secretExists;

      const currentlyListening = this.listeners.has(server.id);
      const currentPort = this.listenerPorts.get(server.id);

      const defaultWakePort = server.port >= 55535 ? server.port - 10000 : server.port + 10000;
      const desiredPort = settings?.wakeProxyPort ?? defaultWakePort;

      if (shouldBeListening) {
        if (!currentlyListening) {
          await this.startListening(server.id, desiredPort);
        } else if (currentPort !== desiredPort) {
          // Port changed in settings; restart listener on new port
          this.stopListening(server.id);
          await this.startListening(server.id, desiredPort);
        }
      } else if (!shouldBeListening && currentlyListening) {
        this.stopListening(server.id);
      }
    }
    for (const id of this.listeners.keys()) if (!servers.some(server => server.id === id)) this.stopListening(id);
  }

  private startListening(serverId: string, port: number): Promise<void> {
    const existing = this.listenerStarts.get(serverId);
    if (existing) return existing;
    const pending = this.bindListener(serverId, port).finally(() => { if (this.listenerStarts.get(serverId) === pending) this.listenerStarts.delete(serverId); });
    this.listenerStarts.set(serverId, pending);
    return pending;
  }

  private bindListener(serverId: string, port: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const generation = this.generation;
    if (this.listeners.has(serverId)) return Promise.resolve();

    const server = this.serverRepo.find(serverId);
    if (!server) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const listener = net.createServer((socket) => {
        this.handleIncomingConnection(serverId, socket, port);
      });

      listener.on('error', (err) => {
        console.warn(`[Wake Proxy] [Server: ${server.name}] Listener error on port ${port}:`, err.message);
        if (this.listeners.get(serverId) === listener) { this.listeners.delete(serverId); this.listenerPorts.delete(serverId); }
        resolve();
      });

      try {
        listener.listen(port, '0.0.0.0', () => {
          if (this.stopped || generation !== this.generation) { listener.close(); resolve(); return; }
          if (!this.settingsRepo.find(serverId)?.autoWake) { listener.close(); resolve(); return; }
          console.log(`[Wake Proxy] [Server: ${server.name}] Listening on wake port ${port} (Minecraft port: ${server.port})`);
          this.listeners.set(serverId, listener);
          this.listenerPorts.set(serverId, port);
          resolve();
        });
      } catch (err) {
        console.warn(`[Wake Proxy] [Server: ${server.name}] Could not bind wake port ${port}:`, err);
        resolve();
      }
    });
  }

  private stopListening(serverId: string): void {
    for (const client of [...(this.pendingQueues.get(serverId) ?? [])]) { client.cleanup(); this.sendDisconnectAndClose(client.socket, '§e[NodePilot Auto-Wake]\nAuto-Wake settings changed. Please reconnect.'); }
    for (const socket of this.inspections.get(serverId) ?? []) socket.destroy();
    for (const socket of this.statusClients.get(serverId) ?? []) socket.destroy();
    this.readyServers.delete(serverId);
    const listener = this.listeners.get(serverId);
    if (listener) {
      try {
        listener.close();
      } catch {
        // ignore close error
      }
      this.listeners.delete(serverId);
      this.listenerPorts.delete(serverId);
    }
  }

  private handleIncomingConnection(serverId: string, socket: net.Socket, wakePort: number): void {
    socket.setNoDelay(true);
    const remoteAddr = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 'unknown'}`;
    const server = this.serverRepo.find(serverId);
    if (!server) {
      socket.destroy();
      return;
    }

    console.log(`[Wake Proxy] [Server: ${server.name}] Connection accepted from ${remoteAddr} on wake port ${wakePort}.`);

    // Only a protocol-confirmed backend can bypass the startup notice path.
    if (this.isReady(server)) {
      this.forwardConnection(server, socket, [], remoteAddr);
      return;
    }
    const inspections = this.inspections.get(serverId) ?? new Set<net.Socket>();
    if (this.stopped || inspections.size + (this.pendingQueues.get(serverId)?.length ?? 0) + (this.statusClients.get(serverId)?.size ?? 0) >= MAX_WAITING_CLIENTS) { socket.destroy(); return; }
    this.inspections.set(serverId, inspections);
    inspections.add(socket);
    // Inspect every unready server, including one whose Java process just spawned.
    let bufferedChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let inspected = false;
    let inspectionTimeout: NodeJS.Timeout | null = null;

    const cleanupInspection = () => {
      if (inspectionTimeout) {
        clearTimeout(inspectionTimeout);
        inspectionTimeout = null;
      }
      socket.removeListener('data', onData);
      inspections.delete(socket);
      if (!inspections.size && this.inspections.get(serverId) === inspections) this.inspections.delete(serverId);
    };

    const onData = (chunk: Buffer) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > MAX_BUFFERED_BYTES) { cleanupInspection(); socket.destroy(); return; }
      bufferedChunks.push(chunk);
      const fullBuffer = Buffer.concat(bufferedChunks);

      if (!inspected) {
        let handshake: MinecraftHandshake | null;
        try { handshake = parseHandshake(fullBuffer); }
        catch { cleanupInspection(); socket.destroy(); return; }
        if (handshake) {
          inspected = true;
          cleanupInspection();
          this.handleHandshake(server, socket, handshake, bufferedChunks, remoteAddr);
        } else {
          try {
            const length = readVarInt(fullBuffer);
            if (length && fullBuffer.length >= length.bytesRead + length.value) { cleanupInspection(); socket.destroy(); }
          } catch { cleanupInspection(); socket.destroy(); }
        }
      }
    };

    socket.on('data', onData);

    socket.once('error', (err) => {
      cleanupInspection();
    });

    socket.once('close', () => {
      cleanupInspection();
    });

    // Port scans and silent/raw connections must not launch Minecraft.
    inspectionTimeout = setTimeout(() => {
      if (!inspected && !socket.destroyed) {
        inspected = true;
        cleanupInspection();
        socket.destroy();
      }
    }, this.options.inspectionTimeoutMs ?? 5_000);
  }

  private handleHandshake(
    server: ServerRecord,
    socket: net.Socket,
    handshake: MinecraftHandshake,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): void {
    if (socket.destroyed) return;

    if (handshake.nextState === 1) {
      this.handleStatus(server, socket, handshake, Buffer.concat(initialBuffers).subarray(handshake.totalBytes));
      return;
    }

    // Login Request: Player clicked "Join Server"
    console.log(`[Wake Proxy] [Server: ${server.name}] Wake requested by ${remoteAddr} (nextState=${handshake.nextState}). Waking server...`);
    this.handleWakeAndQueue(server, socket, initialBuffers, remoteAddr);
  }

  private handleStatus(server: ServerRecord, socket: net.Socket, handshake: MinecraftHandshake, initial: Buffer): void {
    const clients = this.statusClients.get(server.id) ?? new Set<net.Socket>();
    clients.add(socket); this.statusClients.set(server.id, clients);
    let buffer = initial, requested = false, responded = false, replying = false;
    let ping: Buffer | undefined;
    const timeout = setTimeout(() => socket.destroy(), 4_000);
    const cleanup = () => { clearTimeout(timeout); socket.removeListener('data', onData); clients.delete(socket); if (!clients.size && this.statusClients.get(server.id) === clients) this.statusClients.delete(server.id); };
    const finishPing = () => { if (responded && ping) { socket.end(createPongPacket(ping)); socket.pause(); } };
    const reply = async () => {
      if (replying) return; replying = true;
      const generation = this.generation;
      let packet: Buffer | undefined;
      const current = this.serverRepo.find(server.id);
      if (current && ['running', 'starting'].includes(current.status)) {
        const expectedLaunch = this.launchKey(current);
        const probe = await this.probeBackend(current, 800);
        if (this.stopped || generation !== this.generation || socket.destroyed) return;
        const latest = this.serverRepo.find(server.id);
        if (probe.ready && latest && ['running', 'starting'].includes(latest.status) && this.launchKey(latest) === expectedLaunch) {
          this.readyServers.set(server.id, expectedLaunch);
          if (probe.statusJson !== undefined) packet = createPacket(0x00, writeString(JSON.stringify(probe.statusJson)));
        }
      }
      if (this.stopped || generation !== this.generation || socket.destroyed) return;
      const latest = this.serverRepo.find(server.id) ?? server;
      const ready = this.isReady(latest), starting = !ready && this.isStarting(latest), progress = this.progress(latest);
      packet ??= createStatusResponsePacket({
        motdText: `§6[NodePilot] §f${server.name}\n` + (starting
          ? `§eStarting server… §f${progress.stage}${progress.percent === null ? '' : ` — ${progress.percent}% (stage)`}`
          : ready ? '§aServer is ready. Join now!' : '§7Server is sleeping. §aConnect to wake it up!'),
        protocolVersion: handshake.protocolVersion, versionName: starting ? 'NodePilot Auto-Wake [Starting]' : ready ? 'NodePilot Auto-Wake [Ready]' : 'NodePilot Auto-Wake [Sleeping]', maxPlayers: 0, onlinePlayers: 0, hidePlayerCounts: ready,
      });
      socket.write(packet); responded = true; finishPing();
    };
    const consume = () => {
      try {
        if (buffer.length > 4096) throw new Error('Status request too large');
        while (buffer.length) {
          const length = readVarInt(buffer); if (!length) return;
          if (length.value < 1 || length.value > 32) throw new Error('Invalid status frame');
          if (buffer.length < length.bytesRead + length.value) return;
          const frame = buffer.subarray(length.bytesRead, length.bytesRead + length.value);
          buffer = buffer.subarray(length.bytesRead + length.value);
          const id = readVarInt(frame); if (!id) throw new Error('Invalid status packet');
          if (!requested && id.value === 0 && frame.length === id.bytesRead) { requested = true; void reply().catch(() => socket.destroy()); }
          else if (requested && !ping && id.value === 1 && frame.length === id.bytesRead + 8) { ping = Buffer.from(frame.subarray(id.bytesRead)); finishPing(); }
          else throw new Error('Unexpected status packet');
        }
      } catch { socket.destroy(); }
    };
    const onData = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); consume(); };
    socket.on('data', onData); socket.once('close', cleanup); socket.once('error', cleanup); consume();
  }

  private handleWakeAndQueue(
    server: ServerRecord,
    socket: net.Socket,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): void {
    if (this.enqueuePendingClient(server, socket, initialBuffers, remoteAddr)) void this.ensureServerStarting(server);
  }

  private enqueuePendingClient(
    server: ServerRecord,
    socket: net.Socket,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): boolean {
    const queue = this.pendingQueues.get(server.id) ?? [];
    if (this.stopped || queue.length >= MAX_WAITING_CLIENTS) { this.sendDisconnectAndClose(socket, '§e[NodePilot Auto-Wake]\nToo many waiting connections. Please try again shortly.'); return false; }
    this.pendingQueues.set(server.id, queue);
    let bytes = initialBuffers.reduce((total, chunk) => total + chunk.length, 0);
    const pending: PendingClient = {
      socket,
      bufferedChunks: [...initialBuffers],
      remoteAddr,
      safetyTimer: setTimeout(() => {
        pending.cleanup();
        const current = this.serverRepo.find(server.id) ?? server;
        this.sendDisconnectAndClose(socket, this.playerNotice(current));
      }, this.options.playerWaitMs ?? 2_000),
      cleanup: () => {},
    };

    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BUFFERED_BYTES) { pending.cleanup(); socket.destroy(); return; }
      pending.bufferedChunks.push(chunk);
    };

    socket.on('data', onData);

    const cleanup = () => {
      clearTimeout(pending.safetyTimer);
      socket.removeListener('data', onData);
      this.removePendingClient(server.id, socket);
    };
    pending.cleanup = cleanup;

    socket.once('close', cleanup);
    socket.once('error', cleanup);

    queue.push(pending);
    return true;
  }

  private removePendingClient(serverId: string, socket: net.Socket): void {
    const queue = this.pendingQueues.get(serverId);
    if (!queue) return;
    const idx = queue.findIndex((c) => c.socket === socket);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
    if (!queue.length) this.pendingQueues.delete(serverId);
  }

  private ensureServerStarting(server: ServerRecord): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const existing = this.wakePromises.get(server.id);
    if (existing) return existing;
    const generation = this.generation;
    this.readyServers.delete(server.id);
    this.wakeStartedAt.set(server.id, new Date().toISOString());
    const wakePromise = Promise.resolve().then(async () => {
      try {
        if (this.stopped || generation !== this.generation) return false;
        console.log(`[Wake Proxy] [Server: ${server.name}] Starting server via Auto-Wake trigger...`);

        let javaPath = server.javaPath ?? undefined;
        let warning: string | undefined;
        if (this.javaService && ['offline', 'error'].includes(server.status) && !this.runtime.isProcessActive?.(server.id) && server.software !== 'bedrock' && server.startupConfig.mode !== 'executable') {
          const usable = await this.javaService.findUsable(server.requiredJavaMajor, server.javaPath);
          if (usable) {
            javaPath = usable.installation.path;
            warning = usable.warning;
          }
        }
        if (this.stopped || generation !== this.generation) return false;
        if (!this.settingsRepo.find(server.id)?.autoWake) return false;
        const current = this.serverRepo.find(server.id);
        // Java discovery can overlap a stopped-server version change. Never
        // launch the newly installed runtime with Java chosen for the old one.
        if (!current || current.version !== server.version || current.software !== server.software
          || current.requiredJavaMajor !== server.requiredJavaMajor || current.javaPath !== server.javaPath
          || JSON.stringify(current.startupConfig) !== JSON.stringify(server.startupConfig)) {
          throw new Error('The server version or Java configuration changed while waking it. Join again to retry.');
        }
        if (['offline', 'error'].includes(current.status) && !this.runtime.isProcessActive?.(current.id)) {
          await this.runtime.start(current, javaPath, warning);
          console.log(`[Wake Proxy] [Server: ${server.name}] Server process launched. Probing backend readiness on port ${current.port}...`);
        }
        if (this.stopped || generation !== this.generation) return false;
        const ready = await this.waitForBackendReady(server.id, server.port, this.options.startupTimeoutMs ?? 180_000, generation);
        if (this.stopped || generation !== this.generation) return false;
        if (ready) {
          const current = this.serverRepo.find(server.id);
          if (!current) return false;
          this.readyServers.set(server.id, this.launchKey(current));
          console.log(`[Wake Proxy] [Server: ${server.name}] Backend ready on port ${server.port}. Forwarding queued connections...`);
          this.flushPendingClients(server.id, server.port, true);
          return true;
        } else {
          const statusCheck = this.serverRepo.find(server.id);
          const reason = !statusCheck || !['starting', 'running'].includes(statusCheck.status)
            ? 'Server process exited unexpectedly during boot' : undefined;
          console.warn(`[Wake Proxy] [Server: ${server.name}] ${reason ?? 'Readiness is not confirmed yet; the server continues starting. Check its console.'}`);
          this.flushPendingClients(server.id, server.port, false, reason);
          return false;
        }
      } catch (err) {
        if (this.stopped || generation !== this.generation) return false;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Wake Proxy] [Server: ${server.name}] Error during Auto-Wake startup:`, errMsg);
        this.flushPendingClients(server.id, server.port, false, errMsg);
        return false;
      } finally {
        if (this.wakePromises.get(server.id) === wakePromise) this.wakePromises.delete(server.id);
      }
    });

    this.wakePromises.set(server.id, wakePromise);
    return wakePromise;
  }

  private async waitForBackendReady(serverId: string, port: number, maxTimeoutMs: number, generation: number): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 500;

    const server = this.serverRepo.find(serverId);
    const isJava = server?.software !== 'bedrock' && server?.startupConfig.mode !== 'executable';

    while (!this.stopped && generation === this.generation && Date.now() - startTime < maxTimeoutMs) {
      const current = this.serverRepo.find(serverId);
      if (!current || (current.status !== 'starting' && current.status !== 'running' && !this.runtime.isProcessActive?.(serverId))) {
        console.warn(`[Wake Proxy] Server ${serverId} is no longer running (status: ${current?.status}).`);
        return false;
      }
      if (!['starting', 'running'].includes(current.status)) { await new Promise(resolve => setTimeout(resolve, pollIntervalMs)); continue; }

      if (isJava) {
        try {
          const expectedLaunch = this.launchKey(current);
          const probe = await this.probeBackend(current, 1_000);
          if (this.stopped || generation !== this.generation) return false;
          const latest = this.serverRepo.find(serverId);
          if (probe.ready && latest && ['starting', 'running'].includes(latest.status) && this.launchKey(latest) === expectedLaunch) {
            return true;
          }
        } catch {
          // ignore probe error while booting
        }
      } else {
        // For Bedrock or executable servers, verify via TCP connection check
        const ready = await this.checkTcpPort('127.0.0.1', port, 1_000);
        if (this.stopped || generation !== this.generation) return false;
        if (ready) {
          return true;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }

  private async checkTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          sock.destroy();
          resolve(false);
        }
      }, timeoutMs);

      sock.once('connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        }
      });

      sock.once('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          sock.destroy();
          resolve(false);
        }
      });
    });
  }

  private flushPendingClients(
    serverId: string,
    port: number,
    success: boolean,
    failureReason?: string,
  ): void {
    const queue = this.pendingQueues.get(serverId) ?? [];
    this.pendingQueues.delete(serverId);

    const server = this.serverRepo.find(serverId);
    const serverName = server?.name ?? serverId;

    for (const client of queue) {
      client.socket.pause();
      client.cleanup();

      if (client.socket.destroyed) continue;

      if (success && server) {
        console.log(`[Wake Proxy] [Server: ${serverName}] Forwarding queued client (${client.remoteAddr}) to 127.0.0.1:${port}.`);
        this.forwardConnection(server, client.socket, client.bufferedChunks, client.remoteAddr);
      } else {
        console.log(`[Wake Proxy] [Server: ${serverName}] Notifying queued client (${client.remoteAddr}) of failure: ${failureReason}.`);
        this.sendDisconnectAndClose(
          client.socket,
          !failureReason && server ? this.playerNotice(server) : `§c[NodePilot Auto-Wake]\n\n§cServer failed to start:\n§f${failureReason ?? 'Unknown error'}`,
        );
      }
    }
  }

  private forwardConnection(
    server: ServerRecord,
    clientSocket: net.Socket,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): void {
    if (clientSocket.destroyed) return;
    clientSocket.pause();

    const backendSocket = net.connect({ host: '127.0.0.1', port: server.port });
    backendSocket.setNoDelay(true);

    backendSocket.once('connect', () => {
      if (clientSocket.destroyed) { backendSocket.destroy(); return; }
      console.log(`[Wake Proxy] [Server: ${server.name}] Connection from ${remoteAddr} forwarded to backend on 127.0.0.1:${server.port}.`);
      for (const chunk of initialBuffers) {
        backendSocket.write(chunk);
      }
      clientSocket.pipe(backendSocket);
      backendSocket.pipe(clientSocket);
      clientSocket.resume();
    });

    backendSocket.on('error', (err) => {
      console.warn(`[Wake Proxy] [Server: ${server.name}] Backend socket error for client ${remoteAddr}:`, err.message);
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      backendSocket.destroy();
    });

    backendSocket.on('close', () => {
      clientSocket.destroy();
    });

    clientSocket.on('close', () => {
      backendSocket.destroy();
    });
  }

  private sendDisconnectAndClose(socket: net.Socket, message: string): void {
    if (socket.destroyed) return;
    try {
      const packet = createLoginDisconnectPacket(message);
      socket.pause();
      socket.end(packet);
      const timeout = setTimeout(() => socket.destroy(), 1_000);
      timeout.unref();
      socket.once('close', () => clearTimeout(timeout));
    } catch {
      socket.destroy();
    }
  }
}
