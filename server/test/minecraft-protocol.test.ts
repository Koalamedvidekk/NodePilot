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

test('handshake parsing respects frame boundaries, fragmentation and modern transfer intent', () => {
  const port = Buffer.alloc(2); port.writeUInt16BE(25565);
  const data = Buffer.concat([writeVarInt(773), writeString('example.test'), port, writeVarInt(3)]);
  const handshake = createPacket(0, data);
  for (let end = 0; end < handshake.length; end++) assert.equal(parseHandshake(handshake.subarray(0, end)), null);
  const parsed = parseHandshake(Buffer.concat([handshake, createPacket(0, writeString('LoginPlayer'))]));
  assert.equal(parsed?.nextState, 3); assert.equal(parsed?.totalBytes, handshake.length);
  assert.equal(parsed?.serverAddress, 'example.test');
  const missingPortAndState = createPacket(0, Buffer.concat([writeVarInt(773), writeString('example.test')]));
  assert.equal(parseHandshake(Buffer.concat([missingPortAndState, Buffer.from([0x63, 0xdd, 0x02])])), null, 'Following bytes never complete fields outside the declared frame.');
  assert.equal(parseHandshake(createPacket(0, Buffer.concat([data, Buffer.from([0])]))), null, 'Trailing bytes inside a handshake are invalid.');
});

test('malformed Minecraft lengths and unsupported handshake states are rejected', () => {
  assert.throws(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80])), /VarInt/);
  assert.throws(() => readString(writeVarInt(-1)), /Negative/);
  assert.throws(() => parseHandshake(writeVarInt(-1)), /length/);
  assert.throws(() => parseHandshake(writeVarInt(8193)), /length/);
  assert.throws(() => parseHandshake(Buffer.from([0])), /length/);
  const port = Buffer.alloc(2); port.writeUInt16BE(25565);
  for (const state of [0, 4, 99]) assert.equal(parseHandshake(createPacket(0, Buffer.concat([writeVarInt(765), writeString('host'), port, writeVarInt(state)]))), null);
  assert.equal(parseHandshake(createPacket(5, Buffer.from([1, 2, 3]))), null);
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
