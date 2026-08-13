/**
 * Minimal RFC 6455 WebSocket server built on `node:http`.
 *
 * Written by hand rather than pulled from npm so that `server/` keeps the same
 * dependency-free property as `shared/`: `node --test` runs it with no install
 * step. It implements only what this game needs — text frames, ping/pong,
 * close, and client-masked payloads. It is not a general-purpose library:
 * there is no permessage-deflate and no extension negotiation.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** The handshake GUID fixed by RFC 6455 §1.3. Not a value to be retyped. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Frames larger than this are refused; a guess is never close to this size. */
const MAX_FRAME_BYTES = 64 * 1024;

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WebSocketConnection {
  readonly id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

export interface WebSocketServerHandlers {
  onConnection(connection: WebSocketConnection, request: IncomingMessage): void;
  onMessage(connection: WebSocketConnection, data: string): void;
  onClose(connection: WebSocketConnection): void;
}

export interface WebSocketServerOptions {
  /**
   * Allowed `Origin` header values. An empty list disables the check, which is
   * appropriate only for local development (analysis §7).
   */
  allowedOrigins?: readonly string[];
  path?: string;
}

export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

class Connection implements WebSocketConnection {
  readonly id = randomBytes(9).toString('base64url');
  closed = false;

  private buffer = Buffer.alloc(0);
  /** Accumulates a fragmented text message across continuation frames. */
  private fragments: Buffer[] = [];
  private fragmentedOpcode: number | null = null;

  // Written out longhand rather than as constructor parameter properties:
  // Node's strip-only TypeScript mode does not support that syntax, and this
  // package is deliberately runnable without a build step.
  private readonly socket: Duplex;
  private readonly onMessage: (data: string) => void;
  private readonly onClose: () => void;

  constructor(socket: Duplex, onMessage: (data: string) => void, onClose: () => void) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  send(data: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(data, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(encodeFrame(OPCODE.CLOSE, payload));
    this.destroy();
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.close(1009, 'frame too large');
      return;
    }

    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (frame === null) return;
      this.buffer = this.buffer.subarray(frame.consumed);

      switch (frame.opcode) {
        case OPCODE.CLOSE:
          this.close(1000, '');
          return;
        case OPCODE.PING:
          if (!this.closed) this.socket.write(encodeFrame(OPCODE.PONG, frame.payload));
          break;
        case OPCODE.PONG:
          break;
        case OPCODE.CONTINUATION:
          this.fragments.push(frame.payload);
          if (frame.fin) this.flushFragments();
          break;
        case OPCODE.TEXT:
          if (frame.fin) {
            this.onMessage(frame.payload.toString('utf8'));
          } else {
            this.fragmentedOpcode = OPCODE.TEXT;
            this.fragments = [frame.payload];
          }
          break;
        default:
          // Binary and anything unexpected: this protocol is JSON text only.
          this.close(1003, 'unsupported frame');
          return;
      }
    }
  }

  private flushFragments(): void {
    if (this.fragmentedOpcode === OPCODE.TEXT) {
      this.onMessage(Buffer.concat(this.fragments).toString('utf8'));
    }
    this.fragments = [];
    this.fragmentedOpcode = null;
  }
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  // FIN set; server-to-client frames are never masked.
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

interface DecodedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  consumed: number;
}

/** Returns null when the buffer does not yet hold a complete frame. */
export function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;

  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) return null;
    length = Number(big);
    offset += 8;
  }

  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey !== null) {
    for (let i = 0; i < payload.length; i += 1) {
      // Client frames are always masked; unmask in place.
      payload[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
    }
  }
  return { opcode, fin, payload, consumed: offset + length };
}

export interface WebSocketServerHandle {
  /** Live upgraded connections. */
  size(): number;
  /**
   * Closes every live connection.
   *
   * Necessary because an upgraded socket is detached from the HTTP server's
   * connection tracking: neither `server.close()` nor
   * `server.closeAllConnections()` will end it, so without this a shutdown
   * hangs forever waiting on sockets nothing owns.
   */
  closeAll(code?: number, reason?: string): void;
}

/** Attaches WebSocket upgrade handling to an existing HTTP server. */
export function attachWebSocketServer(
  server: Server,
  handlers: WebSocketServerHandlers,
  options: WebSocketServerOptions = {},
): WebSocketServerHandle {
  const allowedOrigins = options.allowedOrigins ?? [];
  const path = options.path ?? '/ws';
  const live = new Set<Connection>();

  // The 'upgrade' event hands over a net.Socket. Typing it as such (rather
  // than the broader Duplex) is what makes `setNoDelay` available: answers are
  // small and latency-sensitive, so Nagle buffering must be off.
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    const reject = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== path) return reject('404 Not Found');

    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      return reject('400 Bad Request');
    }

    // Cheap defence against a page on another origin opening a socket as the
    // user. It does not replace the token model, it layers on top of it.
    const origin = request.headers.origin;
    if (allowedOrigins.length > 0 && (typeof origin !== 'string' || !allowedOrigins.includes(origin))) {
      return reject('403 Forbidden');
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n'),
    );
    socket.setNoDelay(true);

    let connection: Connection;
    connection = new Connection(
      socket,
      (data) => handlers.onMessage(connection, data),
      () => {
        live.delete(connection);
        handlers.onClose(connection);
      },
    );
    live.add(connection);
    handlers.onConnection(connection, request);
  });

  return {
    size: () => live.size,
    closeAll: (code = 1001, reason = 'server shutting down') => {
      for (const connection of [...live]) connection.close(code, reason);
      live.clear();
    },
  };
}
