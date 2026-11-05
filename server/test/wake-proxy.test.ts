import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import { WakeProxyService } from '../services/wake-proxy-service.js';
import type { PlayitService } from '../services/playit-service.js';
import type { ServerRuntime } from '../services/server-runtime.js';
import type { JavaService } from '../services/java-service.js';
import type { ConsoleLine } from '../types.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPacket,
  writeVarInt,
  writeString,
  readVarInt,
  readString,
  parseHandshake,
  createStatusResponsePacket,
} from '../lib/minecraft-protocol.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function buildClientHandshakePacket(port: number, nextState: number, host = '127.0.0.1'): Buffer {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const data = Buffer.concat([
    writeVarInt(765),
    writeString(host),
    portBuf,
    writeVarInt(nextState),
  ]);
  return createPacket(0x00, data);
}

function buildLoginStartPacket(username: string): Buffer {
  return createPacket(0x00, writeString(username));
}

test('WakeProxyService responds to status ping with sleeping MOTD and does not start server', async () => {
  const db = openDatabase(':memory:');
  const serverRepo = new ServerRepository(db);
  const settingsRepo = new ServerSettingsRepository(db);
  const tunnelRepo = new ServerTunnelRepository(db);

  const backendPort = await getFreePort();
  const wakePort = await getFreePort();

  const server = serverRepo.create({
    id: 'wake-test-1',
    machineId: 'local',
    name: 'Sleeping World',
    directory: 'sleeping-world',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    port: backendPort,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);

  settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnelRepo.save({
    serverId: server.id,
    tunnelId: 'tun-test-1',
    localPort: wakePort,
    status: 'connected',
  });

  const mockPlayit: Partial<PlayitService> = {
    getStatus: async () => ({
      installed: true,
      isManaged: false,
      binaryPath: 'playit',
      version: '0.17.1',
      isRunning: true,
      secretExists: true,
      secretPath: 'playit.toml',
      claimUrl: null,
    }),
  };

  let startCallCount = 0;
  const mockRuntime: Partial<ServerRuntime> = {
    start: async () => {
      startCallCount++;
      return serverRepo.find(server.id)!;
    },
  };

  const service = new WakeProxyService(
    serverRepo,
    settingsRepo,
    tunnelRepo,
    mockPlayit as PlayitService,
    mockRuntime as ServerRuntime,
  );

  try {
    await service.reconcileAll();

    // Verify proxy status
    const status = await service.getStatus(server.id);
    assert.equal(status.status, 'active');
    assert.equal(status.wakePort, wakePort);

    // Connect client and send Handshake (nextState = 1: Status) + Status Request (0x00)
    const client = net.connect({ host: '127.0.0.1', port: wakePort });
    const receivedChunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        const hs = buildClientHandshakePacket(wakePort, 1);
        const req = createPacket(0x00);
        client.write(Buffer.concat([hs, req]));
      });

      client.on('data', (chunk) => {
        receivedChunks.push(chunk);
        const full = Buffer.concat(receivedChunks);
        const packetLen = readVarInt(full, 0);
        if (packetLen && full.length >= packetLen.bytesRead + packetLen.value) {
          const packetId = readVarInt(full, packetLen.bytesRead);
          if (packetId && packetId.value === 0x00) {
            const jsonStr = readString(full, packetLen.bytesRead + packetId.bytesRead);
            if (jsonStr) {
              const parsed = JSON.parse(jsonStr.value);
              assert.ok(parsed.description.text.includes('Server is sleeping'));
              resolve();
            }
          }
        }
      });

      client.on('error', reject);
    });

    client.destroy();

    // Confirm server.start was NEVER called for a status ping
    assert.equal(startCallCount, 0);
  } finally {
    service.stop();
    db.close();
  }
});

