/**
 * Authoritative room state machine.
 *
 * Implements the transition table in `docs/realtime-protocol.md` §4 and the
 * correctness rules in `docs/claude-analysis.md` §2, §4, §5.
 *
 * Deliberately transport-free: the engine never touches a socket. It takes a
 * message plus the server's receipt time and returns a list of effects. Two
 * consequences matter.
 *
 * 1. Every rule below is unit-testable without a network, including the ones
 *    that are hardest to trust — simultaneous correct answers, pause/resume
 *    time accounting, and what is *not* in a payload.
 * 2. All time enters through explicit `now` parameters. The engine never calls
 *    `Date.now()`, so tests control the clock exactly and there is no hidden
 *    dependency on wall-clock drift.
 *
 * Concurrency: Node runs one room's handlers on a single thread, so a handler
 * runs to completion before the next message is processed. `resolveRound` sets
 * the winner synchronously, which is why a second correct answer can never
 * also win. Do not make any handler in this file `async`.
 */

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSongMatcher, toRoundPublicPayload } from '../shared/songCatalog.ts';
import type { SongConfig } from '../shared/songCatalog.ts';
import type { AliasMatcher } from '../shared/answerMatching.ts';
import type {
  ClientMessage,
  Effect,
  HostToken,
  LeaderboardEntry,
  PlayerId,
  PlayerSummary,
  PlayerToken,
  RoomId,
  RoomPhase,
  RoundPublicState,
  ServerMessage,
  ErrorReason,
} from './protocol.ts';

// --- Tunable constants. This file is the single source of truth for them. ---

/** Extra answering time after the clip finishes. */
export const ANSWER_GRACE_MS = 10_000;
export const COUNTDOWN_MS = 3_000;
export const REVEAL_MS = 4_000;
/** Points for winning a round (realtime-protocol.md §5). */
export const POINTS_PER_WIN = 100;
export const MAX_PLAYERS = 20;
export const MAX_NICKNAME_LENGTH = 16;
export const MAX_GUESS_LENGTH = 100;
/** Guesses accepted per player per round before further ones are ignored. */
export const MAX_GUESSES_PER_ROUND = 10;

interface Player {
  id: PlayerId;
  token: PlayerToken;
  nickname: string;
  connected: boolean;
  ready: boolean;
  score: number;
  roundsWon: number;
  isHost: boolean;
}

interface Round {
  index: number;
  song: SongConfig;
  matcher: AliasMatcher;
  startedAt: number;
  deadline: number;
  paused: boolean;
  pausedAt: number | null;
  winnerId: PlayerId | null;
  resolved: boolean;
  guessCounts: Map<PlayerId, number>;
}

export interface CreateRoomOptions {
  roomId?: RoomId;
  hostToken?: HostToken;
  songs: readonly SongConfig[];
  now: number;
}

/**
 * Strips control characters and collapses whitespace. Returns null when the
 * result is unusable as a display name.
 */
export function sanitizeNickname(raw: string): string | null {
  const cleaned = raw
    // C0/C1 controls plus zero-width and bidi-override characters.
    // Invisible characters would let two players show an identical name.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_NICKNAME_LENGTH);
}

export class GameRoom {
  readonly roomId: RoomId;
  /** Secret. Higher entropy than `roomId` and never broadcast (analysis §7). */
  readonly hostToken: HostToken;

  private phase: RoomPhase = 'LOBBY';
  private readonly players = new Map<PlayerId, Player>();
  private readonly tokenIndex = new Map<PlayerToken, PlayerId>();
  /** Mutable only in LOBBY, through `setSongs`. */
  private songs: readonly SongConfig[];
  private round: Round | null = null;
  private hostPlayerId: PlayerId | null = null;
  private nextSongIndex = 0;
  /** When the engine next needs `tick()` called. Null means no pending timer. */
  private timerAt: number | null = null;
  private timerKind: 'COUNTDOWN' | 'DEADLINE' | 'REVEAL' | null = null;

