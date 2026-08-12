# Real-time protocol — Korean song-guessing game

Companion to [`claude-analysis.md`](./claude-analysis.md). This document
defines the concrete WebSocket message shapes and the server's deterministic
state-transition rules, precisely enough to implement without further design
decisions. Types are illustrative TypeScript — the implementing agent may
adapt naming/module layout but should preserve the fields and semantics.

All messages are JSON objects with a `type` discriminant. Transport
(WebSocket vs. Socket.IO, etc.) is an implementation choice; this document
only specifies payload shape and ordering/authority rules.

## 1. Shared types

```ts
type RoomId = string;   // unguessable, shareable in the room link
type PlayerId = string; // server-assigned, stable for the player's session
type PlayerToken = string; // opaque, secret; proves identity for reconnect
type HostToken = string;   // opaque, secret; proves host authority

type RoomPhase =
  | 'LOBBY'
  | 'COUNTDOWN'
  | 'IN_ROUND'
  | 'REVEAL'
  | 'FINISHED';

interface PlayerSummary {
  id: PlayerId;
  nickname: string;
  connected: boolean;
  ready: boolean; // meaningful only in LOBBY
  score: number;
}

/** Sent to clients; never includes aliases or the raw answer. */
interface SongPublicInfo {
  index: number;      // 0-based position in the room's song list
  totalSongs: number;
  clipDurationMs: number; // clipEnd - clipStart, informational for UI
}

/** Revealed only at REVEAL time. */
interface SongRevealInfo {
  title: string;
  artist: string;
}

/** Server-side only; never sent to clients before REVEAL. */
interface SongConfig {
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  title: string;
  artist: string;
  aliases: string[];
}

interface LeaderboardEntry {
  playerId: PlayerId;
  nickname: string;
  score: number;
  rank: number; // 1-based, ties share a rank per §5
}
```

## 2. Client → server messages

| `type`            | Sent by | Valid phases           | Payload |
| ------------------ | ------- | ----------------------- | ------- |
| `JOIN_ROOM`         | player  | `LOBBY`                 | `{ type: 'JOIN_ROOM'; roomId: RoomId; nickname: string }` |
| `REJOIN`            | player/host | any                  | `{ type: 'REJOIN'; roomId: RoomId; playerToken: PlayerToken }` |
| `SET_READY`         | player  | `LOBBY`                 | `{ type: 'SET_READY'; ready: boolean }` |
| `SUBMIT_ANSWER`     | player  | `IN_ROUND`               | `{ type: 'SUBMIT_ANSWER'; guess: string }` |
| `HOST_START`        | host    | `LOBBY`                 | `{ type: 'HOST_START'; hostToken: HostToken }` |
| `HOST_PAUSE`        | host    | `IN_ROUND` (not paused)  | `{ type: 'HOST_PAUSE'; hostToken: HostToken }` |
| `HOST_RESUME`       | host    | `IN_ROUND` (paused)      | `{ type: 'HOST_RESUME'; hostToken: HostToken }` |
| `HOST_SKIP`         | host    | `IN_ROUND` (any pause state) | `{ type: 'HOST_SKIP'; hostToken: HostToken }` |

Notes:

- `JOIN_ROOM` is only valid pre-game (`LOBBY`); joining mid-game is not
  supported by the product summary (players "choose nicknames and ready up"
  before play). A client connecting during `COUNTDOWN`/`IN_ROUND`/`REVEAL`
  without a `playerToken` should be rejected with `ERROR` (`reason:
  'GAME_ALREADY_STARTED'`); connecting with a valid, previously-issued
  token uses `REJOIN` instead.
- Every message the server receives is authorized independently — a stale
  or mismatched `hostToken`/`playerToken` is rejected with `ERROR`, it is
  never inferred from "whoever is currently connected."
- The server ignores (silently no-ops, does not error) actions that are
  syntactically valid but phase-inappropriate for a *player* action arriving
  slightly late due to network lag — e.g. a `SUBMIT_ANSWER` that arrives
  just after the round already transitioned to `REVEAL`. Host actions
  outside their valid phase get an explicit `ERROR` instead, since those are
  deliberate UI actions, not a race the host should have to fight.

## 3. Server → client messages