test('WakeProxyService wakes offline server on Login request and forwards connection seamlessly to backend', async () => {
  const db = openDatabase(':memory:');
  const serverRepo = new ServerRepository(db);
  const settingsRepo = new ServerSettingsRepository(db);
  const tunnelRepo = new ServerTunnelRepository(db);

  const backendPort = await getFreePort();
  const wakePort = await getFreePort();

  const server = serverRepo.create({
    id: 'wake-test-2',
    machineId: 'local',
    name: 'Adventure Server',
    directory: 'adventure',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    port: backendPort,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);

  settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnelRepo.save({
    serverId: server.id,
    tunnelId: 'tun-test-2',
    localPort: wakePort,
    status: 'connected',
  });

  const mockPlayit: Partial<PlayitService> = {
    getStatus: async () => ({
      installed: true,
      isManaged: false,
      binaryPath: 'playit',
      version: '0.17.1',
      isRunning: true,
      secretExists: true,
      secretPath: 'playit.toml',
      claimUrl: null,
    }),
  };

  // Mock Minecraft Backend Server
  let mockBackend: net.Server | null = null;
  const backendReceivedPackets: Buffer[] = [];

  const startMockBackend = () => {
    mockBackend = net.createServer((sock) => {
      sock.on('data', (data) => {
        backendReceivedPackets.push(data);

        // Check if it is a Status probe from WakeProxyService
        try {
          const hs = parseHandshake(data);
          if (hs && hs.nextState === 1) {
            const resp = createStatusResponsePacket({
              versionName: 'Paper 1.20.4',
              protocolVersion: 765,
              motdText: 'Paper Online',
            });
            sock.write(resp);
            return;
          }
        } catch {}

        // If it's the forwarded player Login packet
        if (data.toString().includes('StevePlayer')) {
          const loginSuccess = createPacket(
            0x02,
            Buffer.concat([
              Buffer.alloc(16, 1),
              writeString('StevePlayer'),
              writeVarInt(0),
            ]),
          );
          sock.write(loginSuccess);
        }
      });
    });
    mockBackend.listen(backendPort, '127.0.0.1');
  };

  let startCalled = false;
  const mockRuntime: Partial<ServerRuntime> = {
    start: async () => {
      startCalled = true;
      serverRepo.setStatus(server.id, 'starting');
      setTimeout(() => {
        serverRepo.setStatus(server.id, 'running');
        startMockBackend();
      }, 300);
      return serverRepo.find(server.id)!;
    },
  };

  const service = new WakeProxyService(
    serverRepo,
    settingsRepo,
    tunnelRepo,
    mockPlayit as PlayitService,
    mockRuntime as ServerRuntime,
  );

  try {
    await service.reconcileAll();

    const client = net.connect({ host: '127.0.0.1', port: wakePort });
    let receivedLoginSuccess = false;

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        const hs = buildClientHandshakePacket(wakePort, 2);
        const loginStart = buildLoginStartPacket('StevePlayer');
        client.write(Buffer.concat([hs, loginStart]));
      });

      client.on('data', (chunk) => {
        if (chunk.toString().includes('StevePlayer')) {
          receivedLoginSuccess = true;
          resolve();
        }
      });

      client.on('error', reject);
    });

    client.destroy();

    assert.equal(startCalled, true, 'Server start was triggered by Login packet');
    assert.equal(receivedLoginSuccess, true, 'Client received login success from forwarded backend connection');
    assert.ok(
      backendReceivedPackets.some((p) => p.toString().includes('StevePlayer')),
      'Backend received the initial buffered Login Start packet from client',
    );
  } finally {
    service.stop();
    if (mockBackend) {
      (mockBackend as net.Server).close();
    }
    db.close();
  }
});

