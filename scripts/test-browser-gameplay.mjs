// Run against a configured test server with Node.js 22+ after the server build.
// NODEPILOT_BROWSER_TEST_CONFIG names a private JSON file with publicAddress,
// name, serverPort, backendPort and backendProtocol. Set expectedName and
// expectedUuid to verify a migrated player's original identity.
// Set clientProtocol: 777 to exercise EaglerX v5 / Minecraft 26.3; default is 1.8.
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
assert.match(fixture.name, /^[A-Za-z0-9_]{1,16}$/);
if (fixture.expectedUuid) assert.match(fixture.expectedUuid, /^[a-f0-9-]{36}$/i);
for (const key of ['serverPort', 'backendPort', 'backendProtocol']) assert.ok(Number.isInteger(fixture[key]) && fixture[key] > 0 && fixture[key] <= 65535, 'Invalid test endpoint.');
const modern = fixture.clientProtocol === 777;
assert.ok(fixture.clientProtocol === undefined || [47,777].includes(fixture.clientProtocol), 'Only the verified 1.8 and 26.3 test codecs are available.');

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

async function browserLogin() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(fixture.publicAddress);
    socket.binaryType = 'arraybuffer';
    let playing = false;
    let positioned = false;
    let chunkReceived = false;
    let uuid;
    let configuration = modern;
    let previousPosition = [0,0,0];
    let previousRotation = [0,0];
    let playerLoaded = false;
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
      Buffer.from([1, 2]), short(1), short(modern ? 5 : 3), short(1), short(modern ? 777 : 47),
      text('NodePilotTest'), text('1.0'), Buffer.from([0]), text(fixture.name),
    ]));
    socket.onerror = () => finish(new Error('The public game WebSocket failed.'));
    socket.onclose = () => { if (!settled) finish(new Error('The game connection closed before the test completed.')); };
    socket.onmessage = (event) => {
      try {
        const packet = Buffer.from(event.data);
        if (!playing) {
          switch (packet[0]) {
            case 2:
              assert.equal(packet.readUInt16BE(1), modern ? 5 : 3);
              assert.equal(packet.readUInt16BE(3), modern ? 777 : 47);
              { const versionOffset = 6 + packet[5];
                assert.equal(packet[versionOffset + 1 + packet[versionOffset]], 0, 'The gateway must advertise a password-free handshake.'); }
              socket.send(Buffer.concat([Buffer.from([4]), text(fixture.name), text('default'), text(''), ...(modern ? [Buffer.from([0,0,0,0])] : [])]));
              break;
            case 5: {
              const offset = 2 + packet[1];
              assert.equal(packet.toString('ascii', 2, offset), fixture.expectedName ?? fixture.name);
              uuid = packet.subarray(offset, offset + 16).toString('hex');
              assert.match(uuid, /^[a-f0-9]{32}$/);
              if (fixture.expectedUuid) assert.equal(uuid, fixture.expectedUuid.replaceAll('-', '').toLowerCase(), 'The returning player must retain their original UUID.');
              socket.send(Buffer.from([8]));
              break;
            }
            case 9:
              playing = true;
              break;
            case 6:
            case 255:
              finish(null, { allowed: false });
              break;
          }
          return;
        }
        if (modern) {
          // IDs are pinned to ViaVersion 5.12.2 Clientbound/ServerboundPackets26_3.
          // EaglerX consumes native login success; v5 begins in CONFIGURATION.
          if (packet[0] === 0xEE) return; // Eagler extension, not a Minecraft packet.
          if (configuration) {
            if (packet[0] === 0x03) { socket.send(Buffer.from([3])); configuration = false; }
            if (packet[0] === 0x0F) {
              socket.send(Buffer.concat([Buffer.from([0]), writeString('en_US'), Buffer.from([3,0,1,127,1,0,1,0])]));
              socket.send(Buffer.from([7,0])); // No cached registry packs.
            }
            if ([4,5].includes(packet[0])) socket.send(packet);
            if (packet[0] === 0x14) socket.send(Buffer.from([9]));
            if (packet[0] === 2) finish(new Error('The backend rejected browser configuration.'));
            return;
          }
          if (packet[0] === 0x78) { socket.send(Buffer.from([0x10])); configuration = true; return; }
          if (packet[0] === 0x20) { finish(new Error('The backend disconnected the test player.')); return; }
          if (packet[0] === 0x2D) socket.send(Buffer.concat([Buffer.from([0x1C]),packet.subarray(1)]));
          if (packet[0] === 0x49) {
            const teleport = readVarInt(packet,1);
            assert.ok(teleport);
            const offset = 1 + teleport.bytesRead;
            assert.ok(packet.length >= offset + 60);
            const flags = packet.readUInt32BE(offset + 56);
            const coordinates = [0,1,2].map(index => packet.readDoubleBE(offset + 8 * index) + (flags & (1 << index) ? previousPosition[index] : 0));
            assert.ok(coordinates.every(Number.isFinite));
            previousPosition = coordinates;
            const position = Buffer.alloc(24);
            coordinates.forEach((value,index) => position.writeDoubleBE(value,index * 8));
            const rotation = Buffer.alloc(8);
            previousRotation = [0,1].map(index => packet.readFloatBE(offset + 48 + 4 * index) + (flags & (1 << (index+3)) ? previousRotation[index] : 0));
            previousRotation.forEach((value,index) => rotation.writeFloatBE(value,index*4));
            // 26.3's actual AcceptTeleportation codec also carries position/rotation.
            socket.send(Buffer.concat([Buffer.from([0]),writeVarInt(teleport.value),position,rotation]));
            const movement = Buffer.alloc(26); movement[0] = 0x1E;
            movement.writeDoubleBE(coordinates[0]+0.2,1); movement.writeDoubleBE(coordinates[1],9); movement.writeDoubleBE(coordinates[2],17); movement[25] = 1;
            socket.send(movement);
            if (!playerLoaded) { playerLoaded = true; socket.send(Buffer.from([0x2C])); }
            positioned = true;
          }
          if (packet[0] === 0x2E && packet.length > 100) chunkReceived = true;
          if (packet[0] === 0x0B) { const reply=Buffer.alloc(5); reply[0]=0x0B; reply.writeFloatBE(20,1); socket.send(reply); }
          if (positioned && chunkReceived) finish(null,{allowed:true,uuid});
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
const first = await browserLogin();
assert.equal(first.allowed, true);
await delay(2000);
const second = await browserLogin();
assert.equal(second.allowed, true);
assert.equal(second.uuid, first.uuid);
console.log('PASS password-free WSS '+(modern ? '26.3 protocol-v5' : '1.8')+' login, world chunks, position/movement packets, and stable-UUID reconnect');
await delay(1500);
assert.equal(await nativeLogin(fixture.serverPort, modern ? 777 : 47), 1);
console.log('PASS ordinary Java login retains its online authentication challenge');
assert.equal(await nativeLogin(fixture.backendPort, fixture.backendProtocol), 0);
console.log('PASS direct backend login is rejected');
