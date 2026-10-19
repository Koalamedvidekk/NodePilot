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
  probeMinecraftServer,
  type MinecraftHandshake,
} from '../lib/minecraft-protocol.js';

export interface WakeProxyStatus {
  status: 'active' | 'standby' | 'disabled' | 'unsupported';
  wakePort: number | null;
  minecraftPort: number;
  publicAddress: string | null;
  playitInstalled: boolean;
  playitRunning: boolean;
  tunnelConfigured: boolean;
  message?: string;
}

interface PendingClient {
  socket: net.Socket;
  bufferedChunks: Buffer[];
  remoteAddr: string;
  safetyTimer: NodeJS.Timeout;
}

export class WakeProxyService {
  private readonly listeners = new Map<string, net.Server>();
  private readonly listenerPorts = new Map<string, number>();
  private readonly pendingQueues = new Map<string, PendingClient[]>();
  private readonly wakePromises = new Map<string, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverRepo: ServerRepository,
    private readonly settingsRepo: ServerSettingsRepository,
    private readonly tunnelRepo: ServerTunnelRepository,
    private readonly playitService: PlayitService,
    private readonly runtime: ServerRuntime,
    private readonly javaService?: JavaService,
  ) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
    this.timer.unref();
    void this.reconcileAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const [serverId, queue] of this.pendingQueues.entries()) {
      for (const client of queue) {
        clearTimeout(client.safetyTimer);
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
    this.wakePromises.clear();
  }

  async getStatus(serverId: string): Promise<WakeProxyStatus> {
    const server = this.serverRepo.find(serverId);
    const settings = this.settingsRepo.find(serverId);
    const tunnel = this.tunnelRepo.find(serverId);
    const playit = await this.playitService.getStatus();

    const minecraftPort = server?.port ?? 25565;
    const defaultWakePort = minecraftPort >= 55535 ? minecraftPort - 10000 : minecraftPort + 10000;
    const wakePort = settings?.wakeProxyPort ?? defaultWakePort;
    const publicAddress = tunnel?.publicAddress ?? null;
    const enabled = settings?.autoWake ?? false;

    const playitInstalled = playit.installed;
    const playitRunning = playit.isRunning;
    const tunnelConfigured = Boolean(
      tunnel?.tunnelId &&
      (tunnel.status === 'connected' || tunnel.status === 'disconnected') &&
      (tunnel.localPort === wakePort || tunnel.localPort === minecraftPort),
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

    if (!tunnelConfigured) {
      return {
        status: 'unsupported',
        wakePort,
        minecraftPort,
        publicAddress,
        playitInstalled,
        playitRunning,
        tunnelConfigured,
        message: `No active Playit.gg tunnel targeting port ${wakePort} or ${minecraftPort} was found. Configure a tunnel in Playit first.`,
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
      if (server.status === 'running') {
        message = `Listening on wake port ${wakePort}. Reverse-proxying active traffic to Minecraft port ${minecraftPort}.`;
      } else if (server.status === 'starting') {
        message = `Server is waking up. Incoming connections on port ${wakePort} are buffered and will be forwarded when ready.`;
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
    };
  }

  async reconcileAll(): Promise<void> {
    const servers = this.serverRepo.list();
    const playit = await this.playitService.getStatus();

    for (const server of servers) {
      const settings = this.settingsRepo.find(server.id);
      const shouldBeListening =
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
  }

  private startListening(serverId: string, port: number): Promise<void> {
    if (this.listeners.has(serverId)) return Promise.resolve();

    const server = this.serverRepo.find(serverId);
    if (!server) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const listener = net.createServer((socket) => {
        this.handleIncomingConnection(serverId, socket, port);
      });

      listener.on('error', (err) => {
        console.warn(`[Wake Proxy] [Server: ${server.name}] Listener error on port ${port}:`, err.message);
        this.listeners.delete(serverId);
        this.listenerPorts.delete(serverId);
        resolve();
      });

      try {
        listener.listen(port, '0.0.0.0', () => {
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

    // Case 1: Server is already running
    if (server.status === 'running') {
      this.forwardConnection(server, socket, [], remoteAddr);
      return;
    }

    // Case 2: Server is currently starting
    if (server.status === 'starting') {
      console.log(`[Wake Proxy] [Server: ${server.name}] Server is currently starting. Buffering connection from ${remoteAddr}...`);
      this.enqueuePendingClient(server, socket, [], remoteAddr);
      return;
    }

    // Case 3: Server is offline / stopped -> Inspect protocol to distinguish Status Ping from Login Wake
    let bufferedChunks: Buffer[] = [];
    let inspected = false;
    let inspectionTimeout: NodeJS.Timeout | null = null;

    const cleanupInspection = () => {
      if (inspectionTimeout) {
        clearTimeout(inspectionTimeout);
        inspectionTimeout = null;
      }
      socket.removeListener('data', onData);
    };

    const onData = (chunk: Buffer) => {
      bufferedChunks.push(chunk);
      const fullBuffer = Buffer.concat(bufferedChunks);

      if (!inspected) {
        const handshake = parseHandshake(fullBuffer);
        if (handshake) {
          inspected = true;
          cleanupInspection();
          this.handleHandshake(server, socket, handshake, bufferedChunks, remoteAddr);
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

    // If client does not send a standard Minecraft handshake within 400ms (e.g. raw ping or non-standard),
    // proceed to wake the server and buffer the connection
    inspectionTimeout = setTimeout(() => {
      if (!inspected && !socket.destroyed) {
        inspected = true;
        cleanupInspection();
        console.log(`[Wake Proxy] [Server: ${server.name}] Non-Minecraft or delayed handshake from ${remoteAddr}. Waking server...`);
        this.handleWakeAndQueue(server, socket, bufferedChunks, remoteAddr);
      }
    }, 400);
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
      // Status Ping: Player opened multiplayer screen or server pinger queried port
      console.log(`[Wake Proxy] [Server: ${server.name}] Status ping from ${remoteAddr} (protocol ${handshake.protocolVersion}). Sending sleeping MOTD.`);

      const motd = createStatusResponsePacket({
        motdText: `§6[NodePilot] §f${server.name}\n§7Server is sleeping. §aConnect to wake it up!`,
        protocolVersion: handshake.protocolVersion,
        versionName: 'NodePilot Auto-Wake [Sleeping]',
        maxPlayers: 0,
        onlinePlayers: 0,
      });

      socket.write(motd);

      // Handle subsequent ping packet (packet ID 0x01) to respond with pong
      let pingBuffer = Buffer.alloc(0);
      const onPingData = (chunk: Buffer) => {
        pingBuffer = Buffer.concat([pingBuffer, chunk]);
        try {
          const len = readVarInt(pingBuffer, 0);
          if (len && pingBuffer.length >= len.bytesRead + len.value) {
            const pid = readVarInt(pingBuffer, len.bytesRead);
            if (pid && pid.value === 0x01) {
              const payload = pingBuffer.subarray(len.bytesRead + pid.bytesRead, len.bytesRead + len.value);
              socket.write(createPongPacket(payload));
            }
            socket.end();
          }
        } catch {
          socket.end();
        }
      };

      socket.on('data', onPingData);

      setTimeout(() => {
        if (!socket.destroyed) {
          socket.end();
        }
      }, 3_000);
      return;
    }

    // Login Request: Player clicked "Join Server"
    console.log(`[Wake Proxy] [Server: ${server.name}] Wake requested by ${remoteAddr} (nextState=${handshake.nextState}). Waking server...`);
    this.handleWakeAndQueue(server, socket, initialBuffers, remoteAddr);
  }

  private handleWakeAndQueue(
    server: ServerRecord,
    socket: net.Socket,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): void {
    this.enqueuePendingClient(server, socket, initialBuffers, remoteAddr);
    void this.ensureServerStarting(server);
  }

  private enqueuePendingClient(
    server: ServerRecord,
    socket: net.Socket,
    initialBuffers: Buffer[],
    remoteAddr: string,
  ): void {
    const queue = this.pendingQueues.get(server.id) ?? [];
    this.pendingQueues.set(server.id, queue);

    const pending: PendingClient = {
      socket,
      bufferedChunks: [...initialBuffers],
      remoteAddr,
      safetyTimer: setTimeout(() => {
        console.log(`[Wake Proxy] [Server: ${server.name}] Safety timeout reached for ${remoteAddr} (server still booting). Sending reconnect notice.`);
        this.sendDisconnectAndClose(
          socket,
          `§6[NodePilot Auto-Wake]\n\n§eServer "${server.name}" is waking up (~10s remaining).\n§aPlease click Join again to enter!`,
        );
        this.removePendingClient(server.id, socket);
      }, 24_000),
    };

    const onData = (chunk: Buffer) => {
      pending.bufferedChunks.push(chunk);
    };

    socket.on('data', onData);

    const cleanup = () => {
      clearTimeout(pending.safetyTimer);
      socket.removeListener('data', onData);
      this.removePendingClient(server.id, socket);
    };

    socket.once('close', cleanup);
    socket.once('error', cleanup);

    queue.push(pending);
  }

  private removePendingClient(serverId: string, socket: net.Socket): void {
    const queue = this.pendingQueues.get(serverId);
    if (!queue) return;
    const idx = queue.findIndex((c) => c.socket === socket);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  }

  private ensureServerStarting(server: ServerRecord): Promise<boolean> {
    const existing = this.wakePromises.get(server.id);
    if (existing) return existing;

    const wakePromise = (async () => {
      try {
        console.log(`[Wake Proxy] [Server: ${server.name}] Starting server via Auto-Wake trigger...`);

        let javaPath = server.javaPath ?? undefined;
        let warning: string | undefined;
        if (this.javaService && server.software !== 'bedrock' && server.startupConfig.mode !== 'executable') {
          const usable = await this.javaService.findUsable(server.requiredJavaMajor, server.javaPath);
          if (usable) {
            javaPath = usable.installation.path;
            warning = usable.warning;
          }
        }

        const current = this.serverRepo.find(server.id) ?? server;
        if (current.status === 'offline') {
          await this.runtime.start(current, javaPath, warning);
          console.log(`[Wake Proxy] [Server: ${server.name}] Server process launched. Probing backend readiness on port ${current.port}...`);
        }

        const ready = await this.waitForBackendReady(server.id, server.port, 50_000);
        if (ready) {
          console.log(`[Wake Proxy] [Server: ${server.name}] Backend ready on port ${server.port}. Forwarding queued connections...`);
          this.flushPendingClients(server.id, server.port, true);
          return true;
        } else {
          const statusCheck = this.serverRepo.find(server.id);
          const reason = !statusCheck || statusCheck.status === 'offline'
            ? 'Server process exited unexpectedly during boot'
            : 'Startup timed out after 50s';
          console.error(`[Wake Proxy] [Server: ${server.name}] Wake failed: ${reason}.`);
          this.flushPendingClients(server.id, server.port, false, reason);
          return false;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Wake Proxy] [Server: ${server.name}] Error during Auto-Wake startup:`, errMsg);
        this.flushPendingClients(server.id, server.port, false, errMsg);
        return false;
      } finally {
        this.wakePromises.delete(server.id);
      }
    })();

    this.wakePromises.set(server.id, wakePromise);
    return wakePromise;
  }

  private async waitForBackendReady(serverId: string, port: number, maxTimeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 500;

    const server = this.serverRepo.find(serverId);
    const isJava = server?.software !== 'bedrock' && server?.startupConfig.mode !== 'executable';

    while (Date.now() - startTime < maxTimeoutMs) {
      const current = this.serverRepo.find(serverId);
      if (!current || (current.status !== 'starting' && current.status !== 'running')) {
        console.warn(`[Wake Proxy] Server ${serverId} is no longer running (status: ${current?.status}).`);
        return false;
      }

      if (isJava) {
        try {
          const probe = await probeMinecraftServer('127.0.0.1', port, 1_000);
          if (probe.ready) {
            return true;
          }
        } catch {
          // ignore probe error while booting
        }
      } else {
        // For Bedrock or executable servers, verify via TCP connection check
        const ready = await this.checkTcpPort('127.0.0.1', port, 1_000);
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
      clearTimeout(client.safetyTimer);
      client.socket.removeAllListeners('data');

      if (client.socket.destroyed) continue;

      if (success && server) {
        console.log(`[Wake Proxy] [Server: ${serverName}] Forwarding queued client (${client.remoteAddr}) to 127.0.0.1:${port}.`);
        this.forwardConnection(server, client.socket, client.bufferedChunks, client.remoteAddr);
      } else {
        console.log(`[Wake Proxy] [Server: ${serverName}] Notifying queued client (${client.remoteAddr}) of failure: ${failureReason}.`);
        this.sendDisconnectAndClose(
          client.socket,
          `§c[NodePilot Auto-Wake]\n\n§cServer failed to start:\n§f${failureReason ?? 'Unknown error'}`,
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

    const backendSocket = net.connect({ host: '127.0.0.1', port: server.port });
    backendSocket.setNoDelay(true);

    backendSocket.once('connect', () => {
      console.log(`[Wake Proxy] [Server: ${server.name}] Connection from ${remoteAddr} forwarded to backend on 127.0.0.1:${server.port}.`);
      for (const chunk of initialBuffers) {
        backendSocket.write(chunk);
      }
      clientSocket.pipe(backendSocket);
      backendSocket.pipe(clientSocket);
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
      socket.write(packet, () => {
        socket.end();
      });
    } catch {
      socket.destroy();
    }
  }
}
