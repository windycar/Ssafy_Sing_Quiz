/**
 * Wire protocol types.
 *
 * Direct transcription of `docs/realtime-protocol.md` §1–§3. If this file and
 * that document ever disagree, the document is the specification and this file
 * is the bug.
 */

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

/** Sent to clients during play. Deliberately carries no answer information. */
export interface SongPublicInfo {
  index: number;
  totalSongs: number;
  clipDurationMs: number;
}

/** Only ever sent at REVEAL. */
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
  song: SongPublicInfo;
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number;
  deadline: number;
  paused: boolean;
  pausedAt: number | null;
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
}

export interface RejoinMessage {
  type: 'REJOIN';
  roomId: RoomId;
  playerToken: PlayerToken;
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

export type ClientMessage =
  | JoinRoomMessage
  | RejoinMessage
  | SetReadyMessage
  | SubmitAnswerMessage
  | HostStartMessage
  | HostPauseMessage
  | HostResumeMessage
  | HostSkipMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface RoomStateMessage {
  type: 'ROOM_STATE';
  phase: RoomPhase;
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
  song: SongPublicInfo;
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number;
  deadline: number;
  /**
   * True when the host is playing the song in the room. Every other client
   * plays nothing — there is no `mediaUrl` for them to play.
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
}

export interface RoundResumedMessage {
  type: 'ROUND_RESUMED';
  newDeadline: number;
}

export interface AnswerAcceptedMessage {
  type: 'ANSWER_ACCEPTED';
  pointsAwarded: number;
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

export interface RoundRevealMessage {
  type: 'ROUND_REVEAL';
  song: SongRevealInfo;
  winner: { playerId: PlayerId; nickname: string } | null;
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

  switch (candidate['type']) {
    case 'JOIN_ROOM':
      return isString('roomId') && isString('nickname') ? (candidate as unknown as JoinRoomMessage) : null;
    case 'REJOIN':
      return isString('roomId') && isString('playerToken') ? (candidate as unknown as RejoinMessage) : null;
    case 'SET_READY':
      return typeof candidate['ready'] === 'boolean' ? (candidate as unknown as SetReadyMessage) : null;
    case 'SUBMIT_ANSWER':
      return isString('guess') ? (candidate as unknown as SubmitAnswerMessage) : null;
    case 'HOST_START':
    case 'HOST_PAUSE':
    case 'HOST_RESUME':
    case 'HOST_SKIP':
      return isString('hostToken') ? (candidate as unknown as ClientMessage) : null;
    default:
      return null;
  }
}
