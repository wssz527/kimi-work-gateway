// A tiny loopback JSON-RPC-over-WebSocket server used by the tests below. It is
// deliberately strict — masked client frames only, proper 101 accept — so the
// client is exercised against the same rules the real daemon enforces.
import crypto from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function frame(payload, opcode = 0x1, { fin = true, mask = false } = {}) {  const body = Buffer.from(payload);
  const length = body.length;
  const header = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | length])
    : length < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | 126, length >> 8, length & 0xff])
      : (() => { const value = Buffer.alloc(10); value[0] = (fin ? 0x80 : 0) | opcode;
        value[1] = (mask ? 0x80 : 0) | 127; value.writeBigUInt64BE(BigInt(length), 2); return value; })();
  if (!mask) return Buffer.concat([header, body]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(body.map((value, index) => value ^ key[index & 3]));
  return Buffer.concat([header, key, masked]);
}

// One frame, optionally a non-final fragment (used to test continuation).
export const fragment = (payload, opcode, fin) => frame(payload, opcode, { fin });

// Reads consecutive frames off a socket. Every wss-mode test uses one server per
// assertion group so the handler stays small and explicit.
export function parseFrames(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2)); offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const key = masked ? buffer.subarray(maskOffset, maskOffset + 4) : null;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (key) for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index & 3];
        buffer = buffer.subarray(offset + length);
        onMessage({ opcode: first & 0x0f, masked, payload });
      }
    },
    get masked() { return true; },
  };
}

export async function controlServer({ token, handler, onConnection } = {}) {
  // A plain TCP server instead of http.Server#upgrade: Bun's http upgrade path
  // does not deliver the 101 written from the upgrade handler, and this server
  // only ever needs to speak the handshake itself.
  const server = net.createServer(socket => { handleSocket(socket, token, handler); });
  const sockets = new Set();
  function handleSocket(socket, expected, route) {
    let buffer = Buffer.alloc(0);
    const onFirst = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf('\r\n\r\n');
      if (at < 0) { if (buffer.length > 16384) socket.destroy(); return; }
      socket.off('data', onFirst);
      const head = buffer.subarray(0, at).toString('latin1').split('\r\n');
      const rest = buffer.subarray(at + 4);
      const [method, target] = (head[0] || '').split(' ');
      const headers = new Map();
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const key = headers.get('sec-websocket-key');
      if (method !== 'GET' || target !== '/control' || headers.get('authorization') !== 'Bearer ' + expected || !key) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + digest + '\r\n\r\n');
      sockets.add(socket);
      onConnection?.({ socket });
      const messages = [];
      const reader = parseFrames(({ opcode, payload }) => {
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x9) { socket.write(frame(payload, 0xa)); return; }
        if (opcode !== 0x1) return;
        let input;
        try { input = JSON.parse(payload.toString('utf8')); } catch { return; }
        messages.push(input);
        const reply = route(input, { messages, socket });
        if (reply === undefined) return;
        socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id: input.id, ...reply })));
      });
      if (rest.length) reader.push(rest);
      socket.on('data', chunk => reader.push(chunk));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    };
    socket.on('data', onFirst);
    socket.on('error', () => socket.destroy());
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    url: 'ws://127.0.0.1:' + server.address().port + '/control',
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
