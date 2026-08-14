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
 * runs to completion before the next message is processed. Places are taken by
 * appending to `round.scorers` synchronously inside one handler, which is why
 * two players can never hold the same place however close their answers land.
 * Do not make any handler in this file `async`.
 */

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { toRoundPublicPayload } from '../shared/songCatalog.ts';
import { createAliasMatcher } from '../shared/answerMatching.ts';
import { toQuestionPublic, toQuestionReveal, SECTION_ORDER } from '../shared/questions.ts';
import type { GameMode, Question } from '../shared/questions.ts';
import type { AliasMatcher } from '../shared/answerMatching.ts';
import type {
  ClientMessage,
  Effect,
  HostToken,
  LeaderboardEntry,
  PlayerId,
  PlayerSummary,
  PlayerToken,
  QuestionPublicInfo,
  RoomId,
  RoomPhase,
  RoundPublicState,
  RoundScorer,
  ServerMessage,
  SongPublicInfo,
  SongRevealInfo,
  ErrorReason,
} from './protocol.ts';

// --- Tunable constants. This file is the single source of truth for them. ---

/** Extra answering time after the clip finishes. */
export const ANSWER_GRACE_MS = 10_000;
export const COUNTDOWN_MS = 3_000;
export const REVEAL_MS = 4_000;
/**
 * The answer window for a proverb or idiom round.
 *
 * A song round is as long as its clip plus `ANSWER_GRACE_MS`, because the clip
 * has to finish before anyone can be expected to know it. A text round has no
 * such floor — the clue is on screen from the first millisecond — so the length
 * is a flat one chosen for reading and typing a Korean phrase on a phone.
 */
export const TEXT_ROUND_MS = 30_000;
/**
 * How long a round stays frozen waiting for a host who dropped out.
 *
 * The round pauses the moment the host's socket closes, because nobody else can
 * pause, skip, or advance it. What this constant adds is an end to that wait: a
 * host whose phone died used to freeze the room for good, since `HOST_RESUME`
 * needs a token that left with them.
 *
 * A minute covers the two things that actually happen — a page refresh and a
 * walk out of Wi-Fi range — without holding twenty people on a still screen for
 * longer than they will tolerate.
 */
export const HOST_GRACE_MS = 60_000;
/**
 * The same wait, for a round only the host's device can play.
 *
 * A YouTube round has no `mediaUrl`: the music comes out of the host's speakers
 * and nowhere else (`livePlayback`, `shared/songCatalog.ts`). Resuming that
 * without them would run a silent timer, so the only honest outcomes are to
 * keep waiting or to end the game on the scores earned so far. Ending it is not
 * reversible, which is why this wait is three times the other one.
 */
export const HOST_ABANDON_MS = 180_000;
/**
 * Points by finishing place, first to last, per mode.
 *
 * Every place in every mode is worth one point. The spread across a game comes
 * from how many rounds you got into, not from how fast you were on any one of
 * them, which keeps a player who is a fraction slower on every question in the
 * game rather than mathematically out of it by round ten.
 *
 * What differs between the modes is how many places there are:
 *
 * - **song** has one. A clip plays for everyone at once, so the first correct
 *   answer is the whole race, and the round ends there and then.
 * - **proverb** and **idiom** have three. Their clue is text sitting on screen
 *   with no audio to wait for, so a single place would be decided in about two
 *   seconds by whoever reads fastest, and everyone else would stop trying.
 *   The round stays open until all three are taken.
 *
 * The length of each entry is that mode's `scorersPerRound`. That is a count
 * of scoring places in one round — it has nothing to do with `MAX_PLAYERS`,
 * which is how many people may be in the room.
 */
export const POINTS_BY_PLACE: Record<GameMode, readonly number[]> = {
  song: [1],
  proverb: [1, 1, 1],
  idiom: [1, 1, 1],
};

/** What one scoring place is worth, in every mode (realtime-protocol.md §5). */
export const POINTS_PER_WIN = 1;

/**
 * How many players may score in one round of this mode before it closes.
 *
 * Not a room size. "최대 3명까지" counts scoring places per question; the room
 * still holds `MAX_PLAYERS` however many of them can score.
 */