test('WakeProxyService handles concurrent client connections during boot and starts server only once', async () => {
  const db = openDatabase(':memory:');
  const serverRepo = new ServerRepository(db);
  const settingsRepo = new ServerSettingsRepository(db);
  const tunnelRepo = new ServerTunnelRepository(db);

  const backendPort = await getFreePort();
  const wakePort = await getFreePort();

  const server = serverRepo.create({
    id: 'wake-test-3',
    machineId: 'local',
    name: 'Multiplayer World',
    directory: 'multiplayer',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    port: backendPort,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);

  settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnelRepo.save({
    serverId: server.id,
    tunnelId: 'tun-test-3',
    localPort: wakePort,
    status: 'connected',
  });

  const mockPlayit: Partial<PlayitService> = {
    getStatus: async () => ({
      installed: true,
      isManaged: false,
      binaryPath: 'playit',
      version: '0.17.1',
      isRunning: true,
      secretExists: true,
      secretPath: 'playit.toml',
      claimUrl: null,
    }),
  };

  let mockBackend: net.Server | null = null;
  const connectedPlayers: string[] = [];

  const startMockBackend = () => {
    mockBackend = net.createServer((sock) => {
      sock.on('data', (data) => {
        try {
          const hs = parseHandshake(data);
          if (hs && hs.nextState === 1) {
            const resp = createStatusResponsePacket({
              versionName: 'Paper 1.20.4',
              protocolVersion: 765,
              motdText: 'Paper Online',
            });
            sock.write(resp);
            return;
          }
        } catch {}

        for (const name of ['PlayerOne', 'PlayerTwo', 'PlayerThree']) {
          if (data.toString().includes(name)) {
            connectedPlayers.push(name);
            sock.write(createPacket(0x02, Buffer.concat([Buffer.alloc(16, 2), writeString(name), writeVarInt(0)])));
          }
        }
      });
    });
    mockBackend.listen(backendPort, '127.0.0.1');
  };

  let runtimeStartCount = 0;
  const mockRuntime: Partial<ServerRuntime> = {
    start: async () => {
      runtimeStartCount++;
      serverRepo.setStatus(server.id, 'starting');
      setTimeout(() => {
        serverRepo.setStatus(server.id, 'running');
        startMockBackend();
      }, 400);
      return serverRepo.find(server.id)!;
    },
  };

  const service = new WakeProxyService(
    serverRepo,
    settingsRepo,
    tunnelRepo,
    mockPlayit as PlayitService,
    mockRuntime as ServerRuntime,
  );

  try {
    await service.reconcileAll();

    // Connect 3 clients concurrently while server is stopped
    const playerNames = ['PlayerOne', 'PlayerTwo', 'PlayerThree'];
    const clients: net.Socket[] = [];
    const clientSuccessPromises = playerNames.map((name) => {
      return new Promise<void>((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: wakePort });
        clients.push(client);

        client.on('connect', () => {
          const hs = buildClientHandshakePacket(wakePort, 2);
          const login = buildLoginStartPacket(name);
          client.write(Buffer.concat([hs, login]));
        });

        client.on('data', (data) => {
          if (data.toString().includes(name)) {
            resolve();
          }
        });

        client.on('error', reject);
      });
    });

    await Promise.all(clientSuccessPromises);

    for (const c of clients) c.destroy();

    assert.equal(runtimeStartCount, 1, 'Runtime start was called exactly ONCE despite 3 concurrent connections');
    assert.equal(connectedPlayers.length, 3, 'All 3 concurrent clients were cleanly forwarded to the backend');
  } finally {
    service.stop();
    if (mockBackend) {
      (mockBackend as net.Server).close();
    }
    db.close();
  }
});

test('WakeProxyService forwards connection immediately when server is already running', async () => {
  const db = openDatabase(':memory:');
  const serverRepo = new ServerRepository(db);
  const settingsRepo = new ServerSettingsRepository(db);
  const tunnelRepo = new ServerTunnelRepository(db);

  const backendPort = await getFreePort();
  const wakePort = await getFreePort();

  const server = serverRepo.create({
    id: 'wake-test-online',
    machineId: 'local',
    name: 'Running World',
    directory: 'running-world',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    port: backendPort,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);
  serverRepo.setStatus(server.id, 'running');

  settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnelRepo.save({
    serverId: server.id,
    tunnelId: 'tun-test-online',
    localPort: wakePort,
    status: 'connected',
  });

  const mockPlayit: Partial<PlayitService> = {
    getStatus: async () => ({
      installed: true,
      isManaged: false,
      binaryPath: 'playit',
      version: '0.17.1',
      isRunning: true,
      secretExists: true,
      secretPath: 'playit.toml',
      claimUrl: null,
    }),
  };

  let mockBackend: net.Server | null = null;
  let receivedAtBackend = false;

  const startMockBackend = () => {
    mockBackend = net.createServer((sock) => {
      sock.on('data', (data) => {
        const handshake = parseHandshake(data);
        if (handshake?.nextState === 1) {
          sock.write(createStatusResponsePacket({ motdText: 'Ready backend', protocolVersion: 765 }));
          return;
        }
        if (data.toString().includes('ImmediatePlayer')) {
          receivedAtBackend = true;
          sock.write(Buffer.from('WelcomeOnline'));
        }
      });
    });
    mockBackend.listen(backendPort, '127.0.0.1');
  };
  startMockBackend();

  const service = new WakeProxyService(
    serverRepo,
    settingsRepo,
    tunnelRepo,
    mockPlayit as PlayitService,
    {} as ServerRuntime,
  );

  try {
    await service.reconcileAll();

    const client = net.connect({ host: '127.0.0.1', port: wakePort });
    let receivedReply = false;

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(Buffer.concat([buildClientHandshakePacket(wakePort, 2), buildLoginStartPacket('ImmediatePlayer')]));
      });

      client.on('data', (data) => {
        if (data.toString().includes('WelcomeOnline')) {
          receivedReply = true;
          resolve();
        }
      });

      client.on('error', reject);
    });

    client.destroy();

    assert.equal(receivedAtBackend, true, 'Backend received client packet immediately');
    assert.equal(receivedReply, true, 'Client received backend reply through proxy');
    // Once readiness is established, forwarding remains an opaque byte stream.
    const opaque = net.connect({ host: '127.0.0.1', port: wakePort });
    const echoed = receiveUntil(opaque, bytes => bytes.toString().includes('WelcomeOnline'));
    opaque.once('connect', () => opaque.write(Buffer.from('Hello ImmediatePlayer')));
    try { await echoed; } finally { opaque.destroy(); }
  } finally {
    service.stop();
    if (mockBackend) {
      (mockBackend as net.Server).close();
    }
    db.close();
  }
});