| `type`               | Broadcast or private | Payload |
| --------------------- | --------------------- | ------- |
| `ROOM_STATE`           | to (re)joining client | `{ type: 'ROOM_STATE'; phase: RoomPhase; players: PlayerSummary[]; isHost: boolean; playerToken: PlayerToken; song?: SongPublicInfo; round?: RoundPublicState; leaderboard: LeaderboardEntry[] }` |
| `PLAYER_JOINED`        | broadcast              | `{ type: 'PLAYER_JOINED'; player: PlayerSummary }` |
| `PLAYER_LEFT`          | broadcast              | `{ type: 'PLAYER_LEFT'; playerId: PlayerId }` (grace period expired; see analysis §6) |
| `PLAYER_CONNECTION_CHANGED` | broadcast         | `{ type: 'PLAYER_CONNECTION_CHANGED'; playerId: PlayerId; connected: boolean }` |
| `PLAYER_READY_CHANGED` | broadcast              | `{ type: 'PLAYER_READY_CHANGED'; playerId: PlayerId; ready: boolean }` |
| `ROUND_START`          | broadcast              | `{ type: 'ROUND_START'; song: SongPublicInfo; mediaUrl: string; clipStartMs: number; clipEndMs: number; serverStartedAt: number; deadline: number }` |
| `ROUND_PAUSED`         | broadcast              | `{ type: 'ROUND_PAUSED'; pausedAt: number }` |
| `ROUND_RESUMED`        | broadcast              | `{ type: 'ROUND_RESUMED'; newDeadline: number }` |
| `ANSWER_ACCEPTED`      | private, to winner     | `{ type: 'ANSWER_ACCEPTED'; pointsAwarded: number }` |
| `ANSWER_REJECTED`      | private, to sender     | `{ type: 'ANSWER_REJECTED'; guess: string }` |
| `ROUND_REVEAL`         | broadcast              | `{ type: 'ROUND_REVEAL'; song: SongRevealInfo; winner: { playerId: PlayerId; nickname: string } \| null; leaderboard: LeaderboardEntry[] }` |
| `LEADERBOARD_UPDATE`   | broadcast              | `{ type: 'LEADERBOARD_UPDATE'; topFive: LeaderboardEntry[]; you: LeaderboardEntry }` (see §6 — per-connection payload) |
| `GAME_OVER`            | broadcast              | `{ type: 'GAME_OVER'; finalRanks: LeaderboardEntry[] }` (all 1–20, per product spec) |
| `ERROR`                | private, to sender     | `{ type: 'ERROR'; reason: string; message: string }` |

```ts
interface RoundPublicState {
  song: SongPublicInfo;
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  serverStartedAt: number; // epoch ms, server clock
  deadline: number;        // epoch ms, server clock; extended on resume
  paused: boolean;
  pausedAt: number | null;
}
```

`LEADERBOARD_UPDATE` is described as broadcast in the table for brevity, but
per the product requirement ("top five plus the current player's own rank")
its payload differs *per recipient* — the server computes `topFive` once per
update and then sends each connected player their own `you` entry alongside
it, rather than one identical message to everyone.

## 4. Deterministic phase transition table

State lives entirely on the server; clients only render what they're told.
Each row is `(current phase, trigger) -> (next phase, server action)`.

