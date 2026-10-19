import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDatabase } from '../db.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import { WakeProxyService } from '../services/wake-proxy-service.js';
import type { PlayitService } from '../services/playit-service.js';
import type { ServerRuntime } from '../services/server-runtime.js';
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
        client.write(Buffer.from('Hello ImmediatePlayer'));
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
  } finally {
    service.stop();
    if (mockBackend) {
      (mockBackend as net.Server).close();
    }
    db.close();
  }
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
