/**
 * Protocol client: the browser-side half of `docs/realtime-protocol.md`.
 *
 * Framework-free and environment-free on purpose. It imports only *types* from
 * the server, so it can be loaded by the reference UI in `ui.ts`, by the
 * `agent/codex` Next.js app (integration-plan §3 step 5), and by `node --test`
 * against a real server — all from this one file, with no build step and no
 * dependency.
 *
 * Two rules from `docs/claude-analysis.md` are enforced here by construction:
 *
 * - **The client never judges.** There is no alias set and no comparison in
 *   this file. `submitAnswer` sends a string; the verdict is whatever the
 *   server sends back (§7).
 * - **The client never owns the clock.** `deadline` arrives from the server and
 *   is only ever read, never decremented. `serverNow()` converts the local
 *   clock into the server's, so two tabs throttled differently still agree on
 *   when the round ends (integration-plan §1.4).
 *
 * Token handling is left to the caller via `onToken`: persisting a session is a
 * host-environment concern (`sessionStorage` in a browser, nothing at all in a
 * test), and baking it in here would tie this module to the DOM.
 */

import type {
  ClientMessage,
  ErrorReason,
  GameMode,
  LeaderboardEntry,
  PlayerId,
  PlayerSummary,
  PlayerToken,
  QuestionPublicInfo,
  QuestionRevealInfo,
  RoomPhase,
  RoundScorer,
  SectionSummary,
  ServerMessage,
  SongPublicInfo,
} from '../server/protocol.ts';

// ---------------------------------------------------------------------------
// Socket abstraction
// ---------------------------------------------------------------------------

export interface SocketMessageEvent {
  data: unknown;
}

/**
 * The subset of `WebSocket` this client uses. Narrow enough that a test can
 * implement it in a dozen lines, which is what makes the reconnect logic
 * testable without a network.
 */
export interface ProtocolSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessageEvent) => void): void;
}

export type SocketFactory = (url: string) => ProtocolSocket;

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as ProtocolSocket;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed';

export interface RoundView {
  /**
   * What this round asks: mode, position, total, and — in a text mode — the
   * proverb prefix or idiom meaning to put on screen. Never the answer.
   */
  question: QuestionPublicInfo;
  /** Superseded by `question`; kept because it is what older UI code reads. */
  song: SongPublicInfo;
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number;
  deadline: number;
  paused: boolean;
  pausedAt: number | null;
  /**
   * True while the pause is the host's connection dropping rather than the host
   * choosing to stop. The two need different words on screen: one is a break,
   * the other is an outage the server is timing.
   */
  hostAway: boolean;
  /** When the server stops waiting for the host, or null when it is not. */
  hostGraceEndsAt: number | null;
  /** The host plays this one in the room; nobody else plays anything. */
  livePlayback: boolean;
  /**
   * What to play, and only ever set on the host's own client — the server
   * sends `ROUND_CUE` to the host alone. A player's copy stays null, which is
   * why a UI can read it without checking who it is rendering for.
   */
  cue: { youtubeId: string; startMs: number; playMs: number } | null;
}

export interface RevealView {
  /**
   * The answer in whichever shape this mode has one. The first moment any of
   * it exists on a client.
   */
  answer: QuestionRevealInfo;
  winner: { playerId: PlayerId; nickname: string } | null;
  /** Everyone who scored, first to last. Empty when nobody got it. */
  scorers: RoundScorer[];
}

/** The verdict on this player's own guess. Never says anything about others. */
export type AnswerFeedback =
  | { kind: 'none' }
  | { kind: 'accepted'; pointsAwarded: number; place: number }
  | { kind: 'rejected'; guess: string }
  | { kind: 'tooLate' };

