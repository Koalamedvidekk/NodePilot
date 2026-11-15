// Run against a configured test server with Node.js 22+ after the server build.
// NODEPILOT_BROWSER_TEST_CONFIG names a private JSON file with publicAddress,
// name, password, expectedUuid, serverPort, backendPort and backendProtocol.
// Credentials and authentication packets are never printed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readVarInt, writeString, writeVarInt } from '../server/dist/lib/minecraft-protocol.js';

assert.ok(process.env.NODEPILOT_BROWSER_TEST_CONFIG, 'Set NODEPILOT_BROWSER_TEST_CONFIG to a private test configuration file.');
assert.equal(typeof WebSocket, 'function', 'This integration test requires Node.js 22+.');
const fixture = JSON.parse(await readFile(process.env.NODEPILOT_BROWSER_TEST_CONFIG, 'utf8'));
assert.match(fixture.publicAddress, /^wss?:\/\//);
assert.match(fixture.name, /^np_[A-Za-z0-9_]{1,13}$/);
assert.match(fixture.expectedUuid, /^[a-f0-9-]{36}$/i);
for (const key of ['serverPort', 'backendPort', 'backendProtocol']) assert.ok(Number.isInteger(fixture[key]) && fixture[key] > 0 && fixture[key] <= 65535, 'Invalid test endpoint.');

function short(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}
function text(value) {
  const bytes = Buffer.from(value, 'utf8');
  assert.ok(bytes.length <= 255);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

async function browserLogin(password, expectWorld) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(fixture.publicAddress);
    socket.binaryType = 'arraybuffer';
    let playing = false;
    let positioned = false;
    let chunkReceived = false;
    let uuid;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Browser game handshake or world loading timed out.')), 20000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.onopen = () => socket.send(Buffer.concat([
      Buffer.from([1, 2]), short(1), short(3), short(1), short(47),
      text('NodePilotTest'), text('1.0'), Buffer.from([1]), text(fixture.name),
    ]));
    socket.onerror = () => finish(new Error('The public game WebSocket failed.'));
    socket.onclose = () => { if (!settled) finish(new Error('The game connection closed before the test completed.')); };
    socket.onmessage = (event) => {
      try {
        const packet = Buffer.from(event.data);
        if (!playing) {
          switch (packet[0]) {
            case 2:
              socket.send(Buffer.concat([Buffer.from([4]), text(fixture.name), text('default'), text(password)]));
              break;
            case 5: {
              const offset = 2 + packet[1];
              uuid = packet.subarray(offset, offset + 16).toString('hex');
              assert.equal(uuid, fixture.expectedUuid.replaceAll('-', '').toLowerCase(), 'The browser profile must use its stored NodePilot UUID.');
              socket.send(Buffer.from([8]));
              break;
            }
            case 9:
              playing = true;
              if (!expectWorld) finish(null, { allowed: true, uuid });
              break;
            case 6:
            case 255:
              finish(null, { allowed: false });
              break;
          }
          return;
        }
        // The test negotiates the Minecraft 1.8 protocol through the actual translators.
        if (packet[0] === 0) socket.send(packet);
        if (packet[0] === 8 && packet.length >= 34) {
          const x = packet.readDoubleBE(1);
          const y = packet.readDoubleBE(9);
          const z = packet.readDoubleBE(17);
          assert.ok([x, y, z].every(Number.isFinite));
          positioned = true;
          const response = Buffer.alloc(34);
          response[0] = 6;
          packet.copy(response, 1, 1, 33);
          response[33] = 1;
          socket.send(response);
          const movement = Buffer.alloc(26);
          movement[0] = 4;
          movement.writeDoubleBE(x + 0.2, 1);
          movement.writeDoubleBE(y, 9);
          movement.writeDoubleBE(z, 17);
          movement[25] = 1;
          socket.send(movement);
        }
        if ([0x21, 0x26].includes(packet[0]) && packet.length > 100) chunkReceived = true;
        if (positioned && chunkReceived) finish(null, { allowed: true, uuid });
      } catch (error) { finish(error); }
    };
  });
}

function frame(payload) { return Buffer.concat([writeVarInt(payload.length), payload]); }
async function nativeLogin(port, protocol) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffered = Buffer.alloc(0);
    socket.setTimeout(6000, () => socket.destroy(new Error('The native login probe timed out.')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(frame(Buffer.concat([writeVarInt(0), writeVarInt(protocol), writeString('localhost'), short(port), writeVarInt(2)])));
      socket.write(frame(Buffer.concat([writeVarInt(0), writeString(fixture.name), ...(protocol >= 759 ? [Buffer.alloc(16)] : [])])));
    });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 65536) { socket.destroy(new Error('Unexpected native login response size.')); return; }
      const size = readVarInt(buffered);
      if (!size || buffered.length < size.bytesRead + size.value) return;
      const id = readVarInt(buffered, size.bytesRead);
      if (id) { socket.destroy(); resolve(id.value); }
    });
  });
}

await delay(1500);
assert.equal((await browserLogin('incorrect-test-password', false)).allowed, false);
console.log('PASS incorrect browser password denied');
await delay(1500);
const first = await browserLogin(fixture.password, true);
assert.equal(first.allowed, true);
await delay(2000);
const second = await browserLogin(fixture.password, true);
assert.equal(second.uuid, first.uuid);
console.log('PASS actual WSS authentication, world chunks, position/movement packets, and stable-UUID reconnect');
await delay(1500);
assert.equal(await nativeLogin(fixture.serverPort, 47), 1);
console.log('PASS ordinary Java login retains its online authentication challenge');
assert.equal(await nativeLogin(fixture.backendPort, fixture.backendProtocol), 0);
console.log('PASS direct backend login is rejected');