  constructor(options: CreateRoomOptions) {
    // Join code is short and shareable; the host token is not. Different
    // exposure demands different entropy (analysis §7).
    this.roomId = options.roomId ?? randomBytes(5).toString('base64url');
    this.hostToken = options.hostToken ?? randomBytes(32).toString('base64url');
    this.songs = options.songs;
  }

  // --- Introspection (used by the transport and by tests) ------------------

  getPhase(): RoomPhase {
    return this.phase;
  }

  getSongCount(): number {
    return this.songs.length;
  }

  /**
   * Replaces the songs this room will play.
   *
   * A room is created empty and configured afterwards, so that the catalog can
   * be handed out against a host token rather than published (analysis §7).
   * Refused outside LOBBY: changing the setlist mid-game would move the
   * finish line and could swap the song a player is currently answering.
   */
  setSongs(songs: readonly SongConfig[]): boolean {
    if (this.phase !== 'LOBBY') return false;
    this.songs = songs;
    return true;
  }

  /** Constant-time host token check, for the HTTP routes. */
  authorize(token: string): boolean {
    const expected = Buffer.from(this.hostToken, 'utf8');
    const given = Buffer.from(token, 'utf8');
    // timingSafeEqual throws on a length mismatch, and the length of a token
    // is not a secret, so compare that first.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  getTimer(): { at: number; kind: string } | null {
    return this.timerAt === null || this.timerKind === null ? null : { at: this.timerAt, kind: this.timerKind };
  }

  getPlayer(playerId: PlayerId): PlayerSummary | null {
    const player = this.players.get(playerId);
    return player === undefined ? null : this.toSummary(player);
  }

  resolveToken(token: PlayerToken): PlayerId | null {
    return this.tokenIndex.get(token) ?? null;
  }

  isEmpty(): boolean {
    return [...this.players.values()].every((player) => !player.connected);
  }

  // --- Message entry point -------------------------------------------------

  /**
   * @param playerId The connection's established identity, or null for a
   *   connection that has not joined yet.
   */
  handleMessage(message: ClientMessage, playerId: PlayerId | null, now: number): Effect[] {
    switch (message.type) {
      case 'JOIN_ROOM':
        return this.handleJoin(message.nickname, now);
      case 'REJOIN':
        return this.handleRejoin(message.playerToken, now);
      case 'SET_READY':
        return this.handleSetReady(playerId, message.ready);
      case 'SUBMIT_ANSWER':
        return this.handleSubmitAnswer(playerId, message.guess, now);
      case 'HOST_START':
        return this.handleHostStart(message.hostToken, playerId, now);
      case 'HOST_PAUSE':
        return this.handleHostPause(message.hostToken, playerId, now);
      case 'HOST_RESUME':
        return this.handleHostResume(message.hostToken, playerId, now);
      case 'HOST_SKIP':
        return this.handleHostSkip(message.hostToken, playerId, now);
      default: {
        const exhaustive: never = message;
        void exhaustive;
        return [];
      }
    }
  }

  /** Drives every server-owned timer. Safe to call more often than needed. */
  tick(now: number): Effect[] {
    if (this.timerAt === null || now < this.timerAt) return [];
    const kind = this.timerKind;
    this.clearTimer();

    switch (kind) {
      case 'COUNTDOWN':
        return this.startRound(now);
      case 'DEADLINE':
        return this.resolveRound(null, now);
      case 'REVEAL':
        return this.advanceAfterReveal(now);
      default:
        return [];
    }
  }

  /**
   * A socket dropped. The player keeps their score and roster slot — a refresh
   * must never cost progress (analysis §5).
   */
  handleDisconnect(playerId: PlayerId, now: number): Effect[] {
    const player = this.players.get(playerId);
    if (player === undefined || !player.connected) return [];
    player.connected = false;

    const effects: Effect[] = [
      { kind: 'broadcast', message: { type: 'PLAYER_CONNECTION_CHANGED', playerId, connected: false } },
    ];

    // With no host present nobody can pause, skip, or advance. Freeze instead
    // of letting the round run unattended (analysis §5).
    if (player.isHost && this.phase === 'IN_ROUND' && this.round !== null && !this.round.paused) {
      effects.push(...this.pauseRound(now));
    }
    return effects;
  }