export interface ClientState {
  status: ConnectionStatus;
  phase: RoomPhase;
  /**
   * The kind of question on screen, or next up between rounds. Known from the
   * first `ROOM_STATE`, before any round.
   *
   * Not a property of the room — one game plays songs, then proverbs, then
   * idioms. Read `round.question.mode` when there is a round; this is the
   * fallback for the screens that come before one.
   */
  mode: GameMode;
  /** What the room will play, in order. Empty until the first `ROOM_STATE`. */
  sections: SectionSummary[];
  /** How many questions the room will play in total, across every section. */
  totalQuestions: number;
  roomId: string | null;
  playerId: PlayerId | null;
  isHost: boolean;
  players: PlayerSummary[];
  leaderboard: LeaderboardEntry[];
  /** This player's own standing, which `topFive` may not include. */
  you: LeaderboardEntry | null;
  round: RoundView | null;
  reveal: RevealView | null;
  finalRanks: LeaderboardEntry[] | null;
  countdownStartsAt: number | null;
  answerFeedback: AnswerFeedback;
  answeredThisRound: boolean;
  error: { reason: ErrorReason; message: string } | null;
  /**
   * Local clock + this = the server's clock. See `sampleClock` for why it is a
   * running maximum rather than the latest reading.
   */
  clockOffsetMs: number;
}

export function initialState(roomId: string | null = null): ClientState {
  return {
    status: 'idle',
    phase: 'LOBBY',
    // A guess until the first ROOM_STATE says otherwise. Songs open every game,
    // so that is what a client which never hears back would have shown anyway.
    mode: 'song',
    sections: [],
    totalQuestions: 0,
    roomId,
    playerId: null,
    isHost: false,
    players: [],
    leaderboard: [],
    you: null,
    round: null,
    reveal: null,
    finalRanks: null,
    countdownStartsAt: null,
    answerFeedback: { kind: 'none' },
    answeredThisRound: false,
    error: null,
    clockOffsetMs: 0,
  };
}

/**
 * Folds one server reading of "now" into the clock offset.
 *
 * A single sample underestimates the offset by however long the message spent
 * in flight, so the *largest* sample seen is the one that travelled fastest and
 * is the best estimate. This does not remove the fairness limit in
 * analysis §6 — it only stops the countdown from disagreeing between tabs.
 */
function sampleClock(state: ClientState, serverNow: number, receivedAt: number): number {
  const sample = serverNow - receivedAt;
  return state.clockOffsetMs === 0 ? sample : Math.max(state.clockOffsetMs, sample);
}

function patchPlayer(
  players: readonly PlayerSummary[],
  playerId: PlayerId,
  patch: Partial<PlayerSummary>,
): PlayerSummary[] {
  return players.map((player) => (player.id === playerId ? { ...player, ...patch } : player));
}

/**
 * The whole client-side protocol, as one pure function.
 *
 * Pure so that every transition can be tested by calling it, with no socket,
 * no timers, and no DOM. `receivedAt` is passed in for the same reason the
 * server engine takes `now`: the clock is an input, not an ambient fact.
 */