type ProxyTestOptions = { playerWaitMs?: number; startupTimeoutMs?: number; inspectionTimeoutMs?: number };

async function progressFixture(t: TestContext, options: ProxyTestOptions = {}, java?: Partial<JavaService>) {
  const db = openDatabase(':memory:');
  const servers = new ServerRepository(db);
  const settings = new ServerSettingsRepository(db);
  const tunnels = new ServerTunnelRepository(db);
  const port = await getFreePort(), wakePort = await getFreePort();
  const server = servers.create({ id: 'progress-fixture', machineId: 'local', name: 'Progress fixture', directory: 'progress-fixture', software: 'paper',
    version: '1.20.4', port, memoryMb: 1024, eulaAccepted: true });
  servers.markReady(server.id);
  settings.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnels.save({ serverId: server.id, tunnelId: 'fixture', localPort: wakePort, status: 'connected' });
  const logs: ConsoleLine[] = [];
  const startedAt = new Date().toISOString();
  let starts = 0, active = false, runtimeId = 'fixture-run', onStart: (() => Promise<void> | void) | undefined;
  const runtime: Partial<ServerRuntime> = {
    start: async () => { starts++; active = true; servers.setStatus(server.id, 'running'); await onStart?.(); return servers.require(server.id); },
    isProcessActive: () => active,
    getProcessInfo: () => active ? { pid: 12345, runtimeId, startedAt } : undefined,
    getLogs: () => logs,
  };
  const playit: Partial<PlayitService> = { getStatus: async () => ({ installed: true, isManaged: false, binaryPath: 'fixture', version: 'fixture', isRunning: true, secretExists: true, secretPath: null, claimUrl: null }) };
  const service = new WakeProxyService(servers, settings, tunnels, playit as PlayitService, runtime as ServerRuntime, java as JavaService | undefined,
    { playerWaitMs: 80, startupTimeoutMs: 3_000, inspectionTimeoutMs: 80, ...options });
  const clients = new Set<net.Socket>(), backendSockets = new Set<net.Socket>();
  let backend: net.Server | undefined;
  t.after(async () => {
    service.stop();
    for (const socket of clients) socket.destroy();
    for (const socket of backendSockets) socket.destroy();
    if (backend?.listening) await new Promise<void>(resolve => backend!.close(() => resolve()));
    db.close();
  });
  const client = () => { const socket = net.connect({ host: '127.0.0.1', port: wakePort }); clients.add(socket); socket.on('error', () => {}); return socket; };
  const addLog = (message: string) => logs.push({ timestamp: new Date().toISOString(), stream: 'stdout', message });
  const markActive = (status: 'running' | 'starting') => { active = true; servers.setStatus(server.id, status); };
  const startBackend = async (options: { statusResponse?: boolean; onStatus?: (socket: net.Socket) => void } = {}) => {
    backend = net.createServer(socket => {
      backendSockets.add(socket); socket.on('close', () => backendSockets.delete(socket)); socket.on('error', () => {});
      let received = Buffer.alloc(0);
      socket.on('data', data => {
        received = Buffer.concat([received, data]);
        const handshake = parseHandshake(received);
        if (handshake?.nextState === 1) {
          if (options.onStatus) options.onStatus(socket);
          else if (options.statusResponse !== false) socket.write(createStatusResponsePacket({ motdText: 'Real backend ready', protocolVersion: 765, onlinePlayers: 2, maxPlayers: 20 }));
        }
        else if (received.toString().includes('ForwardPlayer')) socket.write(Buffer.from('ForwardedPlayerData'));
      });
    });
    await new Promise<void>(resolve => backend!.listen(port, '127.0.0.1', resolve));
  };
  await service.reconcileAll();
  return { db, servers, settings, server, service, client, addLog, markActive, startBackend, wakePort, logs,
    replaceRuntime: () => { runtimeId += '-replacement'; },
    get starts() { return starts; }, set onStart(value: () => Promise<void> | void) { onStart = value; } };
}

