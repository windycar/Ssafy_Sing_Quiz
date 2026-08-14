/**
 * Wire protocol types.
 *
 * Direct transcription of `docs/realtime-protocol.md` §1–§3. If this file and
 * that document ever disagree, the document is the specification and this file
 * is the bug.
 */

import type { GameMode, QuestionPublicInfo, QuestionRevealInfo } from '../shared/questions.ts';

export type { GameMode, QuestionPublicInfo, QuestionRevealInfo };

export type RoomId = string;
export type PlayerId = string;
/** Opaque secret proving a player's identity across reconnects. */
export type PlayerToken = string;
/** Opaque secret proving host authority. Never shared with players. */
export type HostToken = string;

export type RoomPhase = 'LOBBY' | 'COUNTDOWN' | 'IN_ROUND' | 'REVEAL' | 'FINISHED';

export interface PlayerSummary {
  id: PlayerId;
  nickname: string;
  connected: boolean;
  ready: boolean;
  score: number;
}

/**
 * Sent to clients during play. Deliberately carries no answer information.
 *
 * Superseded by `QuestionPublicInfo`, which says the same thing without
 * assuming the question is a song. Still populated in every mode so a client
 * written against the song-only protocol keeps rendering the progress counter.
 */
export interface SongPublicInfo {
  index: number;
  totalSongs: number;
  clipDurationMs: number;
}

/**
 * Only ever sent at REVEAL.
 *
 * Superseded by `QuestionRevealInfo`. In a text mode `title` carries the full
 * proverb or the idiom and `artist` is empty, so an older client still shows
 * something true rather than nothing.
 */
export interface SongRevealInfo {
  title: string;
  artist: string;
}

export interface LeaderboardEntry {
  playerId: PlayerId;
  nickname: string;
  score: number;
  /** 1-based. Standard competition ranking: equal scores share a rank. */
  rank: number;
}