  // --- Lobby ---------------------------------------------------------------

  private handleJoin(rawNickname: string, now: number): Effect[] {
    if (this.phase !== 'LOBBY') {
      return [this.errorTo(null, 'GAME_ALREADY_STARTED', '게임이 이미 시작되어 참여할 수 없습니다.')];
    }
    if (this.players.size >= MAX_PLAYERS) {
      return [this.errorTo(null, 'ROOM_FULL', `방 정원(${MAX_PLAYERS}명)이 가득 찼습니다.`)];
    }

    const sanitized = sanitizeNickname(rawNickname);
    if (sanitized === null) {
      return [this.errorTo(null, 'INVALID_NICKNAME', '사용할 수 없는 닉네임입니다.')];
    }

    const player: Player = {
      id: randomUUID(),
      token: randomBytes(32).toString('base64url'),
      nickname: this.deduplicateNickname(sanitized),
      connected: true,
      ready: false,
      score: 0,
      roundsWon: 0,
      // First player through the door owns the room.
      isHost: this.hostPlayerId === null,
    };
    this.players.set(player.id, player);
    this.tokenIndex.set(player.token, player.id);
    if (player.isHost) this.hostPlayerId = player.id;

    const effects: Effect[] = [
      { kind: 'send', to: player.id, message: this.buildRoomState(player, now) },
      { kind: 'broadcast', message: { type: 'PLAYER_JOINED', player: this.toSummary(player) } },
    ];
    const cue = this.cueFor(player);
    if (cue !== null) effects.push(cue);
    return effects;
  }

  /**
   * The play-this cue for one player, or null if they must not have it.
   *
   * A host who joins or refreshes mid-round would otherwise have a running
   * deadline and no video, so the cue is re-sent on every path that hands out
   * a room snapshot — and only ever to the host.
   */
  private cueFor(player: Player): Effect | null {
    const round = this.round;
    if (!player.isHost || round === null || this.phase !== 'IN_ROUND') return null;
    if (round.song.youtubeId === null) return null;
    return {
      kind: 'send',
      to: player.id,
      message: {
        type: 'ROUND_CUE',
        youtubeId: round.song.youtubeId,
        startMs: round.song.clipStartMs,
        playMs: round.song.clipEndMs - round.song.clipStartMs,
      },
    };
  }

  private handleRejoin(token: PlayerToken, now: number): Effect[] {
    const playerId = this.tokenIndex.get(token);
    const player = playerId === undefined ? undefined : this.players.get(playerId);
    if (player === undefined) {
      return [this.errorTo(null, 'UNKNOWN_SESSION', '세션을 찾을 수 없습니다. 새로 참여해 주세요.')];
    }

    const wasConnected = player.connected;
    player.connected = true;

    const effects: Effect[] = [{ kind: 'send', to: player.id, message: this.buildRoomState(player, now) }];
    if (!wasConnected) {
      effects.push({
        kind: 'broadcast',
        message: { type: 'PLAYER_CONNECTION_CHANGED', playerId: player.id, connected: true },
      });
    }
    const cue = this.cueFor(player);
    if (cue !== null) effects.push(cue);
    return effects;
  }

  private handleSetReady(playerId: PlayerId | null, ready: boolean): Effect[] {
    const player = playerId === null ? undefined : this.players.get(playerId);
    if (player === undefined) return [this.errorTo(playerId, 'NOT_JOINED', '먼저 방에 참여해야 합니다.')];
    // Late-arriving player actions are a race the player cannot control, so
    // they are ignored rather than turned into an error (protocol §2).
    if (this.phase !== 'LOBBY') return [];

    player.ready = ready;
    return [{ kind: 'broadcast', message: { type: 'PLAYER_READY_CHANGED', playerId: player.id, ready } }];
  }