async function receiveUntil(socket: net.Socket, predicate: (bytes: Buffer) => boolean, timeoutMs = 2_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timeout); socket.removeListener('data', onData); socket.removeListener('error', onError); socket.removeListener('end', onEnd); };
    const onData = (data: Buffer) => { buffer = Buffer.concat([buffer, data]); if (predicate(buffer)) { cleanup(); resolve(buffer); } };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('Connection ended before the expected packet: ' + buffer.toString())); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for proxy packet')); }, timeoutMs);
    socket.on('data', onData); socket.once('error', onError); socket.once('end', onEnd);
  });
}

function frames(bytes: Buffer): Array<{ id: number; data: Buffer }> {
  const result: Array<{ id: number; data: Buffer }> = [];
  while (bytes.length) {
    const length = readVarInt(bytes); if (!length || bytes.length < length.bytesRead + length.value) break;
    const frame = bytes.subarray(length.bytesRead, length.bytesRead + length.value), id = readVarInt(frame)!;
    result.push({ id: id.value, data: frame.subarray(id.bytesRead) }); bytes = bytes.subarray(length.bytesRead + length.value);
  }
  return result;
}

function sendLogin(socket: net.Socket, port: number, username = 'WaitingPlayer') {
  socket.once('connect', () => socket.write(Buffer.concat([buildClientHandshakePacket(port, 2), buildLoginStartPacket(username)])));
}

test('running-but-unready Minecraft shows a short startup notice with real stage percentage and one shared wake', async t => {
  const f = await progressFixture(t);
  f.onStart = () => { f.addLog('[Server thread/INFO]: Preparing spawn area: 42%'); };
  const first = f.client(), second = f.client();
  const messages = [first, second].map(socket => receiveUntil(socket, bytes => frames(bytes).length > 0));
  sendLogin(first, f.wakePort); sendLogin(second, f.wakePort);
  for (const bytes of await Promise.all(messages)) {
    const packet = frames(bytes)[0]; assert.equal(packet.id, 0);
    const message = JSON.parse(readString(packet.data)!.value).text;
    assert.match(message, /Starting server/); assert.match(message, /42% of this stage/); assert.match(message, /Refresh the server list/);
    assert.doesNotMatch(message, /10s remaining/);
  }
  assert.equal(f.starts, 1);
  assert.equal(f.servers.require(f.server.id).status, 'running', 'Process spawn alone is not Minecraft readiness.');
  const status = await f.service.getStatus(f.server.id);
  assert.equal(status.starting, true); assert.equal(status.startup?.percent, 42);
});

