/**
 * Server entry point: wires the transport to the room engine.
 *
 * Everything interesting lives in `gameRoom.ts`. This file only owns the
 * things the engine deliberately refuses to own — sockets, wall-clock time,
 * and timers — plus the room registry: which rooms exist, which songs each one
 * drew, and when an abandoned one is collected.
 */

import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { GameRoom } from './gameRoom.ts';
import { parseClientMessage } from './protocol.ts';
import type { Effect, PlayerId, RoomId, ServerMessage } from './protocol.ts';
import { attachWebSocketServer } from './websocket.ts';
import type { WebSocketConnection } from './websocket.ts';
import { createRequestHandler } from './http.ts';
import { createStaticHandler } from './staticFiles.ts';
import { applyMediaRegistrations, buildSongCatalog } from '../shared/songCatalog.ts';
import type { MediaRegistration, RawSongRecord, SongCatalog, SongConfig } from '../shared/songCatalog.ts';

/** An abandoned room is collected once every player has been gone this long. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;

interface Session {
  connection: WebSocketConnection;
  roomId: RoomId | null;
  playerId: PlayerId | null;
}

export interface CreateRoomOptions {
  /** How many songs the game runs. Defaults to the whole selection. */
  songCount?: number;
  /** Restricts the draw to these song ids. Unknown ids are ignored. */
  songIds?: readonly string[];
  /** Draw in random order. On by default — see `selectSongs`. */
  shuffle?: boolean;
  /** Host-supplied media, applied on top of the server's raw records. */
  media?: readonly MediaRegistration[];
  now?: number;
}

export interface RoomCreation {
  room: GameRoom;
  /** The catalog this room was drawn from, including everything it rejected. */
  catalog: SongCatalog;
  /** How many songs the room will actually play. */
  songCount: number;
}

/**
 * Picks the songs a room will play.
 *
 * Shuffling is on by default and matters for more than variety: the candidate
 * pool is readable over `GET /api/songs` (a host needs it to register media),
 * so a fixed order would let a player who fetched the pool know which song is
 * coming next. A random draw makes that knowledge worth nothing beyond "one of
 * the pool", which is the same thing a player learns by looking at the game's
 * subject matter. `randomInt` rather than `Math.random` because the draw is a
 * fairness input, not a cosmetic one.
 */
export function selectSongs(
  playable: readonly SongConfig[],
  options: Pick<CreateRoomOptions, 'songCount' | 'songIds' | 'shuffle'> = {},
): SongConfig[] {
  let pool = [...playable];

  if (options.songIds !== undefined) {
    const wanted = new Set(options.songIds);
    pool = pool.filter((song) => wanted.has(song.id));
  }

  if (options.shuffle !== false) {
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [pool[i], pool[j]] = [pool[j] as SongConfig, pool[i] as SongConfig];
    }
  }

  // Slice after the shuffle, so `songCount` is a random subset rather than a
  // random ordering of the same first N songs every time.
  if (options.songCount !== undefined) pool = pool.slice(0, Math.max(0, options.songCount));
  return pool;
}

export class GameServer {
  private readonly rooms = new Map<RoomId, GameRoom>();
  private readonly sessions = new Map<string, Session>();
  /** Reverse index so a broadcast does not scan every session. */
  private readonly connectionsByPlayer = new Map<PlayerId, WebSocketConnection>();
  private readonly timers = new Map<RoomId, NodeJS.Timeout>();
  /** Last time anything happened in a room, for `reap`. */
  private readonly touchedAt = new Map<RoomId, number>();
  private readonly songs: readonly RawSongRecord[];
  /** Built once from the server's own records; the pool a host starts from. */
  readonly baseCatalog: SongCatalog;

  // Not a constructor parameter property: Node's strip-only TypeScript mode
  // does not support that syntax.
  constructor(songs: readonly RawSongRecord[]) {
    this.songs = songs;
    this.baseCatalog = buildSongCatalog(songs);
  }