| Current phase | Trigger | Next phase | Server action |
| -------------- | ------- | ---------- | -------------- |
| `LOBBY` | `HOST_START` | `COUNTDOWN` | Validate `hostToken`; if fewer than 1 player, reject with `ERROR('NOT_ENOUGH_PLAYERS')` instead of transitioning. |
| `COUNTDOWN` | fixed timer elapses (e.g. 3000ms, not host-configurable) | `IN_ROUND` | Load first `SongConfig`, build `AliasMatcher` via `createAliasMatcher(song.aliases)`, broadcast `ROUND_START` with `deadline = now + (clipEndMs - clipStartMs) + ANSWER_GRACE_MS`. |
| `IN_ROUND` | `SUBMIT_ANSWER` matches (see analysis §4) | `REVEAL` | Set `round.winnerId`, award points, broadcast `ANSWER_ACCEPTED` to winner, broadcast `ROUND_REVEAL` with winner set. |
| `IN_ROUND` | deadline reached with no winner | `REVEAL` | Broadcast `ROUND_REVEAL` with `winner: null`. |
| `IN_ROUND` | `HOST_SKIP` | `REVEAL` | Same as timeout path — treat skip as an immediate, host-triggered timeout (winner is whatever was already locked in, if any race with a just-arrived correct answer is resolved by processing order, not skip priority). |
| `IN_ROUND` (not paused) | `HOST_PAUSE` | `IN_ROUND` (paused) | Clear the deadline timer, record `pausedAt = now`, broadcast `ROUND_PAUSED`. Guesses are ignored while paused (see §2). |
| `IN_ROUND` (paused) | `HOST_RESUME` | `IN_ROUND` (not paused) | `deadline += now - pausedAt`; reschedule the deadline timer; broadcast `ROUND_RESUMED`. |
| `REVEAL` | fixed timer elapses (e.g. 4000ms) | `IN_ROUND` (next song) or `FINISHED` | If more songs remain: advance `song.index`, repeat the `COUNTDOWN`→`IN_ROUND` setup (this table folds the brief COUNTDOWN into this step for brevity — implementer may reintroduce an explicit COUNTDOWN broadcast here). If this was the last song: compute `finalRanks`, broadcast `GAME_OVER`. |
| `FINISHED` | — | — | Terminal. Room accepts `REJOIN` (read-only) until garbage-collected per analysis §8; no further phase transitions. |

Invariants the implementation must preserve:

1. **Only the server initiates phase transitions.** No client message
   directly sets `phase`; every transition above is triggered either by a
   validated host message or a server-owned timer.
2. **A round can only be won once.** `round.winnerId` is set synchronously
   within the message handler that validates the winning guess (analysis
   §4); every subsequent `SUBMIT_ANSWER` in that round — including ones
   already in flight when the winner was decided — is evaluated against
   `winnerId !== null` and rejected.
3. **Pausing preserves elapsed answer-window time exactly**: the
   `deadline += now - pausedAt` rule in the table is the only place round
   time is adjusted, so pause/resume cycles never shorten or lengthen the
   configured 5–15s window, only suspend it.
4. **`ERROR` never reveals more than necessary** — e.g. rejecting a
   mistimed `SUBMIT_ANSWER` should not accidentally include the correct
   answer or alias list in the payload.

## 5. Leaderboard and rank computation

- Score: +100 per round won (analysis §4's documented default; adjust here
  if the implementer changes the scoring model — this is the single source
  of truth for that constant).
- Rank: sort players by `score` descending; players with equal scores share
  the same `rank` (standard competition ranking, e.g. scores `[300, 200,
  200, 100]` → ranks `[1, 2, 2, 4]`), consistent with analysis §3's
  tie-breaking note being flagged as a default, not a hard requirement.
- `topFive` = the first 5 entries of the sorted list.
- `you` = the requesting player's own `LeaderboardEntry`, always included
  even if outside the top 5, per the product requirement.
- `GAME_OVER.finalRanks` includes all players who were part of the roster
  at game end (up to 20), not just those currently connected — a
  disconnected-but-within-grace-period player still gets a final rank.

## 6. Example message sequence (happy path, single round)

```
player -> server : JOIN_ROOM { roomId, nickname: "동철" }
server -> player : ROOM_STATE { phase: 'LOBBY', players: [...], isHost: false, playerToken, leaderboard: [] }
server -> *      : PLAYER_JOINED { player }

player -> server : SET_READY { ready: true }
server -> *      : PLAYER_READY_CHANGED { playerId, ready: true }

host   -> server : HOST_START { hostToken }
server -> *      : (phase becomes COUNTDOWN; implementer may broadcast an explicit ROUND_COUNTDOWN message, not detailed above)
server -> *      : ROUND_START { song, mediaUrl, clipStartMs, clipEndMs, serverStartedAt, deadline }

player -> server : SUBMIT_ANSWER { guess: "다이나마이트" }
server -> player : ANSWER_ACCEPTED { pointsAwarded: 100 }
server -> *      : ROUND_REVEAL { song: { title, artist }, winner: { playerId, nickname }, leaderboard }
server -> each   : LEADERBOARD_UPDATE { topFive, you } // per-recipient payload, see §3

... REVEAL timer elapses, next ROUND_START, or GAME_OVER if no songs remain ...
```