export function applyServerMessage(state: ClientState, message: ServerMessage, receivedAt: number): ClientState {
  switch (message.type) {
    case 'ROOM_STATE': {
      const round: RoundView | null =
        message.round === undefined
          ? null
          : {
              question: message.round.question,
              song: message.round.song,
              mediaUrl: message.round.mediaUrl,
              clipStartMs: message.round.clipStartMs,
              clipEndMs: message.round.clipEndMs,
              serverStartedAt: message.round.serverStartedAt,
              deadline: message.round.deadline,
              paused: message.round.paused,
              pausedAt: message.round.pausedAt,
              hostAway: message.round.hostAway,
              hostGraceEndsAt: message.round.hostGraceEndsAt,
              livePlayback: message.round.livePlayback,
              // A host reconnecting mid-round gets its ROUND_CUE right after
              // this snapshot; a player never gets one.
              cue: state.round?.cue ?? null,
            };
      return {
        ...state,
        status: 'joined',
        phase: message.phase,
        mode: message.mode,
        sections: message.sections ?? state.sections,
        totalQuestions: message.totalQuestions,
        playerId: message.playerId,
        isHost: message.isHost,
        players: message.players,
        leaderboard: message.leaderboard,
        you: message.leaderboard.find((entry) => entry.playerId === message.playerId) ?? state.you,
        round,
        // A snapshot cannot restore a reveal that already happened; the next
        // ROUND_START (or GAME_OVER) will resynchronise the view.
        reveal: message.phase === 'REVEAL' ? state.reveal : null,
        answeredThisRound: message.answeredThisRound ?? false,
        error: null,
      };
    }

    case 'PLAYER_JOINED':
      return state.players.some((player) => player.id === message.player.id)
        ? state
        : { ...state, players: [...state.players, message.player] };

    case 'PLAYER_LEFT':
      return { ...state, players: state.players.filter((player) => player.id !== message.playerId) };

    case 'PLAYER_CONNECTION_CHANGED':
      return { ...state, players: patchPlayer(state.players, message.playerId, { connected: message.connected }) };

    case 'PLAYER_READY_CHANGED':
      return { ...state, players: patchPlayer(state.players, message.playerId, { ready: message.ready }) };

    case 'COUNTDOWN_STARTED':
      return {
        ...state,
        phase: 'COUNTDOWN',
        countdownStartsAt: message.startsAt,
        round: null,
        reveal: null,
        answerFeedback: { kind: 'none' },
        answeredThisRound: false,
      };

    case 'ROUND_START':
      return {
        ...state,
        phase: 'IN_ROUND',
        countdownStartsAt: null,
        mode: message.question.mode,
        totalQuestions: message.question.totalQuestions,
        clockOffsetMs: sampleClock(state, message.serverStartedAt, receivedAt),
        round: {
          question: message.question,
          song: message.song,
          mediaUrl: message.mediaUrl,
          clipStartMs: message.clipStartMs,
          clipEndMs: message.clipEndMs,
          serverStartedAt: message.serverStartedAt,
          deadline: message.deadline,
          paused: false,
          pausedAt: null,
          hostAway: false,
          hostGraceEndsAt: null,
          livePlayback: message.livePlayback,
          // ROUND_CUE arrives separately, and only for the host.
          cue: null,
        },
        reveal: null,
        answerFeedback: { kind: 'none' },
        answeredThisRound: false,
      };

    case 'ROUND_CUE':
      // Ignored when no round is open: a cue without its ROUND_START would
      // point at a video the client has no deadline for.
      return state.round === null
        ? state
        : {
            ...state,
            round: {
              ...state.round,
              cue: { youtubeId: message.youtubeId, startMs: message.startMs, playMs: message.playMs },
            },
          };

    case 'ROUND_PAUSED':
      return {
        ...state,
        clockOffsetMs: sampleClock(state, message.pausedAt, receivedAt),
        round:
          state.round === null
            ? null
            : {
                ...state.round,
                paused: true,
                pausedAt: message.pausedAt,
                hostAway: message.hostAway ?? false,
                hostGraceEndsAt: message.hostGraceEndsAt ?? null,
              },
      };

    case 'ROUND_RESUMED':
      return {
        ...state,
        // The server extended the deadline by the paused duration. The client
        // adopts the new value; it never computes one.
        round:
          state.round === null
            ? null
            : {
                ...state.round,
                paused: false,
                pausedAt: null,
                hostAway: false,
                hostGraceEndsAt: null,
                deadline: message.newDeadline,
              },
      };

    case 'ANSWER_ACCEPTED':
      return {
        ...state,
        answerFeedback: { kind: 'accepted', pointsAwarded: message.pointsAwarded, place: message.place },
        answeredThisRound: true,
      };

    case 'ANSWER_REJECTED':
      return { ...state, answerFeedback: { kind: 'rejected', guess: message.guess }, answeredThisRound: true };

    case 'ANSWER_TOO_LATE':
      return { ...state, answerFeedback: { kind: 'tooLate' }, answeredThisRound: true };

    case 'ROUND_REVEAL': {
      const scores = new Map(message.leaderboard.map((entry) => [entry.playerId, entry.score]));
      return {
        ...state,
        phase: 'REVEAL',
        reveal: {
          answer: message.answer,
          winner: message.winner,
          scorers: message.scorers,
        },
        leaderboard: message.leaderboard,
        // Keep the roster's scores in step with the leaderboard so a caller can
        // render either one without them disagreeing.
        players: state.players.map((player) => ({ ...player, score: scores.get(player.id) ?? player.score })),
        round: state.round === null ? null : { ...state.round, paused: false, hostAway: false, hostGraceEndsAt: null },
      };
    }

    case 'LEADERBOARD_UPDATE':
      return { ...state, you: message.you };

    case 'GAME_OVER':
      return { ...state, phase: 'FINISHED', finalRanks: message.finalRanks, leaderboard: message.finalRanks, round: null };

    case 'ERROR':
      return { ...state, error: { reason: message.reason, message: message.message } };

    default: {
      const exhaustive: never = message;
      void exhaustive;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT: ReconnectOptions = { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 8_000 };

export interface ProtocolClientOptions {
  /** WebSocket endpoint, e.g. `ws://localhost:8787/ws`. */
  url: string;
  roomId: string;
  /** Used for a first join. Ignored when `playerToken` is supplied. */
  nickname?: string;
  /** A stored session, from a previous `onToken`. Triggers REJOIN. */
  playerToken?: PlayerToken | null;
  /** Host secret. Held here only to stamp host actions; never sent otherwise. */
  hostToken?: string | null;
  socketFactory?: SocketFactory;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
  reconnect?: ReconnectOptions | false;
  /** Called whenever the session token changes, so the caller can persist it. */
  onToken?: (token: PlayerToken) => void;
  onStateChange?: (state: ClientState) => void;
  /** Raw messages, for transient effects a state snapshot cannot express. */
  onEvent?: (message: ServerMessage) => void;
}

export class ProtocolClient {
  private readonly options: ProtocolClientOptions;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => void;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectOptions: ReconnectOptions | false;
  private readonly listeners = new Set<(state: ClientState) => void>();

  private socket: ProtocolSocket | null = null;
  /**
   * Whether `socket` has opened. A `WebSocket` throws `InvalidStateError` if
   * you call `send` while it is still CONNECTING, so this is what stops a
   * click during a reconnect from raising out of a UI event handler.
   */
  private socketOpen = false;
  private state: ClientState;
  private playerToken: PlayerToken | null;
  private attempt = 0;
  /** Set by `disconnect()`, so a deliberate close never triggers a retry. */
  private stopped = false;

  constructor(options: ProtocolClientOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, delay) => void setTimeout(callback, delay));
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectOptions = options.reconnect ?? DEFAULT_RECONNECT;
    this.playerToken = options.playerToken ?? null;
    this.state = initialState(options.roomId);
    if (options.onStateChange !== undefined) this.listeners.add(options.onStateChange);
  }

  getState(): ClientState {
    return this.state;
  }

  subscribe(listener: (state: ClientState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The server's clock, as best this client can estimate it. */
  serverNow(): number {
    return this.now() + this.state.clockOffsetMs;
  }

  /**
   * Milliseconds left in the round, or null outside one.
   *
   * While paused the answer window is frozen, so the remaining time is measured
   * from `pausedAt` rather than from now — otherwise a long pause would drain a
   * timer the server has stopped.
   */
  remainingMs(): number | null {
    const round = this.state.round;
    if (round === null) return null;
    const reference = round.paused && round.pausedAt !== null ? round.pausedAt : this.serverNow();
    return Math.max(0, round.deadline - reference);
  }

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  disconnect(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.update({ status: 'closed' });
  }

  /** Every action returns whether it actually reached the server. */
  setReady(ready: boolean): boolean {
    return this.send({ type: 'SET_READY', ready });
  }

  submitAnswer(guess: string): boolean {
    return this.send({ type: 'SUBMIT_ANSWER', guess });
  }

  hostStart(): boolean {
    return this.sendHost('HOST_START');
  }

  hostPause(): boolean {
    return this.sendHost('HOST_PAUSE');
  }

  hostResume(): boolean {
    return this.sendHost('HOST_RESUME');
  }

  hostSkip(): boolean {
    return this.sendHost('HOST_SKIP');
  }

  // --- Internals -----------------------------------------------------------

  private openSocket(): void {
    this.update({ status: this.playerToken === null ? 'connecting' : 'reconnecting' });

    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    this.socketOpen = false;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.socketOpen = true;
      // A stored token identifies the player; a nickname only creates one. The
      // token path must win, or a refresh would produce a duplicate roster slot
      // and reset the score (analysis §5).
      //
      // The host token rides along on both. The server seats the host from it
      // rather than from join order, so a client that held it back would leave
      // the room hostless — and in a YouTube game that means no `ROUND_CUE` and
      // therefore no music.
      const claim = this.hostClaim();
      if (this.playerToken !== null) {
        this.send({ type: 'REJOIN', roomId: this.options.roomId, playerToken: this.playerToken, ...claim }, socket);
      } else {
        this.send(
          { type: 'JOIN_ROOM', roomId: this.options.roomId, nickname: this.options.nickname ?? '', ...claim },
          socket,
        );
      }
    });

    socket.addEventListener('message', (event: SocketMessageEvent) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.socketOpen = false;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows, and it is the event that carries the retry.
    });
  }

  private receive(message: ServerMessage): void {
    if (message.type === 'ROOM_STATE') {
      // The backoff resets here rather than on socket 'open', because a socket
      // that opens and is dropped again has not proved anything. Resetting on
      // 'open' turns a flapping connection into a 500 ms retry loop.
      this.attempt = 0;
      if (message.playerToken !== this.playerToken) {
        this.playerToken = message.playerToken;
        this.options.onToken?.(message.playerToken);
      }
    }
    this.state = applyServerMessage(this.state, message, this.now());
    this.options.onEvent?.(message);
    this.emit();
  }

  private scheduleReconnect(): void {
    // A room that refused us, or a session the server has forgotten, will
    // refuse us again just as fast. Retrying those is a spin loop, not
    // resilience.
    const fatal =
      this.state.error !== null &&
      (this.state.error.reason === 'ROOM_NOT_FOUND' || this.state.error.reason === 'UNKNOWN_SESSION');

    if (this.stopped || this.reconnectOptions === false || this.playerToken === null || fatal) {
      this.update({ status: 'closed' });
      return;
    }

    if (this.attempt >= this.reconnectOptions.maxAttempts) {
      this.update({ status: 'closed' });
      return;
    }

    const delay = Math.min(
      this.reconnectOptions.maxDelayMs,
      this.reconnectOptions.baseDelayMs * 2 ** this.attempt,
    );
    this.attempt += 1;
    this.update({ status: 'reconnecting' });
    this.schedule(() => {
      if (!this.stopped && this.socket === null) this.openSocket();
    }, delay);
  }

  private sendHost(type: 'HOST_START' | 'HOST_PAUSE' | 'HOST_RESUME' | 'HOST_SKIP'): boolean {
    const hostToken = this.options.hostToken;
    if (typeof hostToken !== 'string' || hostToken.length === 0) return false;
    return this.send({ type, hostToken });
  }

  /**
   * The `hostToken` field for a join, or nothing at all when there is no token.
   *
   * Spread into the message rather than assigned, so a client without one sends
   * a frame with no `hostToken` key — the same frame it sent before this field
   * existed, rather than one carrying an explicit empty claim.
   */
  private hostClaim(): { hostToken?: string } {
    const hostToken = this.options.hostToken;
    if (typeof hostToken !== 'string' || hostToken.length === 0) return {};
    return { hostToken };
  }

  /**
   * Returns false rather than throwing when the socket cannot take the message.
   *
   * Dropping is the right failure here, not queueing: this is a real-time game,
   * and an answer delivered after the reconnect completes would be judged
   * against whatever round is running by then. Callers surface the false.
   */
  private send(message: ClientMessage, socket: ProtocolSocket | null = this.socket): boolean {
    if (socket === null || (socket === this.socket && !this.socketOpen)) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private update(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