export interface RoundPublicState {
  /**
   * The mode-neutral view of the question: index, total, and the text clue for
   * a proverb or idiom round. Never the answer — see `toQuestionPublic`.
   */
  question: QuestionPublicInfo;
  /** Superseded by `question`. Populated in every mode; see `SongPublicInfo`. */
  song: SongPublicInfo;
  /** Always empty outside song mode: a text round has nothing to play. */
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number;
  deadline: number;
  paused: boolean;
  pausedAt: number | null;
  /** True while the round is frozen because the host's socket dropped. */
  hostAway: boolean;
  /**
   * When the server stops waiting for an absent host, or null when it is not
   * waiting for one. See `RoundPausedMessage.hostGraceEndsAt`.
   */
  hostGraceEndsAt: number | null;
  /** See `RoundStartMessage.livePlayback`. */
  livePlayback: boolean;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface JoinRoomMessage {
  type: 'JOIN_ROOM';
  roomId: RoomId;
  nickname: string;
  /**
   * Present only on the host's own client, which holds the token from room
   * creation. This is what makes the joining player the host — join order does
   * not, or an invited friend arriving first would take the room over.
   */
  hostToken?: HostToken;
}

export interface RejoinMessage {
  type: 'REJOIN';
  roomId: RoomId;
  playerToken: PlayerToken;
  /** Same claim as `JoinRoomMessage.hostToken`, for a session already seated. */
  hostToken?: HostToken;
}

export interface SetReadyMessage {
  type: 'SET_READY';
  ready: boolean;
}

export interface SubmitAnswerMessage {
  type: 'SUBMIT_ANSWER';
  guess: string;
}

export interface HostStartMessage {
  type: 'HOST_START';
  hostToken: HostToken;
}

export interface HostPauseMessage {
  type: 'HOST_PAUSE';
  hostToken: HostToken;
}

export interface HostResumeMessage {
  type: 'HOST_RESUME';
  hostToken: HostToken;
}

export interface HostSkipMessage {
  type: 'HOST_SKIP';
  hostToken: HostToken;
}

/**
 * Ends the game now and shows the standings as final.
 *
 * `HOST_SKIP` drops one question; this drops all the remaining ones. A default
 * room is 160 questions and roughly two and a half hours, so a host who has run
 * out of evening needs a way to stop that is not "close the laptop" — that
 * would leave the room paused on an absent host and everyone without a result.
 * Whatever has been scored stands, and `GAME_OVER` reports it.
 */
export interface HostEndMessage {
  type: 'HOST_END';
  hostToken: HostToken;
}

export type ClientMessage =
  | JoinRoomMessage
  | RejoinMessage
  | SetReadyMessage
  | SubmitAnswerMessage
  | HostStartMessage
  | HostPauseMessage
  | HostResumeMessage
  | HostSkipMessage
  | HostEndMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** How many questions of one kind a room will play. */
export interface SectionSummary {
  mode: GameMode;
  count: number;
}

export interface RoomStateMessage {
  type: 'ROOM_STATE';
  phase: RoomPhase;
  /**
   * The kind of question on screen, or next up between rounds.
   *
   * Not a property of the room: one game plays songs, then proverbs, then
   * idioms. This says where in that run the room is, so a client with no round
   * yet still has something to render.
   */
  mode: GameMode;
  /**
   * What the room will play, in order: e.g. 100 songs, 30 proverbs, 30 idioms.
   * The lobby shows this so players know what they are in for.
   */
  sections: SectionSummary[];
  /** How many questions the room will play in total, across every section. */
  totalQuestions: number;
  players: PlayerSummary[];
  isHost: boolean;
  playerToken: PlayerToken;
  playerId: PlayerId;
  song?: SongPublicInfo;
  round?: RoundPublicState;
  leaderboard: LeaderboardEntry[];
  /** True when this player already had their guess resolved this round. */
  answeredThisRound?: boolean;
}

export interface PlayerJoinedMessage {
  type: 'PLAYER_JOINED';
  player: PlayerSummary;
}

export interface PlayerLeftMessage {
  type: 'PLAYER_LEFT';
  playerId: PlayerId;
}

export interface PlayerConnectionChangedMessage {
  type: 'PLAYER_CONNECTION_CHANGED';
  playerId: PlayerId;
  connected: boolean;
}

export interface PlayerReadyChangedMessage {
  type: 'PLAYER_READY_CHANGED';
  playerId: PlayerId;
  ready: boolean;
}

export interface CountdownStartedMessage {
  type: 'COUNTDOWN_STARTED';
  startsAt: number;
}

export interface RoundStartMessage {
  type: 'ROUND_START';
  /**
   * The mode-neutral question: which one this is, how many there are, and the
   * proverb prefix or idiom meaning to put on screen. Never the answer.
   */
  question: QuestionPublicInfo;
  /** Superseded by `question`. Populated in every mode; see `SongPublicInfo`. */
  song: SongPublicInfo;
  /** Always empty outside song mode: a text round has nothing to play. */
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number;
  deadline: number;
  /**
   * True when the host is playing the song in the room. Every other client
   * plays nothing — there is no `mediaUrl` for them to play. Always false in a
   * text mode.
   */
  livePlayback: boolean;
}

/**
 * What to play, sent to the host alone.
 *
 * Separate from `ROUND_START` because a YouTube video's title names the song:
 * broadcasting the id would broadcast the answer. This is the only message
 * that carries it, and `GameRoom` addresses it to `hostPlayerId` only.
 */
export interface RoundCueMessage {
  type: 'ROUND_CUE';
  youtubeId: string;
  startMs: number;
  /** How long to play before the answer window closes. */
  playMs: number;
}

export interface RoundPausedMessage {
  type: 'ROUND_PAUSED';
  pausedAt: number;
  /**
   * True when the server paused on its own because the host's socket dropped,
   * false when the host pressed pause. A client shows a different thing for
   * each: one is an outage, the other is somebody taking a break.
   */
  hostAway?: boolean;
  /**
   * When the server stops waiting for the host, present only alongside
   * `hostAway`. At that moment the round either resumes without a host or, if
   * the host's device is the only source of the music, the game ends — see
   * `GameRoom.resolveHostAbsence`. Sent so a client can count it down rather
   * than leave players staring at a frozen screen.
   */
  hostGraceEndsAt?: number;
}

export interface RoundResumedMessage {
  type: 'ROUND_RESUMED';
  newDeadline: number;
}

export interface AnswerAcceptedMessage {
  type: 'ANSWER_ACCEPTED';
  pointsAwarded: number;
  /**
   * Where this player came in on this round: 1 in a song round, 1–3 in a
   * proverb or idiom round. How many places a mode has is the server's to
   * decide; a client renders whatever it is told.
   */
  place: number;
}

export interface AnswerRejectedMessage {
  type: 'ANSWER_REJECTED';
  guess: string;
}

/**
 * Sent to a player whose guess arrived after the round was already won.
 * Carries no verdict — telling a late player "you were right" would leak the
 * answer before REVEAL (analysis §4).
 */
export interface AnswerTooLateMessage {
  type: 'ANSWER_TOO_LATE';
}

/** One player who answered correctly, and where they came in. */
export interface RoundScorer {
  playerId: PlayerId;
  nickname: string;
  place: number;
  pointsAwarded: number;
}

export interface RoundRevealMessage {
  type: 'ROUND_REVEAL';
  /**
   * The answer, in whichever shape this mode has one: song title and artist,
   * the full proverb plus the half that was missing, or the four syllables
   * plus their meaning and Hanja. This is the first message in a round that is
   * allowed to carry any of it.
   */
  answer: QuestionRevealInfo;
  /** Superseded by `answer`. Populated in every mode; see `SongRevealInfo`. */
  song: SongRevealInfo;
  /**
   * First place, or null when nobody got it. Kept alongside `scorers` because
   * every screen highlights the winner and most show nothing else.
   */
  winner: { playerId: PlayerId; nickname: string } | null;
  /** Everyone who scored, in the order they answered. Empty if nobody did. */
  scorers: RoundScorer[];
  leaderboard: LeaderboardEntry[];
}

export interface LeaderboardUpdateMessage {
  type: 'LEADERBOARD_UPDATE';
  topFive: LeaderboardEntry[];
  you: LeaderboardEntry;
}

export interface GameOverMessage {
  type: 'GAME_OVER';
  finalRanks: LeaderboardEntry[];
}

export type ErrorReason =
  | 'ROOM_NOT_FOUND'
  | 'GAME_ALREADY_STARTED'
  | 'INVALID_NICKNAME'
  | 'ROOM_FULL'
  | 'UNKNOWN_SESSION'
  | 'NOT_HOST'
  | 'WRONG_PHASE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'NOT_JOINED'
  | 'MALFORMED_MESSAGE';

export interface ErrorMessage {
  type: 'ERROR';
  reason: ErrorReason;
  message: string;
}

export type ServerMessage =
  | RoomStateMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerConnectionChangedMessage
  | PlayerReadyChangedMessage
  | CountdownStartedMessage
  | RoundStartMessage
  | RoundCueMessage
  | RoundPausedMessage
  | RoundResumedMessage
  | AnswerAcceptedMessage
  | AnswerRejectedMessage
  | AnswerTooLateMessage
  | RoundRevealMessage
  | LeaderboardUpdateMessage
  | GameOverMessage
  | ErrorMessage;

/**
 * What the engine wants the transport to do. Keeping this as data (rather than
 * letting the engine hold sockets) is what makes every rule in the transition
 * table unit-testable without a network.
 */
export type Effect =
  | { kind: 'send'; to: PlayerId; message: ServerMessage }
  | { kind: 'broadcast'; message: ServerMessage }
  /** Close this player's socket after delivering pending messages. */
  | { kind: 'disconnect'; to: PlayerId };

/** Parses and validates an incoming frame. Returns null if unusable. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;
  const isString = (key: string): boolean => typeof candidate[key] === 'string';
  // Absent is the normal case — only the host's own client sends one — but a
  // present-and-not-a-string value is a malformed frame, not an absent claim.
  const isOptionalString = (key: string): boolean => candidate[key] === undefined || isString(key);

  switch (candidate['type']) {
    case 'JOIN_ROOM':
      return isString('roomId') && isString('nickname') && isOptionalString('hostToken')
        ? (candidate as unknown as JoinRoomMessage)
        : null;
    case 'REJOIN':
      return isString('roomId') && isString('playerToken') && isOptionalString('hostToken')
        ? (candidate as unknown as RejoinMessage)
        : null;
    case 'SET_READY':
      return typeof candidate['ready'] === 'boolean' ? (candidate as unknown as SetReadyMessage) : null;
    case 'SUBMIT_ANSWER':
      return isString('guess') ? (candidate as unknown as SubmitAnswerMessage) : null;
    case 'HOST_START':
    case 'HOST_PAUSE':
    case 'HOST_RESUME':
    case 'HOST_SKIP':
    case 'HOST_END':
      return isString('hostToken') ? (candidate as unknown as ClientMessage) : null;
    default:
      return null;
  }
}
