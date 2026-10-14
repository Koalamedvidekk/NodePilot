import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db.js';
import { ServerRepository, type CreateServerRow } from '../repositories/server-repository.js';
import { ServerTunnelRepository } from '../repositories/server-tunnel-repository.js';
import { ServerTunnelService } from '../services/server-tunnel-service.js';
import type { PlayitService, ParsedPlayitTunnel } from '../services/playit-service.js';

function createMockServer(overrides: Partial<CreateServerRow> = {}): CreateServerRow {
  const id = overrides.id ?? 'test-srv-1';
  return {
    id,
    machineId: 'local',
    name: `Server ${id}`,
    software: 'paper',
    flavor: 'paper',
    version: '1.20.4',
    directory: `servers/${id}`,
    requiredJavaMajor: 17,
    port: 25565,
    memoryMb: 2048,
    eulaAccepted: true,
    ...overrides,
  };
}

test('ServerTunnelRepository handles lifecycle, lookups, and cascade deletion', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-tunnel-repo-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: ReturnType<typeof openDatabase> | undefined;

  try {
    db = openDatabase(dbPath);
    const serverRepo = new ServerRepository(db);
    const tunnelRepo = new ServerTunnelRepository(db);

    // Create prerequisite server
    const server = createMockServer({ id: 'srv-alpha', port: 25565 });
    serverRepo.create(server);

    // 1. Initial lookup is null
    assert.equal(tunnelRepo.find('srv-alpha'), null);

    // 2. Save new tunnel
    const initial = tunnelRepo.save({
      serverId: 'srv-alpha',
      localPort: 25565,
      status: 'connecting',
      lastError: 'Waiting for Playit tunnel allocation',
    });

    assert.equal(initial.serverId, 'srv-alpha');
    assert.equal(initial.localPort, 25565);
    assert.equal(initial.status, 'connecting');

    // 3. Lookup by server ID
    const found = tunnelRepo.find('srv-alpha');
    assert.ok(found);
    assert.equal(found.serverId, 'srv-alpha');
    assert.equal(found.localPort, 25565);

    // 4. Lookup by local port
    const foundByPort = tunnelRepo.findByLocalPort(25565);
    assert.ok(foundByPort);
    assert.equal(foundByPort.serverId, 'srv-alpha');

    // 5. Update tunnel details
    const updated = tunnelRepo.update('srv-alpha', {
      tunnelId: 'tun_abc123',
      tunnelName: 'survival-world',
      publicAddress: 'survival.joinmc.link',
      publicPort: 25565,
      connectionAddress: 'survival.joinmc.link',
      status: 'connected',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });

    assert.ok(updated);
    assert.equal(updated.status, 'connected');
    assert.equal(updated.publicAddress, 'survival.joinmc.link');
    assert.equal(updated.lastError, null);

    // 6. Delete tunnel directly
    tunnelRepo.delete('srv-alpha');
    assert.equal(tunnelRepo.find('srv-alpha'), null);

    // 7. Verify cascade deletion when parent server is deleted
    tunnelRepo.save({
      serverId: 'srv-alpha',
      localPort: 25565,
      status: 'connecting',
    });
    assert.ok(tunnelRepo.find('srv-alpha'));

    serverRepo.delete('srv-alpha');
    assert.equal(tunnelRepo.find('srv-alpha'), null);
  } finally {
    db?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ServerTunnelService reconciles tunnels for custom ports and multiple servers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-tunnel-service-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: ReturnType<typeof openDatabase> | undefined;

  try {
    db = openDatabase(dbPath);
    const serverRepo = new ServerRepository(db);
    const tunnelRepo = new ServerTunnelRepository(db);

    // Create two servers with different custom ports and distinct names/directories
    serverRepo.create(createMockServer({ id: 'srv-main', name: 'Main Server', directory: 'servers/main', port: 25565 }));
    serverRepo.create(createMockServer({ id: 'srv-minigames', name: 'Minigames Server', directory: 'servers/minigames', port: 25577 }));

    // Mock PlayitService returning mock tunnels
    const mockTunnels: ParsedPlayitTunnel[] = [
      {
        id: 'tun-main-99',
        name: 'Main Server',
        tunnelType: 'minecraft-java',
        localPort: 25565,
        publicAddress: 'cool-beans.gl.joinmc.link',
        publicPort: 25565,
        connectionAddress: 'cool-beans.gl.joinmc.link',
      },
    ];

    const mockPlayitService: Partial<PlayitService> = {
      getStatus: async () => ({
        installed: true,
        isManaged: true,
        binaryPath: '/path/to/playit',
        version: '0.15.26',
        isRunning: true,
        secretExists: true,
        secretPath: '/path/to/playit.toml',
        claimUrl: null,
      }),
      findTunnelForPort: async (port: number) => {
        return mockTunnels.find((t) => t.localPort === port) ?? null;
      },
    };

    const service = new ServerTunnelService(
      tunnelRepo,
      serverRepo,
      mockPlayitService as PlayitService
    );

    // 1. Reconcile srv-main (port 25565) -> should match tun-main-99 and connect
    const resultMain = await service.reconcile('srv-main', 25565);
    assert.equal(resultMain.tunnel.status, 'connected');
    assert.equal(resultMain.tunnel.publicAddress, 'cool-beans.gl.joinmc.link');
    assert.equal(resultMain.tunnel.connectionAddress, 'cool-beans.gl.joinmc.link');
    assert.equal(resultMain.tunnel.localPort, 25565);

    // 2. Reconcile srv-minigames (port 25577) -> no tunnel configured yet for 25577
    const resultMini = await service.reconcile('srv-minigames', 25577);
    assert.equal(resultMini.tunnel.status, 'connecting');
    assert.equal(resultMini.tunnel.localPort, 25577);
    assert.match(resultMini.tunnel.lastError ?? '', /25577/);

    // 3. Verify multiple servers maintain isolated tunnel mappings
    const srvMainTunnel = tunnelRepo.find('srv-main');
    const srvMiniTunnel = tunnelRepo.find('srv-minigames');
    assert.equal(srvMainTunnel?.localPort, 25565);
    assert.equal(srvMainTunnel?.status, 'connected');
    assert.equal(srvMiniTunnel?.localPort, 25577);
    assert.equal(srvMiniTunnel?.status, 'connecting');

    // 4. Simulate user adding the second tunnel on playit.gg for port 25577
    mockTunnels.push({
      id: 'tun-mini-100',
      name: 'Mini Games',
      tunnelType: 'minecraft-java',
      localPort: 25577,
      publicAddress: 'fun-arcade.gl.joinmc.link',
      publicPort: 43210,
      connectionAddress: 'fun-arcade.gl.joinmc.link',
    });

    // Verify srv-minigames again
    const verifyMini = await service.verify('srv-minigames');
    assert.equal(verifyMini.tunnel.status, 'connected');
    assert.equal(verifyMini.tunnel.publicAddress, 'fun-arcade.gl.joinmc.link');
    assert.equal(verifyMini.tunnel.publicPort, 43210);

    // 5. Test handling port change on srv-main from 25565 to 25588
    const portChangedResult = await service.handlePortChanged('srv-main', 25588);
    assert.ok(portChangedResult);
    assert.equal(portChangedResult.localPort, 25588);
    // Because no tunnel exists on port 25588, status changes to connecting and prompts user
    assert.equal(portChangedResult.status, 'connecting');
    assert.match(portChangedResult.lastError ?? '', /25588/);

    // 6. Test removing tunnel cleanly
    await service.remove('srv-main');
    assert.equal(tunnelRepo.find('srv-main'), null);
    // Server itself must still exist!
    assert.ok(serverRepo.find('srv-main'));
  } finally {
    db?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ServerTunnelService handles unlinked or uninstalled Playit gracefully', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nodepilot-tunnel-unlinked-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  let db: ReturnType<typeof openDatabase> | undefined;

  try {
    db = openDatabase(dbPath);
    const serverRepo = new ServerRepository(db);
    const tunnelRepo = new ServerTunnelRepository(db);

    serverRepo.create(createMockServer({ id: 'srv-unlinked', name: 'Unlinked Srv', directory: 'servers/unlinked', port: 25565 }));

    const unlinkedPlayitService: Partial<PlayitService> = {
      getStatus: async () => ({
        installed: false,
        isManaged: false,
        binaryPath: null,
        version: null,
        isRunning: false,
        secretExists: false,
        secretPath: null,
        claimUrl: null,
      }),
      fetchAccountTunnels: async () => [],
      findTunnelForPort: async () => null,
    };

    const service = new ServerTunnelService(
      tunnelRepo,
      serverRepo,
      unlinkedPlayitService as PlayitService
    );

    const result = await service.reconcile('srv-unlinked', 25565);
    assert.equal(result.tunnel.status, 'error');
    assert.match(result.tunnel.lastError ?? '', /not installed/i);
    // Minecraft server must not be deleted or corrupted
    assert.ok(serverRepo.find('srv-unlinked'));
  } finally {
    db?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
