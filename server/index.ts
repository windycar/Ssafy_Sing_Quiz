/**
 * Server entry point: wires the transport to the room engine.
 *
 * Everything interesting lives in `gameRoom.ts`. This file only owns the
 * things the engine deliberately refuses to own — sockets, wall-clock time,
 * and timers.
 */

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { GameRoom } from './gameRoom.ts';
import { parseClientMessage } from './protocol.ts';
import type { Effect, PlayerId, RoomId, ServerMessage } from './protocol.ts';
import { attachWebSocketServer } from './websocket.ts';
import type { WebSocketConnection } from './websocket.ts';
import { buildSongCatalog } from '../shared/songCatalog.ts';
import type { RawSongRecord, SongConfig } from '../shared/songCatalog.ts';

interface Session {
  connection: WebSocketConnection;
  roomId: RoomId | null;
  playerId: PlayerId | null;
}

export class GameServer {
  private readonly rooms = new Map<RoomId, GameRoom>();
  private readonly sessions = new Map<string, Session>();
  /** Reverse index so a broadcast does not scan every session. */
  private readonly connectionsByPlayer = new Map<PlayerId, WebSocketConnection>();
  private readonly timers = new Map<RoomId, NodeJS.Timeout>();
  private readonly songs: readonly SongConfig[];

  // Not a constructor parameter property: Node's strip-only TypeScript mode
  // does not support that syntax.
  constructor(songs: readonly SongConfig[]) {
    this.songs = songs;
  }

  createRoom(now: number = Date.now()): GameRoom {
    const room = new GameRoom({ songs: this.songs, now });
    this.rooms.set(room.roomId, room);
    return room;
  }

  getRoom(roomId: RoomId): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  registerConnection(connection: WebSocketConnection): void {
    this.sessions.set(connection.id, { connection, roomId: null, playerId: null });
  }

  handleRaw(connection: WebSocketConnection, raw: string): void {
    const session = this.sessions.get(connection.id);
    if (session === undefined) return;

    const message = parseClientMessage(raw);
    if (message === null) {
      this.deliver(connection, {
        type: 'ERROR',
        reason: 'MALFORMED_MESSAGE',
        message: '메시지 형식이 올바르지 않습니다.',
      });
      return;
    }

    // Only the first two message types name a room; everything else relies on
    // the room this connection already bound to.
    const roomId = message.type === 'JOIN_ROOM' || message.type === 'REJOIN' ? message.roomId : session.roomId;
    const room = roomId === null || roomId === undefined ? undefined : this.rooms.get(roomId);
    if (room === undefined) {
      this.deliver(connection, { type: 'ERROR', reason: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없습니다.' });
      return;
    }

    const now = Date.now();
    const effects = room.handleMessage(message, session.playerId, now);
    this.bindIdentity(session, room.roomId, effects);
    this.dispatch(room, effects, connection);
    this.scheduleTimer(room);
  }

  handleClose(connection: WebSocketConnection): void {
    const session = this.sessions.get(connection.id);
    this.sessions.delete(connection.id);
    if (session?.playerId == null || session.roomId == null) return;

    // Only clear the reverse index if this socket is still the current one for
    // that player; a reconnect may already have replaced it.
    if (this.connectionsByPlayer.get(session.playerId) === connection) {
      this.connectionsByPlayer.delete(session.playerId);
    }

    const room = this.rooms.get(session.roomId);
    if (room === undefined) return;
    const effects = room.handleDisconnect(session.playerId, Date.now());
    this.dispatch(room, effects, connection);
    this.scheduleTimer(room);
  }

  /** Learns this connection's player identity from the snapshot it just got. */
  private bindIdentity(session: Session, roomId: RoomId, effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.kind !== 'send' || effect.message.type !== 'ROOM_STATE') continue;
      session.roomId = roomId;
      session.playerId = effect.message.playerId;
      this.connectionsByPlayer.set(effect.message.playerId, session.connection);
    }
  }

  private dispatch(room: GameRoom, effects: Effect[], sender?: WebSocketConnection): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'broadcast':
          for (const session of this.sessions.values()) {
            if (session.roomId === room.roomId) this.deliver(session.connection, effect.message);
          }
          break;
        case 'send': {
          // An empty target means "the connection that sent this", which is how
          // the engine addresses a client that has no identity yet.
          const target = effect.to === '' ? sender : this.connectionsByPlayer.get(effect.to);
          if (target !== undefined) this.deliver(target, effect.message);
          break;
        }
        case 'disconnect': {
          this.connectionsByPlayer.get(effect.to)?.close(1000, 'server closed session');
          break;
        }
      }
    }
  }

  private deliver(connection: WebSocketConnection, message: ServerMessage): void {
    if (!connection.closed) connection.send(JSON.stringify(message));
  }

  /**
   * Timers live here, not in the engine, so the engine stays synchronous and
   * testable. The engine only says *when* it next needs attention.
   */
  private scheduleTimer(room: GameRoom): void {
    const existing = this.timers.get(room.roomId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(room.roomId);
    }

    const timer = room.getTimer();
    if (timer === null) return;

    const delay = Math.max(0, timer.at - Date.now());
    const handle = setTimeout(() => {
      this.timers.delete(room.roomId);
      const effects = room.tick(Date.now());
      this.dispatch(room, effects);
      this.scheduleTimer(room);
    }, delay);
    handle.unref?.();
    this.timers.set(room.roomId, handle);
  }

  shutdown(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }
}

export interface StartOptions {
  port?: number;
  songs: readonly RawSongRecord[];
  allowedOrigins?: readonly string[];
}

export interface RunningServer {
  server: ReturnType<typeof createServer>;
  game: GameServer;
  catalog: ReturnType<typeof buildSongCatalog>;
  /** Cancels timers, drains sockets, and resolves once the port is released. */
  stop(): Promise<void>;
}

export function startServer(options: StartOptions): RunningServer {
  const catalog = buildSongCatalog(options.songs);
  const game = new GameServer(catalog.playable);

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', playableSongs: catalog.playable.length }));
      return;
    }
    response.writeHead(404).end();
  });

  const sockets = attachWebSocketServer(
    server,
    {
      onConnection: (connection: WebSocketConnection, _request: IncomingMessage) => {
        game.registerConnection(connection);
      },
      onMessage: (connection, data) => game.handleRaw(connection, data),
      onClose: (connection) => game.handleClose(connection),
    },
    { allowedOrigins: options.allowedOrigins },
  );

  if (options.port !== undefined) server.listen(options.port);

  const stop = async (): Promise<void> => {
    game.shutdown();
    sockets.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
  };

  return { server, game, catalog, stop };
}
