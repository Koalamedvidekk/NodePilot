import net from 'node:net';

export interface MinecraftHandshake {
  protocolVersion: number;
  serverAddress: string;
  serverPort: number;
  nextState: number; // 1 = Status, 2 = Login
  totalBytes: number;
}

export interface ProbeResult {
  ready: boolean;
  latencyMs?: number;
  statusJson?: unknown;
  error?: string;
}

/**
 * Encodes a 32-bit integer into a VarInt Buffer.
 */
export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    } else {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Decodes a VarInt from a Buffer starting at the specified offset.
 * Returns null if the buffer does not contain enough bytes to complete the VarInt.
 */
export function readVarInt(buffer: Buffer, offset = 0): { value: number; bytesRead: number } | null {
  let value = 0;
  let bytesRead = 0;

  while (bytesRead < 5) {
    if (offset + bytesRead >= buffer.length) {
      return null;
    }
    const currentByte = buffer[offset + bytesRead];
    value |= (currentByte & 0x7f) << (7 * bytesRead);
    bytesRead++;
    if ((currentByte & 0x80) === 0) {
      return { value, bytesRead };
    }
  }
  throw new Error('VarInt exceeds 5 bytes limit');
}

/**
 * Encodes a UTF-8 string with a VarInt length prefix.
 */
export function writeString(str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  const lenBuf = writeVarInt(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

/**
 * Decodes a VarInt length-prefixed UTF-8 string.
 */
export function readString(buffer: Buffer, offset = 0): { value: string; bytesRead: number } | null {
  const len = readVarInt(buffer, offset);
  if (!len) return null;
  const start = offset + len.bytesRead;
  if (start + len.value > buffer.length) return null;
  const value = buffer.toString('utf8', start, start + len.value);
  return { value, bytesRead: len.bytesRead + len.value };
}

/**
 * Frames a packet: [Length: VarInt] [Packet ID: VarInt] [Data]
 */
export function createPacket(packetId: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const idBuf = writeVarInt(packetId);
  const lenBuf = writeVarInt(idBuf.length + data.length);
  return Buffer.concat([lenBuf, idBuf, data]);
}

/**
 * Parses a Minecraft Handshake packet from the incoming byte buffer.
 * Returns null if the buffer is incomplete or invalid.
 */
export function parseHandshake(buffer: Buffer): MinecraftHandshake | null {
  const packetLen = readVarInt(buffer, 0);
  if (!packetLen) return null;
  const packetStart = packetLen.bytesRead;
  if (buffer.length < packetStart + packetLen.value) return null;

  let offset = packetStart;
  const packetId = readVarInt(buffer, offset);
  if (!packetId || packetId.value !== 0x00) return null;
  offset += packetId.bytesRead;

  const protocolVersion = readVarInt(buffer, offset);
  if (!protocolVersion) return null;
  offset += protocolVersion.bytesRead;

  const serverAddress = readString(buffer, offset);
  if (!serverAddress) return null;
  offset += serverAddress.bytesRead;

  if (offset + 2 > buffer.length) return null;
  const serverPort = buffer.readUInt16BE(offset);
  offset += 2;

  const nextState = readVarInt(buffer, offset);
  if (!nextState) return null;
  offset += nextState.bytesRead;

  return {
    protocolVersion: protocolVersion.value,
    serverAddress: serverAddress.value,
    serverPort,
    nextState: nextState.value,
    totalBytes: packetStart + packetLen.value,
  };
}

/**
 * Creates a Minecraft Java Status Response packet (Packet ID 0x00 in status state).
 */
export function createStatusResponsePacket(options: {
  motdText?: string;
  protocolVersion?: number;
  versionName?: string;
  maxPlayers?: number;
  onlinePlayers?: number;
}): Buffer {
  const payload = {
    version: {
      name: options.versionName ?? 'NodePilot Auto-Wake',
      protocol: options.protocolVersion ?? 765,
    },
    players: {
      max: options.maxPlayers ?? 20,
      online: options.onlinePlayers ?? 0,
      sample: [],
    },
    description: {
      text: options.motdText ?? '§b⚡ NodePilot Auto-Wake\n§eServer is sleeping. Connect to wake it up!',
    },
  };

  return createPacket(0x00, writeString(JSON.stringify(payload)));
}

/**
 * Creates a Minecraft Java Pong packet (Packet ID 0x01 in status state).
 */
export function createPongPacket(payload: Buffer): Buffer {
  return createPacket(0x01, payload);
}

/**
 * Creates a Minecraft Java Login Disconnect packet (Packet ID 0x00 in login state).
 * This renders cleanly in the Minecraft game client.
 */
export function createLoginDisconnectPacket(message: string): Buffer {
  const payload = {
    text: message,
  };
  return createPacket(0x00, writeString(JSON.stringify(payload)));
}

/**
 * Probes a local Minecraft Java server for protocol readiness.
 * Sends a Handshake (Status) + Status Request, and asserts that a valid Status Response JSON is received.
 */
export async function probeMinecraftServer(host: string, port: number, timeoutMs = 1200): Promise<ProbeResult> {
  const startTime = Date.now();

  return new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let socket: net.Socket | null = null;

    const finish = (result: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({ ready: false, error: `Probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      socket = net.connect({ host, port });
      socket.setNoDelay(true);

      socket.once('error', (err) => {
        finish({ ready: false, error: err.message });
      });

      socket.once('connect', () => {
        // Build handshake packet: protocol 765, host, port, nextState=1 (status)
        const hsData = Buffer.concat([
          writeVarInt(765),
          writeString(host),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(port);
            return b;
          })(),
          writeVarInt(1),
        ]);
        const handshakePacket = createPacket(0x00, hsData);
        const statusRequestPacket = createPacket(0x00); // 0x00 in status state is Status Request

        socket?.write(Buffer.concat([handshakePacket, statusRequestPacket]));
      });

      let incoming = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        incoming = Buffer.concat([incoming, chunk]);

        // Attempt to parse response packet: length, id=0x00, json string
        try {
          const packetLen = readVarInt(incoming, 0);
          if (!packetLen) return;
          const packetStart = packetLen.bytesRead;
          if (incoming.length < packetStart + packetLen.value) return;

          const packetId = readVarInt(incoming, packetStart);
          if (!packetId || packetId.value !== 0x00) {
            finish({ ready: false, error: 'Unexpected packet ID received from Minecraft server' });
            return;
          }

          const jsonStr = readString(incoming, packetStart + packetId.bytesRead);
          if (!jsonStr) return;

          const parsed = JSON.parse(jsonStr.value);
          finish({
            ready: true,
            latencyMs: Date.now() - startTime,
            statusJson: parsed,
          });
        } catch (parseErr) {
          finish({ ready: false, error: `Failed to parse Minecraft status response: ${parseErr}` });
        }
      });
    } catch (err) {
      finish({ ready: false, error: String(err) });
    }
  });
}