  /** The catalog as it would look with these host registrations applied. */
  buildCatalog(media: readonly MediaRegistration[] = []): SongCatalog {
    if (media.length === 0) return this.baseCatalog;
    return buildSongCatalog(applyMediaRegistrations(this.songs, media));
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Every song the server knows about, playable or not.
   *
   * Titles leave the process here, which is deliberate and bounded: a host
   * cannot register media for a song they cannot see. This is the candidate
   * *pool*, never a room's draw — see `selectSongs` for why that distinction
   * is what keeps it from being an answer leak.
   */
  listSongs(): { id: string; title: string; artist: string }[] {
    return this.songs.map((song) => ({
      id: song.id,
      title: (song.title ?? '').trim(),
      artist: (song.artist ?? '').trim(),
    }));
  }

  createRoom(options: CreateRoomOptions = {}): RoomCreation {
    const now = options.now ?? Date.now();
    const catalog = this.buildCatalog(options.media ?? []);
    const songs = selectSongs(catalog.playable, options);

    const room = new GameRoom({ songs, now });
    this.rooms.set(room.roomId, room);
    this.touchedAt.set(room.roomId, now);
    return { room, catalog, songCount: songs.length };
  }

  getRoom(roomId: RoomId): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  /** Live players in a room, for the join-code lookup endpoint. */
  connectedCount(roomId: RoomId): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && session.playerId !== null) count += 1;
    }
    return count;
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
    this.touchedAt.set(room.roomId, now);
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
    const now = Date.now();
    this.touchedAt.set(room.roomId, now);
    const effects = room.handleDisconnect(session.playerId, now);
    this.dispatch(room, effects, connection);
    this.scheduleTimer(room);
  }

  /**
   * Drops rooms nobody is connected to any more.
   *
   * Room state is in-memory by design (analysis §2), which makes an
   * un-collected room a permanent leak rather than a stale cache entry. The
   * idle window is generous because a player refreshing the page is briefly
   * indistinguishable from one who left for good.
   */
  reap(now: number = Date.now(), ttlMs: number = ROOM_IDLE_TTL_MS): number {
    let removed = 0;
    for (const [roomId, room] of this.rooms) {
      if (!room.isEmpty()) continue;
      if (now - (this.touchedAt.get(roomId) ?? now) < ttlMs) continue;

      const timer = this.timers.get(roomId);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(roomId);
      this.touchedAt.delete(roomId);
      this.rooms.delete(roomId);
      removed += 1;
    }
    return removed;
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
  /**
   * Origins allowed to open a WebSocket and to call the API cross-origin. Empty
   * disables both checks, which is only appropriate locally (analysis §7).
   */
  allowedOrigins?: readonly string[];
  /** Directory holding the reference client. Omit to run API-only. */
  clientDir?: string;
  /** Directory holding `shared/`, mounted at `/shared/` for the client. */
  sharedDir?: string;
}

export interface RunningServer {
  server: ReturnType<typeof createServer>;
  game: GameServer;
  catalog: SongCatalog;
  /** Cancels timers, drains sockets, and resolves once the port is released. */
  stop(): Promise<void>;
}

export function startServer(options: StartOptions): RunningServer {
  const game = new GameServer(options.songs);

  const staticHandler =
    options.clientDir === undefined
      ? undefined
      : createStaticHandler([
          { urlPrefix: '/', dir: options.clientDir },
          ...(options.sharedDir === undefined ? [] : [{ urlPrefix: '/shared/', dir: options.sharedDir }]),
        ]);

  const server = createServer(
    createRequestHandler({
      game,
      staticHandler,
      allowedOrigins: options.allowedOrigins ?? [],
    }),
  );

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

  const reaper = setInterval(() => game.reap(), REAP_INTERVAL_MS);
  reaper.unref?.();

  const stop = async (): Promise<void> => {
    clearInterval(reaper);
    game.shutdown();
    sockets.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
  };

  return { server, game, catalog: game.baseCatalog, stop };
}