export function scorersPerRound(mode: GameMode): number {
  return POINTS_BY_PLACE[mode].length;
}

/** How many people may be in a room at once. Unrelated to `scorersPerRound`. */
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
  question: Question;
  matcher: AliasMatcher;
  startedAt: number;
  /** The full answer window, before any pause extended the deadline. */
  durationMs: number;
  deadline: number;
  paused: boolean;
  pausedAt: number | null;
  winnerId: PlayerId | null;
  /** Correct answerers in the order the server received them. */
  scorers: PlayerId[];
  resolved: boolean;
  guessCounts: Map<PlayerId, number>;
}

/**
 * What the pending timer is for.
 *
 * `HOST_GRACE` is the odd one out: the other three end a phase, while this one
 * only decides how long the room waits for an absent host before it stops
 * waiting. See `resolveHostAbsence`.
 */
type TimerKind = 'COUNTDOWN' | 'DEADLINE' | 'REVEAL' | 'HOST_GRACE';

export interface CreateRoomOptions {
  roomId?: RoomId;
  hostToken?: HostToken;
  /**
   * The questions, already drawn and ordered by the caller.
   *
   * One list, not one per mode. A game is songs then proverbs then idioms in
   * a single run, and each `Question` carries its own mode — which is what the
   * round length, the number of scoring places, the clue on screen and the
   * play-this cue are all read from. This engine plays whatever it is handed,
   * in order, and has no opinion about the mix.
   */
  questions: readonly Question[];
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
  /** Mutable only in LOBBY, through `setQuestions`. */
  private questions: readonly Question[];
  private round: Round | null = null;
  private hostPlayerId: PlayerId | null = null;
  /**
   * True when the current pause is the server's doing rather than the host's.
   *
   * The two look identical on the wire but must not behave the same on the
   * host's return: an automatic pause is undone for them, a deliberate one is
   * theirs to lift.
   */
  private autoPaused = false;
  private nextQuestionIndex = 0;
  /** When the engine next needs `tick()` called. Null means no pending timer. */
  private timerAt: number | null = null;
  private timerKind: TimerKind | null = null;

  constructor(options: CreateRoomOptions) {
    // Join code is short and shareable; the host token is not. Different
    // exposure demands different entropy (analysis §7).
    this.roomId = options.roomId ?? randomBytes(5).toString('base64url');
    this.hostToken = options.hostToken ?? randomBytes(32).toString('base64url');
    this.questions = options.questions;
  }

  // --- Introspection (used by the transport and by tests) ------------------

  getPhase(): RoomPhase {
    return this.phase;
  }

  /**
   * What kind of question is on screen — or next up, between rounds.
   *
   * A room no longer *has* a mode: it plays songs, then proverbs, then idioms
   * in one run. This reports where in that run the room is, so a lobby can say
   * what is coming and a client with no round yet has something to render.
   *
   * The live round wins only while there *is* one. During a countdown the round
   * still holds the question just played, and the interesting answer is the one
   * about to start — which matters on the countdown that crosses from the last
   * song into the first proverb, and matters more to `HOST_SKIP_SECTION`, which
   * would otherwise skip the section that had already finished.
   */
  getMode(): GameMode {
    const live = this.phase === 'IN_ROUND' || this.phase === 'REVEAL' ? this.round?.question : undefined;
    const current = live ?? this.questions[this.nextQuestionIndex] ?? this.questions[this.questions.length - 1];
    return current?.mode ?? 'song';
  }

  getQuestionCount(): number {
    return this.questions.length;
  }

  /**
   * How many questions of each kind this room will play, in playing order.
   *
   * Every section is listed, including ones at zero. A host who asked for a
   * hundred songs and has none needs to see the zero to know why; a screen
   * showing this to players drops the empty ones itself.
   */
  getSectionCounts(): { mode: GameMode; count: number }[] {
    const counts = new Map<GameMode, number>();
    for (const question of this.questions) counts.set(question.mode, (counts.get(question.mode) ?? 0) + 1);
    return SECTION_ORDER.map((mode) => ({ mode, count: counts.get(mode) ?? 0 }));
  }