test('starting-server status responds to coalesced and fragmented request/ping with current progress without waking', async t => {
  const f = await progressFixture(t, { inspectionTimeoutMs: 1_000 });
  f.markActive('starting'); f.addLog('[Server thread/INFO]: Preparing spawn area: 42%');
  const timestamp = Buffer.alloc(8); timestamp.writeBigInt64BE(123456789n);
  async function ping(fragmented: boolean) {
    const socket = f.client(), result = receiveUntil(socket, bytes => frames(bytes).length === 2);
    const request = Buffer.concat([buildClientHandshakePacket(f.wakePort, 1), createPacket(0), createPacket(1, timestamp)]);
    socket.once('connect', () => {
      if (!fragmented) socket.write(request);
      else void (async () => { for (let offset = 0; offset < request.length; offset += 3) { socket.write(request.subarray(offset, offset + 3)); await delay(2); } })();
    });
    const packets = frames(await result); socket.destroy();
    assert.equal(packets[0].id, 0); assert.equal(packets[1].id, 1); assert.deepEqual(packets[1].data, timestamp);
    return JSON.parse(readString(packets[0].data)!.value);
  }
  assert.match((await ping(false)).description.text, /Starting server.*42%/);
  f.addLog('[Server thread/INFO]: Preparing spawn area: 71%');
  assert.match((await ping(true)).description.text, /Starting server.*71%/);
  assert.equal(f.starts, 0, 'Multiplayer-list polling never wakes Minecraft.');
});

test('a manually starting process gains readiness forwarding without a duplicate start', async t => {
  const f = await progressFixture(t, { playerWaitMs: 1_500 });
  f.markActive('starting');
  const socket = f.client(), reply = receiveUntil(socket, bytes => bytes.toString().includes('ForwardedPlayerData'));
  sendLogin(socket, f.wakePort, 'ForwardPlayer');
  await delay(100); await f.startBackend();
  assert.match((await reply).toString(), /ForwardedPlayerData/); assert.equal(f.starts, 0);
  const status = await f.service.getStatus(f.server.id); assert.equal(status.starting, false);
});

test('stopping the wake proxy while Java discovery is pending never starts Minecraft afterwards', async t => {
  let release!: (value: null) => void, entered!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const java: Partial<JavaService> = { findUsable: async () => { entered(); return new Promise<null>(resolve => { release = resolve; }); } };
  const f = await progressFixture(t, { playerWaitMs: 1_000 }, java);
  const socket = f.client(), reply = receiveUntil(socket, bytes => frames(bytes).length > 0);
  sendLogin(socket, f.wakePort); await called; f.service.stop(); release(null);
  assert.match(JSON.parse(readString(frames(await reply)[0].data)!.value).text, /shutting down/);
  await delay(30); assert.equal(f.starts, 0);
});

test('disabling Auto-Wake while Java discovery is pending prevents the delayed game start', async t => {
  let release!: (value: null) => void, entered!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const java: Partial<JavaService> = { findUsable: async () => { entered(); return new Promise<null>(resolve => { release = resolve; }); } };
  const f = await progressFixture(t, { playerWaitMs: 1_000 }, java);
  const socket = f.client(); sendLogin(socket, f.wakePort); await called;
  f.settings.update(f.server.id, { autoWake: false });
  await f.service.reconcileAll(); release(null);
  await delay(30);
  assert.equal(f.starts, 0);
  assert.equal((await f.service.getStatus(f.server.id)).status, 'disabled');
});

test('a stale status response cannot mark a different runtime ID ready on the same port and version', async t => {
  const f = await progressFixture(t); f.markActive('running');
  let entered!: (socket: net.Socket) => void;
  const probing = new Promise<net.Socket>(resolve => { entered = resolve; });
  await f.startBackend({ onStatus: socket => entered(socket) });
  const result = f.service.getStatus(f.server.id);
  const oldProcessSocket = await probing;
  f.replaceRuntime();
  oldProcessSocket.write(createStatusResponsePacket({ motdText: 'Old runtime ready', protocolVersion: 765 }));
  assert.equal((await result).starting, true, 'Only a fresh probe of the replacement process can confirm readiness.');
});

test('concurrent reconciliation retains one owned listener and closes it when Auto-Wake is disabled', async t => {
  const f = await progressFixture(t);
  // Force simultaneous fresh binds, rather than merely checking an existing listener.
  f.settings.update(f.server.id, { autoWake: false }); await f.service.reconcileAll();
  f.settings.update(f.server.id, { autoWake: true });
  await Promise.all(Array.from({ length: 12 }, () => f.service.reconcileAll()));
  assert.equal((await f.service.getStatus(f.server.id)).status, 'active');
  const socket = f.client(), response = receiveUntil(socket, bytes => frames(bytes).length > 0);
  socket.once('connect', () => socket.write(Buffer.concat([buildClientHandshakePacket(f.wakePort, 1), createPacket(0)])));
  assert.match(JSON.parse(readString(frames(await response)[0].data)!.value).description.text, /sleeping/);
  socket.destroy(); f.settings.update(f.server.id, { autoWake: false }); await f.service.reconcileAll();
  await new Promise<void>((resolve, reject) => {
    const check = net.createServer(); check.once('error', reject); check.listen(f.wakePort, '127.0.0.1', () => check.close(error => error ? reject(error) : resolve()));
  });
});

