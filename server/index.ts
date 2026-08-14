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
import { songQuestions, QUESTIONS_PER_TEXT_GAME, SECTION_ORDER } from '../shared/questions.ts';
import type { GameMode, Question } from '../shared/questions.ts';
import { textBankFor } from './questionBanks.ts';

// Re-exported so a caller that already imports the room registry does not need
// a second import to know what order a game runs in.
export { SECTION_ORDER };

/** An abandoned room is collected once every player has been gone this long. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;

interface Session {
  connection: WebSocketConnection;
  roomId: RoomId | null;
  playerId: PlayerId | null;
}

/** How many questions each section contributes. */
export type SectionCounts = Record<GameMode, number>;

/**
 * Everything, which is what a host who changes nothing gets.
 *
 * The song figure is `MAX_SONGS_PER_GAME` and the two text figures are
 * `QUESTIONS_PER_TEXT_GAME`, so the default is "the whole song list, and a full
 * round of each text bank". Every count is clamped to what is actually there,
 * so a host with a 40-song list gets 40 rather than an error.
 */
export const DEFAULT_SECTION_COUNTS: SectionCounts = { song: 100, proverb: 30, idiom: 30 };

export interface CreateRoomOptions {
  /**
   * How many questions to draw per section. Missing entries take the default,
   * and a section set to 0 is skipped — that is how a host drops one.
   */
  counts?: Partial<SectionCounts>;
  /** Restricts the song draw to these ids. Unknown ids are ignored. */
  songIds?: readonly string[];
  /** Draw in random order. On by default — see `selectSongs`. */
  shuffle?: boolean;
  /** Host-supplied media, applied on top of the server's raw records. */
  media?: readonly MediaRegistration[];
  now?: number;
}

/** What one section contributed, after clamping to what was available. */
export interface DrawnSection {
  mode: GameMode;
  count: number;
}

export interface RoomCreation {
  room: GameRoom;
  /**
   * The song catalog this room was drawn from, including everything it
   * rejected. The host screen shows it whatever the song count is, including
   * zero — it is how a host finds out why a song they expected is missing.
   */
  catalog: SongCatalog;
  /** What each section contributed, in playing order. */
  sections: readonly DrawnSection[];
  /** How many questions the room will actually play. */
  questionCount: number;
  /** Superseded by `questionCount`; equal to it. */
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
export interface SelectSongsOptions {
  /** How many to take, after filtering and shuffling. Undefined takes them all. */
  songCount?: number;
  songIds?: readonly string[];
  shuffle?: boolean;
}

export function selectSongs(playable: readonly SongConfig[], options: SelectSongsOptions = {}): SongConfig[] {
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

/**
 * Draws one text game out of a bank: thirty questions, shuffled, no repeats.
 *
 * The bank holds fifty and a game plays thirty, so a draw decides both which
 * questions are asked and in what order. That is the point: two groups playing
 * the same mode on the same evening get different sets, and the second group
 * through has not already heard the answers. Sliced after the shuffle, so the
 * twenty that are left out are a different twenty every time.
 *
 * `randomInt` rather than `Math.random` for the same reason `selectSongs` uses
 * it: the draw is a fairness input, not a cosmetic one.
 */
export function selectQuestions(
  bank: readonly Question[],
  count = QUESTIONS_PER_TEXT_GAME,
  shuffle = true,
): Question[] {
  const pool = [...bank];
  if (shuffle) {
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [pool[i], pool[j]] = [pool[j] as Question, pool[i] as Question];
    }
  }
  return pool.slice(0, Math.max(0, count));
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
   * Titles leave the process here, so every caller must be behind a host token
   * check. Publishing this openly is a real leak once a host has registered
   * media for only a handful of songs: the playable set would then be a short
   * list of candidate answers for the round in progress.
   */
  listSongs(): { id: string; title: string; artist: string }[] {
    return this.songs.map((song) => ({
      id: song.id,
      title: (song.title ?? '').trim(),
      artist: (song.artist ?? '').trim(),
    }));
  }

  /**
   * Draws the questions for one room.
   *
   * The two branches are the whole difference between the modes. A song room
   * draws from a catalog the host assembled, which is why it can come back
   * empty and why `HOST_START` has to refuse that. A text room draws thirty
   * out of a fifty-question bank this repository ships, so it is never empty
   * and `songCount` does not apply to it.
   */
  private draw(options: CreateRoomOptions): {
    catalog: SongCatalog;
    sections: DrawnSection[];
    questions: Question[];
  } {
    const catalog = this.buildCatalog(options.media ?? []);
    const wanted = { ...DEFAULT_SECTION_COUNTS, ...options.counts };

    // Built by walking SECTION_ORDER rather than by concatenating three named
    // results, so the running order lives in exactly one place and adding a
    // fourth kind of question later is a line in that array.
    const sections: DrawnSection[] = [];
    const questions: Question[] = [];

    for (const mode of SECTION_ORDER) {
      const count = Math.max(0, Math.trunc(wanted[mode]));
      const drawn =
        count === 0
          ? []
          : mode === 'song'
            ? songQuestions(selectSongs(catalog.playable, { ...options, songCount: count }))
            : selectQuestions(textBankFor(mode) ?? [], count, options.shuffle !== false);

      // The count reported back is what was actually drawn, not what was asked
      // for: a host who asks for 100 songs and has 40 needs the screen to say
      // 40, and `selectQuestions`/`selectSongs` already clamp for us.
      sections.push({ mode, count: drawn.length });
      questions.push(...drawn);
    }

    return { catalog, sections, questions };
  }

  createRoom(options: CreateRoomOptions = {}): RoomCreation {
    const now = options.now ?? Date.now();
    const { catalog, sections, questions } = this.draw(options);

    const room = new GameRoom({ questions, now });
    this.rooms.set(room.roomId, room);
    this.touchedAt.set(room.roomId, now);
    return { room, catalog, sections, questionCount: questions.length, songCount: questions.length };
  }

  /**
   * Re-draws an existing room's questions.
   *
   * Separate from creation because the song catalog is only readable with a
   * host token, and a host has no token until the room exists — so the host
   * screen necessarily configures the room in a second step, and the per-section
   * counts are set on that same screen. Returns null when the room is past
   * LOBBY and its setlist is therefore frozen.
   */
  configureRoom(room: GameRoom, options: CreateRoomOptions = {}): RoomCreation | null {
    const { catalog, sections, questions } = this.draw(options);
    if (!room.setQuestions(questions)) return null;

    this.touchedAt.set(room.roomId, options.now ?? Date.now());
    return { room, catalog, sections, questionCount: questions.length, songCount: questions.length };
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
