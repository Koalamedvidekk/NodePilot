import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  writeVarInt,
  readVarInt,
  writeString,
  readString,
  createPacket,
  parseHandshake,
  createStatusResponsePacket,
  createLoginDisconnectPacket,
  probeMinecraftServer,
} from '../lib/minecraft-protocol.js';

test('VarInt encoding and decoding handles edge cases', () => {
  const testValues = [0, 1, 127, 128, 255, 25565, 35565, 2097151];
  for (const val of testValues) {
    const encoded = writeVarInt(val);
    const decoded = readVarInt(encoded, 0);
    assert.ok(decoded);
    assert.equal(decoded.value, val);
    assert.equal(decoded.bytesRead, encoded.length);
  }
});

test('String encoding and decoding handles UTF-8', () => {
  const testStr = 'play.example.com';
  const encoded = writeString(testStr);
  const decoded = readString(encoded, 0);
  assert.ok(decoded);
  assert.equal(decoded.value, testStr);
});

test('parseHandshake correctly extracts handshake details for Status and Login', () => {
  // Construct Handshake for Status (nextState = 1)
  const hsDataStatus = Buffer.concat([
    writeVarInt(765), // protocol version
    writeString('play.nodepilot.test'),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(25565);
      return b;
    })(),
    writeVarInt(1), // nextState = 1 (Status)
  ]);
  const packetStatus = createPacket(0x00, hsDataStatus);
  const parsedStatus = parseHandshake(packetStatus);

  assert.ok(parsedStatus);
  assert.equal(parsedStatus.protocolVersion, 765);
  assert.equal(parsedStatus.serverAddress, 'play.nodepilot.test');
  assert.equal(parsedStatus.serverPort, 25565);
  assert.equal(parsedStatus.nextState, 1);

  // Construct Handshake for Login (nextState = 2)
  const hsDataLogin = Buffer.concat([
    writeVarInt(765),
    writeString('localhost'),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(35565);
      return b;
    })(),
    writeVarInt(2), // nextState = 2 (Login)
  ]);
  const packetLogin = createPacket(0x00, hsDataLogin);
  const parsedLogin = parseHandshake(packetLogin);

  assert.ok(parsedLogin);
  assert.equal(parsedLogin.protocolVersion, 765);
  assert.equal(parsedLogin.serverAddress, 'localhost');
  assert.equal(parsedLogin.serverPort, 35565);
  assert.equal(parsedLogin.nextState, 2);
});

test('createLoginDisconnectPacket encodes valid Minecraft disconnect message', () => {
  const disconnect = createLoginDisconnectPacket('Server is waking up!');
  assert.ok(disconnect.length > 0);
  const packetLen = readVarInt(disconnect, 0);
  assert.ok(packetLen);
  const packetId = readVarInt(disconnect, packetLen.bytesRead);
  assert.ok(packetId);
  assert.equal(packetId.value, 0x00);
  const jsonStr = readString(disconnect, packetLen.bytesRead + packetId.bytesRead);
  assert.ok(jsonStr);
  const parsed = JSON.parse(jsonStr.value);
  assert.equal(parsed.text, 'Server is waking up!');
});

test('probeMinecraftServer correctly detects active Minecraft server and handles offline server', async () => {
  // Test offline port first
  const offlineProbe = await probeMinecraftServer('127.0.0.1', 49152, 200);
  assert.equal(offlineProbe.ready, false);

  // Start a mock Minecraft TCP server that responds to status request
  const mockServer = net.createServer((socket) => {
    let incoming = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      const hs = parseHandshake(incoming);
      if (hs && hs.nextState === 1) {
        // Send status response packet
        const responsePacket = createStatusResponsePacket({
          motdText: 'Mock Server Online',
          protocolVersion: 765,
          maxPlayers: 20,
          onlinePlayers: 3,
        });
        socket.write(responsePacket);
      }
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = (mockServer.address() as net.AddressInfo).port;

  try {
    const probe = await probeMinecraftServer('127.0.0.1', port, 1000);
    assert.equal(probe.ready, true);
    assert.ok(probe.statusJson);
    const json = probe.statusJson as any;
    assert.equal(json.description.text, 'Mock Server Online');
    assert.equal(json.players.online, 3);
  } finally {
    mockServer.close();
  }
});