test('raw, malformed, silent, oversized and invalid-state handshakes never wake Minecraft', async t => {
  const f = await progressFixture(t);
  const badFrame = Buffer.concat([writeVarInt(1), Buffer.from([0]), Buffer.from('trailing bytes cannot finish a handshake')]);
  const inputs = [Buffer.from('GET / HTTP/1.1\r\n'), Buffer.from([0x80,0x80,0x80,0x80,0x80,0x80]), badFrame,
    buildClientHandshakePacket(f.wakePort, 99), writeVarInt(200_000), Buffer.alloc(140_000), Buffer.alloc(0)];
  await Promise.all(inputs.map(async bytes => {
    const socket = f.client();
    const closed = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Invalid client did not close')), 1_500); socket.once('close', () => { clearTimeout(timeout); resolve(); }); });
    socket.once('connect', () => { if (bytes.length) socket.write(bytes); }); await closed;
  }));
  assert.equal(f.starts, 0);
  const socket = f.client(), reply = receiveUntil(socket, bytes => frames(bytes).length > 0);
  socket.once('connect', () => socket.write(Buffer.concat([buildClientHandshakePacket(f.wakePort, 1), createPacket(0)])));
  assert.match(JSON.parse(readString(frames(await reply)[0].data)!.value).description.text, /sleeping/);
});

test('queued login bytes are bounded while Minecraft remains unready', async t => {
  const f = await progressFixture(t, { playerWaitMs: 2_000 });
  const socket = f.client();
  const closed = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Oversized queued login did not close')), 1_500); socket.once('close', () => { clearTimeout(timeout); resolve(); }); });
  socket.once('connect', () => {
    socket.write(Buffer.concat([buildClientHandshakePacket(f.wakePort, 2), buildLoginStartPacket('TooMuchData')]));
    void delay(25).then(() => { if (!socket.destroyed) socket.write(Buffer.alloc(140_000)); });
  });
  await closed; assert.equal(f.starts, 1);
  assert.equal((await f.service.getStatus(f.server.id)).starting, true, 'Rejected clients do not abort a healthy background start.');
});