  /**
   * Replaces the questions this room will play.
   *
   * A room is created and configured in two steps, so that the song catalog can
   * be handed out against a host token rather than published (analysis §7); the
   * per-section counts are set on the same screen and travel the same path.
   * Refused outside LOBBY: changing the setlist mid-game would move the finish
   * line and could swap the question a player is currently answering.
   */
  setQuestions(questions: readonly Question[]): boolean {
    if (this.phase !== 'LOBBY') return false;
    this.questions = questions;
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
        return this.handleJoin(message.nickname, message.hostToken, now);
      case 'REJOIN':
        return this.handleRejoin(message.playerToken, message.hostToken, now);
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
      case 'HOST_SKIP_SECTION':
        return this.handleHostSkipSection(message.hostToken, playerId, now);
      case 'HOST_END':
        return this.handleHostEnd(message.hostToken, playerId);
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
        return this.resolveRound(now);
      case 'REVEAL':
        return this.advanceAfterReveal(now);
      case 'HOST_GRACE':
        return this.resolveHostAbsence(now);
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
    // of letting the round run unattended (analysis §5) — but on a clock, so
    // the freeze cannot outlive the host. `HOST_RESUME` needs a token that just
    // left the building, so without this timer the room is stuck for good.
    //
    // A host who paused deliberately and then dropped gets the same clock: the
    // pause was theirs, the absence is not, and it is the absence that decides
    // how long everyone else waits.
    if (player.isHost && this.phase === 'IN_ROUND' && this.round !== null) {
      const graceMs = this.roundNeedsHost() ? HOST_ABANDON_MS : HOST_GRACE_MS;
      const endsAt = now + graceMs;
      if (this.round.paused) {
        // Already stopped by the host's own hand. Re-announced so the screens
        // stop saying "the host paused this" and start saying how long the
        // room is waiting for them.
        const pausedAt = this.round.pausedAt ?? now;
        effects.push({
          kind: 'broadcast',
          message: { type: 'ROUND_PAUSED', pausedAt, hostAway: true, hostGraceEndsAt: endsAt },
        });
      } else {
        effects.push(...this.pauseRound(now, endsAt));
        this.autoPaused = true;
      }
      this.setTimer(endsAt, 'HOST_GRACE');
    }
    return effects;
  }

  /**
   * True when this round cannot be played without the host's own device.
   *
   * A YouTube round is broadcast with an empty `mediaUrl`: the video id goes to
   * the host alone, so their speakers are the only copy of the music in the
   * room. Every other round — text modes, and songs with a per-client
   * `mediaUrl` — plays on each player's own device and needs the host only for
   * the controls.
   */
  private roundNeedsHost(): boolean {
    const question = this.round?.question;
    return question !== undefined && question.mode === 'song' && question.song.youtubeId !== null;
  }

  /**
   * The host did not come back. Stop waiting.
   *
   * Which way this goes is decided by whether anyone can still play the round.
   * Where the answer is yes, the round resumes and the game runs to the end
   * unattended: every remaining transition is on a server timer, and only
   * `HOST_START` ever needed a host. Where the answer is no — the host's device
   * was the only source of the music — the game ends on the scores already
   * earned, which beats twenty silent rounds nobody can answer.
   */
  private resolveHostAbsence(now: number): Effect[] {
    const round = this.round;
    if (round === null || this.phase !== 'IN_ROUND' || !round.paused) return [];
    return this.roundNeedsHost() ? this.endGame() : this.resumeRound(now);
  }

  /** Whoever holds the host token is back. Stop the clock on their absence. */
  private cancelHostGrace(now: number): Effect[] {
    const round = this.round;
    if (this.timerKind !== 'HOST_GRACE' || round === null) return [];
    this.clearTimer();

    // A pause the host chose stays until they lift it; one the server imposed
    // on their behalf is undone the moment the reason for it is gone.
    if (this.autoPaused) return this.resumeRound(now);

    // Still paused, but no longer counting down to anything. Said out loud,
    // because every screen is currently showing a countdown that just stopped
    // being true — and nothing else would ever correct it.
    return [
      { kind: 'broadcast', message: { type: 'ROUND_PAUSED', pausedAt: round.pausedAt ?? now } },
    ];
  }

  // --- Lobby ---------------------------------------------------------------

