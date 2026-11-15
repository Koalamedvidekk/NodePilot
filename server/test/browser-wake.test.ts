import assert from 'node:assert/strict';
import net from 'node:net';
import test, { type TestContext } from 'node:test';

import { openDatabase } from '../db.js';
import { GameConnectionResolver } from '../lib/game-connections.js';
import { createPacket, createStatusResponsePacket, parseHandshake, writeString, writeVarInt } from '../lib/minecraft-protocol.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { ServerSettingsRepository } from '../repositories/server-settings-repository.js';
import { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import type { PlayitService } from '../services/playit-service.js';
import type { ServerRuntime } from '../services/server-runtime.js';
import { WakeProxyService } from '../services/wake-proxy-service.js';

async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    ports.add((listener.address() as net.AddressInfo).port);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  return [...ports];
}

function handshake(port: number, nextState: number): Buffer {
  const encodedPort = Buffer.alloc(2);
  encodedPort.writeUInt16BE(port);
  return createPacket(0, Buffer.concat([writeVarInt(765), writeString('localhost'), encodedPort, writeVarInt(nextState)]));
}

async function receive(socket: net.Socket, marker: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Timed out waiting for browser wake response')); }, 3_000);
    const cleanup = () => { clearTimeout(timeout); socket.removeListener('data', onData); socket.removeListener('error', onError); };
    const onData = (bytes: Buffer) => {
      received = Buffer.concat([received, bytes]);
      if (received.includes(marker)) { cleanup(); resolve(received); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function fixture(t: TestContext, autoWake: boolean) {
  const database = openDatabase(':memory:');
  const servers = new ServerRepository(database);
  const settings = new ServerSettingsRepository(database);
  const tunnels = new ServerTunnelRepository(database);
  const [publicPort, backendPort, privateWakePort, publicWakePort] = await freePorts(4);
  const server = servers.create({ id: 'browser-wake-fixture', machineId: 'local', name: 'Browser wake fixture',
    directory: 'browser-wake-fixture', software: 'paper', version: '1.21.4', port: publicPort, memoryMb: 1024, eulaAccepted: true });
  servers.markReady(server.id);
  settings.update(server.id, { autoWake, wakeProxyPort: publicWakePort });
  let enabled = true;
  let starts = 0;
  let onStart: (() => Promise<void>) | undefined;
  const sockets = new Set<net.Socket>();
  const listeners: net.Server[] = [];
  const runtime: Partial<ServerRuntime> = {
    start: async () => {
      starts += 1;
      servers.setStatus(server.id, 'running');
      await onStart?.();
      return servers.require(server.id);
    },
    isProcessActive: () => ['running', 'starting'].includes(servers.require(server.id).status),
    getLogs: () => [],
  };
  const playit: Partial<PlayitService> = { getStatus: async () => ({ installed: false, isManaged: false,
    binaryPath: null, version: null, isRunning: false, secretExists: false, secretPath: null, claimUrl: null }) };
  const connections = new GameConnectionResolver(() => enabled ? { backendPort, wakePort: privateWakePort } : null);
  const service = new WakeProxyService(servers, settings, tunnels, playit as PlayitService, runtime as ServerRuntime, undefined,
    { connections, browserEnabled: () => enabled, playerWaitMs: 1_000, startupTimeoutMs: 2_000 });
  t.after(async () => {
    service.stop();
    for (const socket of sockets) socket.destroy();
    for (const listener of listeners) if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    database.close();
  });
  const listen = async (port: number, accept: (socket: net.Socket) => void) => {
    const listener = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      accept(socket);
    });
    listeners.push(listener);
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', resolve);
    });
  };
  const startBackend = () => listen(backendPort, (socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      const request = parseHandshake(buffered);
      if (request?.nextState === 1) socket.write(createStatusResponsePacket({ motdText: 'Private browser backend', protocolVersion: 765, onlinePlayers: 3, maxPlayers: 20 }));
      else if (buffered.includes('BrowserPlayer')) socket.write(Buffer.from('PrivateLoginForwarded'));
    });
  });
  const client = async () => {
    const socket = net.connect({ host: '127.0.0.1', port: privateWakePort });
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return socket;
  };
  return { server, servers, settings, service, listen, startBackend, client, publicPort, backendPort, privateWakePort,
    disable: () => { enabled = false; },
    get starts() { return starts; },
    set onStart(handler: () => Promise<void>) { onStart = handler; } };
}

test('browser private wake listener works without Playit and does not start a stopped server when Auto-Wake is disabled', async (t) => {
  const fixtureState = await fixture(t, false);
  const { service, server, client, privateWakePort, backendPort } = fixtureState;
  await service.reconcileAll();
  const status = await service.getStatus(server.id);
  assert.equal(status.status, 'active');
  assert.equal(status.playitInstalled, false);
  assert.equal(status.wakePort, privateWakePort);
  assert.equal(status.minecraftPort, backendPort);
  const listener = (service as unknown as { listeners: Map<string, net.Server> }).listeners.get(server.id)!;
  assert.equal((listener.address() as net.AddressInfo).address, '127.0.0.1');
  const login = await client();
  const response = receive(login, 'Auto-Wake is disabled');
  login.write(Buffer.concat([handshake(privateWakePort, 2), createPacket(0, writeString('BrowserPlayer'))]));
  await response;
  assert.equal(fixtureState.starts, 0);
  const ping = await client();
  const statusResponse = receive(ping, 'Ask the owner to start it');
  ping.write(Buffer.concat([handshake(privateWakePort, 1), createPacket(0)]));
  await statusResponse;
  assert.equal(fixtureState.starts, 0);
});

test('browser readiness and joined-player traffic use the private backend, bypassing the public Velocity port', async (t) => {
  const fixtureState = await fixture(t, false);
  const { service, server, servers, startBackend, listen, publicPort, backendPort, privateWakePort, client } = fixtureState;
  let publicConnections = 0;
  await listen(publicPort, (socket) => { publicConnections += 1; socket.destroy(); });
  await startBackend();
  servers.setStatus(server.id, 'running');
  await service.reconcileAll();
  const status = await service.getStatus(server.id);
  assert.equal(status.minecraftPort, backendPort);
  const login = await client();
  const response = receive(login, 'PrivateLoginForwarded');
  login.write(Buffer.concat([handshake(privateWakePort, 2), createPacket(0, writeString('BrowserPlayer'))]));
  await response;
  assert.equal(publicConnections, 0);
  assert.equal(fixtureState.starts, 0);
});

test('browser Auto-Wake launches and forwards through the private backend without a Playit account', async (t) => {
  const fixtureState = await fixture(t, true);
  fixtureState.onStart = fixtureState.startBackend;
  await fixtureState.service.reconcileAll();
  const login = await fixtureState.client();
  const response = receive(login, 'PrivateLoginForwarded');
  login.write(Buffer.concat([handshake(fixtureState.privateWakePort, 2), createPacket(0, writeString('BrowserPlayer'))]));
  await response;
  assert.equal(fixtureState.starts, 1);
  assert.equal(fixtureState.servers.require(fixtureState.server.id).status, 'running');
  fixtureState.disable();
  await fixtureState.service.reconcileAll();
  const status = await fixtureState.service.getStatus(fixtureState.server.id);
  assert.equal(status.status, 'unsupported');
});