test('unready servers bound simultaneous handshake inspections without waking on a connection flood', async t => {
  const f = await progressFixture(t, { inspectionTimeoutMs: 3_000 });
  const sockets = Array.from({ length: 65 }, () => f.client());
  const firstClosed = Promise.any(sockets.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([firstClosed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Unready connection limit did not reject excess sockets')), 1_500); })]);
    assert.equal(f.starts, 0);
  } finally { clearTimeout(timeout); for (const socket of sockets) socket.destroy(); }
});

test('a ready backend relays its real MOTD and player counts after readiness confirmation', async t => {
  const f = await progressFixture(t); f.markActive('running'); await f.startBackend();
  const socket = f.client(), result = receiveUntil(socket, bytes => frames(bytes).length > 0);
  socket.once('connect', () => socket.write(Buffer.concat([buildClientHandshakePacket(f.wakePort, 1), createPacket(0)])));
  const status = JSON.parse(readString(frames(await result)[0].data)!.value);
  assert.equal(status.description.text, 'Real backend ready');
  assert.equal(status.players.online, 2); assert.equal(status.players.max, 20);
  assert.equal(f.starts, 0);
  assert.equal((await f.service.getStatus(f.server.id)).starting, false);
});

test('status-disabled servers require a current-launch Done line plus TCP before forwarding joins', async t => {
  const f = await progressFixture(t, { playerWaitMs: 2_500 }); f.markActive('running');
  await f.startBackend({ statusResponse: false });
  f.logs.push({ timestamp: '2000-01-01T00:00:00.000Z', stream: 'stdout', message: '[Server thread/INFO]: Done (1.0s)! For help, type "help"' });
  assert.equal((await f.service.getStatus(f.server.id)).starting, true, 'An accepting socket and stale Done do not establish readiness.');
  f.addLog('[Server thread/INFO]: Done (1.0s)! For help, type "help"');
  const socket = f.client(), forwarded = receiveUntil(socket, bytes => bytes.toString().includes('ForwardedPlayerData'), 3_000);
  sendLogin(socket, f.wakePort, 'ForwardPlayer');
  await forwarded; assert.equal(f.starts, 0);
  assert.equal((await f.service.getStatus(f.server.id)).starting, false);
});

test('status-disabled readiness fallback displays ready without inventing player counts', async t => {
  const f = await progressFixture(t); f.markActive('running'); await f.startBackend({ statusResponse: false });
  f.addLog('[Server thread/INFO]: Done (2.5s)! For help, type "help"');
  const socket = f.client(), response = receiveUntil(socket, bytes => frames(bytes).length > 0);
  socket.once('connect', () => socket.write(Buffer.concat([buildClientHandshakePacket(f.wakePort, 1), createPacket(0)])));
  const status = JSON.parse(readString(frames(await response)[0].data)!.value);
  assert.match(status.description.text, /Server is ready/); assert.equal(status.players, undefined);
  assert.equal(f.starts, 0);
});

test('WakeProxyService sends clean disconnect packet on startup failure without connection reset', async () => {
  const db = openDatabase(':memory:');
  const serverRepo = new ServerRepository(db);
  const settingsRepo = new ServerSettingsRepository(db);
  const tunnelRepo = new ServerTunnelRepository(db);

  const backendPort = await getFreePort();
  const wakePort = await getFreePort();

  const server = serverRepo.create({
    id: 'wake-test-4',
    machineId: 'local',
    name: 'Failing Server',
    directory: 'failing',
    flavor: 'paper',
    software: 'paper',
    version: '1.20.4',
    port: backendPort,
    memoryMb: 2048,
    eulaAccepted: true,
  });
  serverRepo.markReady(server.id);

  settingsRepo.update(server.id, { autoWake: true, wakeProxyPort: wakePort });
  tunnelRepo.save({
    serverId: server.id,
    tunnelId: 'tun-test-4',
    localPort: wakePort,
    status: 'connected',
  });

  const mockPlayit: Partial<PlayitService> = {
    getStatus: async () => ({
      installed: true,
      isManaged: false,
      binaryPath: 'playit',
      version: '0.17.1',
      isRunning: true,
      secretExists: true,
      secretPath: 'playit.toml',
      claimUrl: null,
    }),
  };

  const mockRuntime: Partial<ServerRuntime> = {
    start: async () => {
      throw new Error('JVM out of memory');
    },
  };

  const service = new WakeProxyService(
    serverRepo,
    settingsRepo,
    tunnelRepo,
    mockPlayit as PlayitService,
    mockRuntime as ServerRuntime,
  );

  try {
    await service.reconcileAll();

    const client = net.connect({ host: '127.0.0.1', port: wakePort });
    let receivedDisconnect = false;
    let disconnectMessage = '';

    await new Promise<void>((resolve) => {
      client.on('connect', () => {
        const hs = buildClientHandshakePacket(wakePort, 2);
        const login = buildLoginStartPacket('PlayerCrash');
        client.write(Buffer.concat([hs, login]));
      });

      client.on('data', (data) => {
        try {
          const packetLen = readVarInt(data, 0);
          if (packetLen) {
            const pid = readVarInt(data, packetLen.bytesRead);
            if (pid && pid.value === 0x00) {
              const msg = readString(data, packetLen.bytesRead + pid.bytesRead);
              if (msg) {
                receivedDisconnect = true;
                disconnectMessage = msg.value;
                resolve();
              }
            }
          }
        } catch {}
      });

      client.on('close', () => {
        resolve();
      });

      client.on('error', () => {
        resolve();
      });
    });

    client.destroy();

    assert.equal(receivedDisconnect, true, 'Client received a clean disconnect packet');
    assert.ok(disconnectMessage.includes('JVM out of memory'), 'Disconnect packet contains failure reason');
  } finally {
    service.stop();
    db.close();
  }
});