  private handleJoin(rawNickname: string, hostToken: HostToken | undefined, now: number): Effect[] {
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
      // Set by `claimHost` below, and only for a player who proved the token.
      isHost: false,
    };
    this.players.set(player.id, player);
    this.tokenIndex.set(player.token, player.id);
    this.claimHost(player, hostToken);

    const effects: Effect[] = [
      { kind: 'send', to: player.id, message: this.buildRoomState(player, now) },
      { kind: 'broadcast', message: { type: 'PLAYER_JOINED', player: this.toSummary(player) } },
    ];
    const cue = this.cueFor(player);
    if (cue !== null) effects.push(cue);
    return effects;
  }

  /**
   * Seats this player as the host, if they can prove it.
   *
   * Host is a property of the token, not of arriving first. Join order used to
   * decide it, which broke in both directions: an invited friend who opened the
   * link before the host became the room's host — collecting the `ROUND_CUE`
   * that names the video, so the music played on the wrong device — and their
   * leaving then froze a round the real host was sitting right there for.
   *
   * The seat moves rather than being shared, so the host opening the link on a
   * second device takes their own controls with them instead of leaving a stale
   * record behind that would pause the room when that tab is closed.
   */
  private claimHost(player: Player, hostToken: HostToken | undefined): void {
    if (hostToken === undefined || !this.authorize(hostToken)) return;
    if (this.hostPlayerId !== null && this.hostPlayerId !== player.id) {
      const previous = this.players.get(this.hostPlayerId);
      if (previous !== undefined) previous.isHost = false;
    }
    player.isHost = true;
    this.hostPlayerId = player.id;
  }

  /**
   * The play-this cue for one player, or null if they must not have it.
   *
   * A host who joins or refreshes mid-round would otherwise have a running
   * deadline and no video, so the cue is re-sent on every path that hands out
   * a room snapshot — and only ever to the host. A text round has nothing to
   * cue: the clue is already on every screen.
   */
  private cueFor(player: Player): Effect | null {
    const round = this.round;
    if (!player.isHost || round === null || this.phase !== 'IN_ROUND') return null;
    if (round.question.mode !== 'song') return null;
    const song = round.question.song;
    if (song.youtubeId === null) return null;
    return {
      kind: 'send',
      to: player.id,
      message: {
        type: 'ROUND_CUE',
        youtubeId: song.youtubeId,
        startMs: song.clipStartMs,
        playMs: song.clipEndMs - song.clipStartMs,
      },
    };
  }

  private handleRejoin(token: PlayerToken, hostToken: HostToken | undefined, now: number): Effect[] {
    const playerId = this.tokenIndex.get(token);
    const player = playerId === undefined ? undefined : this.players.get(playerId);
    if (player === undefined) {
      return [this.errorTo(null, 'UNKNOWN_SESSION', '세션을 찾을 수 없습니다. 새로 참여해 주세요.')];
    }

    const wasConnected = player.connected;
    player.connected = true;
    // A session seated before the host link was opened on this device can still
    // become the host, without having to leave the room and rejoin.
    this.claimHost(player, hostToken);

    // Built before the snapshot would be, so a host returning inside the grace
    // period gets a state that already says the round is running again.
    const returned = player.isHost ? this.cancelHostGrace(now) : [];

    const effects: Effect[] = [{ kind: 'send', to: player.id, message: this.buildRoomState(player, now) }];
    if (!wasConnected) {
      effects.push({
        kind: 'broadcast',
        message: { type: 'PLAYER_CONNECTION_CHANGED', playerId: player.id, connected: true },
      });
    }
    effects.push(...returned);
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
    if (this.questions.length === 0) {
      // Every section came back empty. For a default room that means the song
      // list had nothing playable *and* both question files failed to load, so
      // pointing at any one of them would be a guess; the host screen already
      // shows which.
      return [this.errorTo(playerId, 'NOT_ENOUGH_PLAYERS', '출제할 문제가 없습니다.')];
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
    return this.resumeRound(now);
  }

  /**
   * Restarts the answer window, however it came to be stopped.
   *
   * Shared by the host's own resume and by the two ways the server lifts a
   * pause on its own: the host reconnecting, and the grace period running out.
   * All three have to adjust the deadline identically, which is why there is
   * one of these and not three.
   */
  private resumeRound(now: number): Effect[] {
    const round = this.round;
    if (round === null || !round.paused || round.pausedAt === null) return [];

    // The only place round time is ever adjusted. Pause/resume therefore
    // suspends the answer window without lengthening or shortening it.
    round.deadline += now - round.pausedAt;
    round.paused = false;
    round.pausedAt = null;
    this.autoPaused = false;
    this.setTimer(round.deadline, 'DEADLINE');
    return [{ kind: 'broadcast', message: { type: 'ROUND_RESUMED', newDeadline: round.deadline } }];
  }

  /**
   * Drops the rest of the current section and moves on to the next one.
   *
   * The middle of three: skip drops one question, this drops what is left of
   * one section, end drops everything. Pressing skip ninety times to get out of
   * the songs is not a workflow.
   *
   * Implemented by walking `nextQuestionIndex` past every question still to
   * come of this kind, which is enough on its own — whatever timer is already
   * armed then finds the next section waiting for it:
   *
   * - `IN_ROUND` also resolves the round, exactly as skip does, so the question
   *   on screen still gets its answer shown rather than vanishing.
   * - `REVEAL` and `COUNTDOWN` need nothing else; their pending timer runs into
   *   the new section by itself.
   * - Skipping the last section leaves nothing to play, and `startRound` /
   *   `advanceAfterReveal` end the game on their own.
   */
  private handleHostSkipSection(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase === 'LOBBY' || this.phase === 'FINISHED') {
      return [this.errorTo(playerId, 'WRONG_PHASE', '진행 중인 게임에서만 구간을 넘길 수 있습니다.')];
    }

    const mode = this.getMode();
    while (this.questions[this.nextQuestionIndex]?.mode === mode) {
      this.nextQuestionIndex += 1;
    }

    return this.phase === 'IN_ROUND' ? this.resolveRound(now) : [];
  }

  /**
   * Ends the game where it stands, at the host's word.
   *
   * Skip drops one question; this drops every question that is left. A default
   * room is 160 questions and about two and a half hours, so a host who has run
   * out of evening needs a way to stop that still produces a result — closing
   * the laptop instead would leave the room paused on an absent host and send
   * nobody a final ranking.
   *
   * Refused in `LOBBY`, where there is nothing to end and no scores to report,
   * and in `FINISHED`, where it already happened.
   */
  private handleHostEnd(token: HostToken, playerId: PlayerId | null): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase === 'LOBBY' || this.phase === 'FINISHED') {
      return [this.errorTo(playerId, 'WRONG_PHASE', '진행 중인 게임에서만 종료할 수 있습니다.')];
    }
    return this.endGame();
  }

  private handleHostSkip(token: HostToken, playerId: PlayerId | null, now: number): Effect[] {
    const denied = this.authorizeHost(token, playerId);
    if (denied !== null) return [denied];
    if (this.phase !== 'IN_ROUND' || this.round === null) {
      return [this.errorTo(playerId, 'WRONG_PHASE', '지금은 스킵할 수 없습니다.')];
    }
    // Skip is an immediate timeout. If a correct answer already resolved the
    // round, that winner stands — processing order decides, not skip priority.
    return this.resolveRound(now);
  }

  /**
   * @param hostGraceEndsAt Set only when the host's absence is what stopped the
   *   round, and it says when the server will stop waiting for them. A host
   *   pressing pause passes nothing: that pause has no deadline.
   */
  private pauseRound(now: number, hostGraceEndsAt?: number): Effect[] {
    const round = this.round;
    if (round === null || round.paused) return [];
    round.paused = true;
    round.pausedAt = now;
    this.clearTimer();

    const message: ServerMessage =
      hostGraceEndsAt === undefined
        ? { type: 'ROUND_PAUSED', pausedAt: now }
        : { type: 'ROUND_PAUSED', pausedAt: now, hostAway: true, hostGraceEndsAt };
    return [{ kind: 'broadcast', message }];
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

    // Already scored this round: say nothing about the guess either way. A
    // verdict here would let a scorer keep probing to confirm the answer for
    // the players still trying.
    if (round.scorers.includes(player.id)) {
      return [{ kind: 'send', to: player.id, message: { type: 'ANSWER_TOO_LATE' } }];
    }

    if (!round.matcher.matches(guess)) {
      // Private to the guesser. Broadcasting misses would let players narrow
      // the answer from each other (analysis §4).
      return [{ kind: 'send', to: player.id, message: { type: 'ANSWER_REJECTED', guess } }];
    }

    // The mode's own table, so a song round closes on the first correct answer
    // and a text round holds three places open.
    const table = POINTS_BY_PLACE[round.question.mode];
    const place = round.scorers.length + 1;
    const points = table[place - 1] ?? 0;
    round.scorers.push(player.id);
    if (round.winnerId === null) round.winnerId = player.id;

    player.score += points;
    if (place === 1) player.roundsWon += 1;

    // Only the scorer hears about it: the boards stay still until REVEAL, so a
    // player still guessing learns nothing from watching them.
    const accepted: Effect = {
      kind: 'send',
      to: player.id,
      message: { type: 'ANSWER_ACCEPTED', pointsAwarded: points, place },
    };

    // The round stays open until the last scoring place is taken, so second
    // and third are still worth racing for where the mode has them. Taking the
    // last one closes it — and that player is still owed their own
    // acknowledgment, which is why it is prepended rather than dropped.
    if (round.scorers.length < table.length) return [accepted];
    return [accepted, ...this.resolveRound(now)];
  }

  /**
   * Ends the round and announces it.
   *
   * Scores were already applied as each answer landed, so this only reports.
   * Setting `resolved` here, synchronously, is what stops a fourth scorer
   * slipping in behind the third.
   */
  private resolveRound(now: number): Effect[] {
    const round = this.round;
    if (round === null || round.resolved) return [];

    round.resolved = true;
    this.clearTimer();
    // Drops any armed host-absence timer with it: the round it was waiting on
    // is over, so there is nothing left to resume or abandon.
    this.autoPaused = false;
    this.phase = 'REVEAL';

    const effects: Effect[] = [];
    const table = POINTS_BY_PLACE[round.question.mode];
    const scorers: RoundScorer[] = [];
    for (const [index, playerId] of round.scorers.entries()) {
      const player = this.players.get(playerId);
      if (player === undefined) continue;
      scorers.push({
        playerId: player.id,
        nickname: player.nickname,
        place: index + 1,
        pointsAwarded: table[index] ?? 0,
      });
    }
    const winner =
      scorers.length === 0
        ? null
        : { playerId: scorers[0]!.playerId, nickname: scorers[0]!.nickname };

    const leaderboard = this.buildLeaderboard();
    const answer = toQuestionReveal(round.question);
    effects.push({
      kind: 'broadcast',
      message: {
        type: 'ROUND_REVEAL',
        answer,
        song: toLegacyReveal(answer),
        winner,
        scorers,
        leaderboard,
      },
    });
    effects.push(...this.buildLeaderboardUpdates(leaderboard));

    this.setTimer(now + REVEAL_MS, 'REVEAL');
    return effects;
  }

  /** Ends the game where it stands and reports the standings as final. */
  private endGame(): Effect[] {
    this.phase = 'FINISHED';
    this.round = null;
    this.autoPaused = false;
    this.clearTimer();
    return [{ kind: 'broadcast', message: { type: 'GAME_OVER', finalRanks: this.buildLeaderboard() } }];
  }

  private advanceAfterReveal(now: number): Effect[] {
    if (this.nextQuestionIndex >= this.questions.length) {
      return this.endGame();
    }
    this.phase = 'COUNTDOWN';
    this.setTimer(now + COUNTDOWN_MS, 'COUNTDOWN');
    return [{ kind: 'broadcast', message: { type: 'COUNTDOWN_STARTED', startsAt: now + COUNTDOWN_MS } }];
  }

  /**
   * How long players get to answer this question.
   *
   * Song rounds keep their existing rule exactly — the clip has to finish
   * before anyone can be expected to know it, so the window is the clip plus
   * the grace period. A text clue is legible from the first millisecond, so a
   * text round is a flat `TEXT_ROUND_MS`.
   */
  private durationOf(question: Question): number {
    if (question.mode !== 'song') return TEXT_ROUND_MS;
    return question.song.clipEndMs - question.song.clipStartMs + ANSWER_GRACE_MS;
  }

  private startRound(now: number): Effect[] {
    const question = this.questions[this.nextQuestionIndex];
    if (question === undefined) return this.advanceAfterReveal(now);

    const index = this.nextQuestionIndex;
    this.nextQuestionIndex += 1;
    this.phase = 'IN_ROUND';

    const durationMs = this.durationOf(question);
    const deadline = now + durationMs;
    this.round = {
      index,
      question,
      matcher: createAliasMatcher(question.aliases),
      startedAt: now,
      durationMs,
      deadline,
      paused: false,
      pausedAt: null,
      winnerId: null,
      scorers: [],
      resolved: false,
      guessCounts: new Map(),
    };
    this.setTimer(deadline, 'DEADLINE');

    // Built by the two functions allowed to decide what leaves the server
    // before REVEAL. Between them they cannot emit a title, an artist, the
    // aliases, a YouTube id, a proverb's missing half, or an idiom's answer.
    const payload = this.publicRound(this.round);
    const effects: Effect[] = [
      {
        kind: 'broadcast',
        message: {
          type: 'ROUND_START',
          question: payload.question,
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

  /**
   * Everything about a live round that a client may see, and nothing else.
   *
   * The single redacting seam for every mode. `ROUND_START` and the reconnect
   * snapshot both go through here rather than reading `round.question`
   * directly, because reading it directly is exactly how a future field ends
   * up on the wire before the reveal.
   */
  private publicRound(
    round: Round,
  ): Omit<RoundPublicState, 'serverStartedAt' | 'deadline' | 'paused' | 'pausedAt' | 'hostAway' | 'hostGraceEndsAt'> {
    const question = toQuestionPublic(round.question, round.index, this.questions.length, round.durationMs);

    if (round.question.mode === 'song') {
      const payload = toRoundPublicPayload(round.question.song, round.index, this.questions.length);
      return {
        question,
        song: payload.song,
        mediaUrl: payload.mediaUrl,
        clipStartMs: payload.clipStartMs,
        clipEndMs: payload.clipEndMs,
        livePlayback: payload.livePlayback,
      };
    }

    // A text round has no media at all. These are not placeholders a client
    // should try to play: `livePlayback` is false and `mediaUrl` is empty, so
    // every playback path is closed.
    return {
      question,
      song: toLegacyPublic(question),
      mediaUrl: '',
      clipStartMs: 0,
      clipEndMs: 0,
      livePlayback: false,
    };
  }

  private buildRoomState(player: Player, now: number): ServerMessage {
    const round = this.round;
    let roundState: RoundPublicState | undefined;
    if (round !== null && this.phase === 'IN_ROUND') {
      // The armed grace timer *is* the record of an absent host, so a snapshot
      // reads it rather than a second copy that could drift out of step.
      const hostAway = this.timerKind === 'HOST_GRACE';
      roundState = {
        ...this.publicRound(round),
        serverStartedAt: round.startedAt,
        deadline: round.deadline,
        paused: round.paused,
        pausedAt: round.pausedAt,
        hostAway,
        hostGraceEndsAt: hostAway ? this.timerAt : null,
      };
    }

    void now;
    return {
      type: 'ROOM_STATE',
      phase: this.phase,
      mode: this.getMode(),
      sections: this.getSectionCounts(),
      totalQuestions: this.questions.length,
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

  private setTimer(at: number, kind: TimerKind): void {
    this.timerAt = at;
    this.timerKind = kind;
  }

  private clearTimer(): void {
    this.timerAt = null;
    this.timerKind = null;
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible payload shapes
//
// `song` and `song`-shaped fields predate the other two modes. They are still
// populated so a client written against the song-only protocol keeps rendering
// the progress counter and the reveal instead of showing blanks. New clients
// read `question` and `answer`; these two functions are the only place the old
// names are produced.
// ---------------------------------------------------------------------------

function toLegacyPublic(question: QuestionPublicInfo): SongPublicInfo {
  return {
    index: question.index,
    totalSongs: question.totalQuestions,
    clipDurationMs: question.durationMs,
  };
}

function toLegacyReveal(answer: { answer: string; artist: string | null }): SongRevealInfo {
  return { title: answer.answer, artist: answer.artist ?? '' };
}