  // --- Host actions --------------------------------------------------------

  private authorizeHost(token: HostToken, playerId: PlayerId | null): Effect | null {
    // Authority comes from the token, never from "whoever is connected".
    if (!this.authorize(token)) {
      return this.errorTo(playerId, 'NOT_HOST', '방장 권한이 없습니다.');
    }
    return null;
  }

  private handleHostStart(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase !== 'LOBBY') {
      return [this.errorTo(playerId, 'WRONG_PHASE', '대기실에서만 시작할 수 있습니다.')];
    }
    if (this.players.size < 1) {
      return [this.errorTo(playerId, 'NOT_ENOUGH_PLAYERS', '참가자가 없습니다.')];
    }
    if (this.songs.length === 0) {
      return [this.errorTo(playerId, 'NOT_ENOUGH_PLAYERS', '재생 가능한 곡이 없습니다.')];
    }

    this.phase = 'COUNTDOWN';
    this.setTimer(now + COUNTDOWN_MS, 'COUNTDOWN');
    return [{ kind: 'broadcast', message: { type: 'COUNTDOWN_STARTED', startsAt: now + COUNTDOWN_MS } }];
  }

  private handleHostPause(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase !== 'IN_ROUND' || this.round === null || this.round.paused) {
      return [this.errorTo(playerId, 'WRONG_PHASE', '지금은 일시정지할 수 없습니다.')];
    }
    return this.pauseRound(now);
  }

  private handleHostResume(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    const round = this.round;
    if (this.phase !== 'IN_ROUND' || round === null || !round.paused || round.pausedAt === null) {
      return [this.errorTo(playerId, 'WRONG_PHASE', '지금은 재개할 수 없습니다.')];
    }

    // The only place round time is ever adjusted. Pause/resume therefore
    // suspends the answer window without lengthening or shortening it.
    round.deadline += now - round.pausedAt;
    round.paused = false;
    round.pausedAt = null;
    this.setTimer(round.deadline, 'DEADLINE');
    return [{ kind: 'broadcast', message: { type: 'ROUND_RESUMED', newDeadline: round.deadline } }];
  }

  private handleHostSkip(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase !== 'IN_ROUND' || this.round === null) {
      return [this.errorTo(playerId, 'WRONG_PHASE', '지금은 스킵할 수 없습니다.')];
    }
    // Skip is an immediate timeout. If a correct answer already resolved the
    // round, that winner stands — processing order decides, not skip priority.
    return this.resolveRound(null, now);
  }

  private pauseRound(now: number): Effect[] {
    const round = this.round;
    if (round === null || round.paused) return [];
    round.paused = true;
    round.pausedAt = now;
    this.clearTimer();
    return [{ kind: 'broadcast', message: { type: 'ROUND_PAUSED', pausedAt: now } }];
  }

  // --- Answering -----------------------------------------------------------

  private handleSubmitAnswer(playerId: PlayerId | null, guess: string, now: number): Effect[] {
    const player = playerId === null ? undefined : this.players.get(playerId);
    if (player === undefined) return [this.errorTo(playerId, 'NOT_JOINED', '먼저 방에 참여해야 합니다.')];

    const round = this.round;
    if (round === null) return [];
    if (guess.length > MAX_GUESS_LENGTH) return [];
    // A guess in flight when the round ended still deserves an acknowledgment
    // (analysis §4), so REVEAL is handled here rather than gated out. Any
    // other phase is silently ignored: it is a race the player cannot control.
    if (this.phase !== 'IN_ROUND' && this.phase !== 'REVEAL') return [];
    if (this.phase === 'IN_ROUND' && round.paused) return [];

    const used = round.guessCounts.get(player.id) ?? 0;
    if (used >= MAX_GUESSES_PER_ROUND) return [];
    round.guessCounts.set(player.id, used + 1);

    if (round.resolved) {
      // Never say whether a late guess was right: that would reveal the answer
      // before REVEAL (analysis §4).
      return [{ kind: 'send', to: player.id, message: { type: 'ANSWER_TOO_LATE' } }];
    }

    if (!round.matcher.matches(guess)) {
      // Private to the guesser. Broadcasting misses would let players narrow
      // the answer from each other (analysis §4).
      return [{ kind: 'send', to: player.id, message: { type: 'ANSWER_REJECTED', guess } }];
    }

    return this.resolveRound(player.id, now);
  }

  /**
   * Ends the round. Setting `resolved` here, synchronously, is what makes a
   * second winner impossible.
   */
  private resolveRound(winnerId: PlayerId | null, now: number): Effect[] {
    const round = this.round;
    if (round === null || round.resolved) return [];

    round.resolved = true;
    round.winnerId = winnerId;
    this.clearTimer();
    this.phase = 'REVEAL';

    const effects: Effect[] = [];
    let winner: { playerId: PlayerId; nickname: string } | null = null;

    if (winnerId !== null) {
      const player = this.players.get(winnerId);
      if (player !== undefined) {
        player.score += POINTS_PER_WIN;
        player.roundsWon += 1;
        winner = { playerId: player.id, nickname: player.nickname };
        effects.push({
          kind: 'send',
          to: player.id,
          message: { type: 'ANSWER_ACCEPTED', pointsAwarded: POINTS_PER_WIN },
        });
      }
    }

    const leaderboard = this.buildLeaderboard();
    effects.push({
      kind: 'broadcast',
      message: {
        type: 'ROUND_REVEAL',
        song: { title: round.song.title, artist: round.song.artist },
        winner,
        leaderboard,
      },
    });
    effects.push(...this.buildLeaderboardUpdates(leaderboard));

    this.setTimer(now + REVEAL_MS, 'REVEAL');
    return effects;
  }

  private advanceAfterReveal(now: number): Effect[] {
    if (this.nextSongIndex >= this.songs.length) {
      this.phase = 'FINISHED';
      this.round = null;
      return [{ kind: 'broadcast', message: { type: 'GAME_OVER', finalRanks: this.buildLeaderboard() } }];
    }
    this.phase = 'COUNTDOWN';
    this.setTimer(now + COUNTDOWN_MS, 'COUNTDOWN');
    return [{ kind: 'broadcast', message: { type: 'COUNTDOWN_STARTED', startsAt: now + COUNTDOWN_MS } }];
  }

  private startRound(now: number): Effect[] {
    const song = this.songs[this.nextSongIndex];
    if (song === undefined) return this.advanceAfterReveal(now);

    const index = this.nextSongIndex;
    this.nextSongIndex += 1;
    this.phase = 'IN_ROUND';

    const clipDuration = song.clipEndMs - song.clipStartMs;
    const deadline = now + clipDuration + ANSWER_GRACE_MS;
    this.round = {
      index,
      song,
      matcher: createSongMatcher(song),
      startedAt: now,
      deadline,
      paused: false,
      pausedAt: null,
      winnerId: null,
      resolved: false,
      guessCounts: new Map(),
    };
    this.setTimer(deadline, 'DEADLINE');

    // Built by the one function allowed to decide what leaves the server
    // before REVEAL. It cannot include the title, artist, aliases, or the
    // YouTube id.
    const payload = toRoundPublicPayload(song, index, this.songs.length);
    const effects: Effect[] = [
      {
        kind: 'broadcast',
        message: {
          type: 'ROUND_START',
          song: payload.song,
          mediaUrl: payload.mediaUrl,
          clipStartMs: payload.clipStartMs,
          clipEndMs: payload.clipEndMs,
          serverStartedAt: now,
          deadline,
          livePlayback: payload.livePlayback,
        },
      },
    ];

    // The cue names the video, so it goes to the host and to nobody else. A
    // host who has not joined as a player yet simply gets no cue — there is no
    // socket to send it to, and inventing a broadcast fallback would leak it.
    // They pick it up from `cueFor` as soon as they join.
    const host = this.hostPlayerId === null ? undefined : this.players.get(this.hostPlayerId);
    const cue = host === undefined ? null : this.cueFor(host);
    if (cue !== null) effects.push(cue);

    return effects;
  }

  // --- Leaderboard ---------------------------------------------------------

  private buildLeaderboard(): LeaderboardEntry[] {
    const sorted = [...this.players.values()].sort(
      (a, b) => b.score - a.score || b.roundsWon - a.roundsWon || a.nickname.localeCompare(b.nickname),
    );

    const entries: LeaderboardEntry[] = [];
    let previousScore: number | null = null;
    let previousRank = 0;

    sorted.forEach((player, position) => {
      // Standard competition ranking: equal scores share a rank, and the next
      // distinct score skips ahead (300,200,200,100 -> 1,2,2,4).
      const rank = previousScore !== null && player.score === previousScore ? previousRank : position + 1;
      previousScore = player.score;
      previousRank = rank;
      entries.push({ playerId: player.id, nickname: player.nickname, score: player.score, rank });
    });
    return entries;
  }

  /** One message per recipient: `topFive` is shared, `you` is not (protocol §3). */
  private buildLeaderboardUpdates(leaderboard: LeaderboardEntry[]): Effect[] {
    const topFive = leaderboard.slice(0, 5);
    const effects: Effect[] = [];
    for (const entry of leaderboard) {
      effects.push({
        kind: 'send',
        to: entry.playerId,
        message: { type: 'LEADERBOARD_UPDATE', topFive, you: entry },
      });
    }
    return effects;
  }

  // --- Helpers -------------------------------------------------------------

  private buildRoomState(player: Player, now: number): ServerMessage {
    const round = this.round;
    let roundState: RoundPublicState | undefined;
    if (round !== null && this.phase === 'IN_ROUND') {
      // Everything about the song goes through the one redacting function,
      // including on this path — reading `round.song` directly here is how a
      // future field ends up leaking to a reconnecting player.
      const payload = toRoundPublicPayload(round.song, round.index, this.songs.length);
      roundState = {
        song: payload.song,
        mediaUrl: payload.mediaUrl,
        clipStartMs: payload.clipStartMs,
        clipEndMs: payload.clipEndMs,
        serverStartedAt: round.startedAt,
        deadline: round.deadline,
        paused: round.paused,
        pausedAt: round.pausedAt,
        livePlayback: payload.livePlayback,
      };
    }

    void now;
    return {
      type: 'ROOM_STATE',
      phase: this.phase,
      players: [...this.players.values()].map((entry) => this.toSummary(entry)),
      isHost: player.isHost,
      playerToken: player.token,
      playerId: player.id,
      song: roundState?.song,
      round: roundState,
      leaderboard: this.buildLeaderboard(),
      answeredThisRound: round === null ? false : (round.guessCounts.get(player.id) ?? 0) > 0,
    };
  }

  private deduplicateNickname(nickname: string): string {
    const taken = new Set([...this.players.values()].map((player) => player.nickname));
    if (!taken.has(nickname)) return nickname;
    for (let suffix = 2; suffix < MAX_PLAYERS + 2; suffix += 1) {
      const candidate = `${nickname}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${nickname}-${randomBytes(2).toString('hex')}`;
  }

  private toSummary(player: Player): PlayerSummary {
    return {
      id: player.id,
      nickname: player.nickname,
      connected: player.connected,
      ready: player.ready,
      score: player.score,
    };
  }

  private errorTo(playerId: PlayerId | null, reason: ErrorReason, message: string): Effect {
    const error: ServerMessage = { type: 'ERROR', reason, message };
    // A connection with no identity yet can only be addressed by broadcast to
    // itself; the transport interprets an empty target as "the sender".
    return { kind: 'send', to: playerId ?? '', message: error };
  }

  private setTimer(at: number, kind: 'COUNTDOWN' | 'DEADLINE' | 'REVEAL'): void {
    this.timerAt = at;
    this.timerKind = kind;
  }

  private clearTimer(): void {
    this.timerAt = null;
    this.timerKind = null;
  }
}
