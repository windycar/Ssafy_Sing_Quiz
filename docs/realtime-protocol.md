# Real-time protocol — Korean quiz game

Companion to [`claude-analysis.md`](./claude-analysis.md). This document
defines the concrete WebSocket message shapes and the server's deterministic
state-transition rules, precisely enough to implement without further design
decisions. Types are illustrative TypeScript — the implementing agent may
adapt naming/module layout but should preserve the fields and semantics.

**Modes.** A room plays one of `song | proverb | idiom`, fixed before
`HOST_START` and reported on every `ROOM_STATE`. The three differ only in what
the clue is, how long a round lasts, and how many players may score it; every
rule below — authority, reconnect, pause accounting, ranking — is identical in
all three. The implementation reflects that: one engine, one `Question` type
(`shared/questions.ts`), and one redacting function per direction.

The `song`-named fields (`SongPublicInfo`, `ROUND_START.song`,
`ROUND_REVEAL.song`) predate the other two modes. They are still populated in
every mode so an older client keeps working, but the mode-neutral `question`
and `answer` fields are the ones to read.

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

type GameMode = 'song' | 'proverb' | 'idiom';

/** Sent to clients; never includes aliases or the raw answer. */
interface QuestionPublicInfo {
  mode: GameMode;
  index: number;          // 0-based position in the room's question list
  totalQuestions: number;
  durationMs: number;     // the answer window, informational for UI
  /**
   * The proverb prefix or the idiom's meaning. Null in song mode, where the
   * clue is the audio rather than text.
   */
  clue: string | null;
}

/** Revealed only at REVEAL time. */
interface QuestionRevealInfo {
  mode: GameMode;
  answer: string;         // song title, whole proverb, or the four syllables
  artist: string | null;  // song only
  detail: string | null;  // proverb: the missing suffix. idiom: its meaning
  clue: string | null;    // proverb: the prefix that was on screen
  hanja: string | null;   // idiom only
  explanation: string | null;
}

/** Superseded by the two above; still populated in every mode. */
interface SongPublicInfo {
  index: number;
  totalSongs: number;     // = totalQuestions
  clipDurationMs: number; // = durationMs
}

interface SongRevealInfo {
  title: string;          // = QuestionRevealInfo.answer
  artist: string;         // empty outside song mode
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
| `ROUND_START`          | broadcast              | `{ type: 'ROUND_START'; question: QuestionPublicInfo; song: SongPublicInfo; mediaUrl: string; clipStartMs: number; clipEndMs: number; serverStartedAt: number; deadline: number; livePlayback: boolean }`. In a text mode `mediaUrl` is `''` and `livePlayback` is false. |
| `ROUND_PAUSED`         | broadcast              | `{ type: 'ROUND_PAUSED'; pausedAt: number }` |
| `ROUND_RESUMED`        | broadcast              | `{ type: 'ROUND_RESUMED'; newDeadline: number }` |
| `ANSWER_ACCEPTED`      | private, to winner     | `{ type: 'ANSWER_ACCEPTED'; pointsAwarded: number }` |
| `ANSWER_REJECTED`      | private, to sender     | `{ type: 'ANSWER_REJECTED'; guess: string }` |
| `ROUND_REVEAL`         | broadcast              | `{ type: 'ROUND_REVEAL'; answer: QuestionRevealInfo; song: SongRevealInfo; winner: { playerId: PlayerId; nickname: string } \| null; scorers: RoundScorer[]; leaderboard: LeaderboardEntry[] }` — the first message in a round allowed to carry any part of the answer |
| `LEADERBOARD_UPDATE`   | broadcast              | `{ type: 'LEADERBOARD_UPDATE'; topFive: LeaderboardEntry[]; you: LeaderboardEntry }` (see §6 — per-connection payload) |
| `GAME_OVER`            | broadcast              | `{ type: 'GAME_OVER'; finalRanks: LeaderboardEntry[] }` (all 1–20, per product spec) |
| `ERROR`                | private, to sender     | `{ type: 'ERROR'; reason: string; message: string }` |

```ts
interface RoundPublicState {
  question: QuestionPublicInfo;
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
| `COUNTDOWN` | fixed timer elapses (e.g. 3000ms, not host-configurable) | `IN_ROUND` | Load the next `Question`, build `AliasMatcher` via `createAliasMatcher(question.aliases)`, broadcast `ROUND_START`. `deadline = now + (clipEndMs - clipStartMs) + ANSWER_GRACE_MS` in song mode; `now + TEXT_ROUND_MS` (30 s) in a text mode, where there is no clip to wait for. |
| `IN_ROUND` | `SUBMIT_ANSWER` matches, and a scoring place is free | `IN_ROUND` or `REVEAL` | Append the player to `round.scorers`, award `POINTS_BY_PLACE[mode][place - 1]`, send `ANSWER_ACCEPTED` **to that player only**. If the last place is now taken, resolve: broadcast `ROUND_REVEAL`. Otherwise stay in `IN_ROUND` — nothing is broadcast, so a player still guessing learns nothing. |
| `IN_ROUND` | `SUBMIT_ANSWER` matches, but the player already scored, or every place is taken | `IN_ROUND` | Send `ANSWER_TOO_LATE`, which carries no verdict. No points, and no place is consumed. |
| `IN_ROUND` | deadline reached with fewer scorers than places | `REVEAL` | Broadcast `ROUND_REVEAL` with whoever did score, in order, keeping their points. `winner` is null if nobody did. |
| `IN_ROUND` | `HOST_SKIP` | `REVEAL` | Same as timeout path — treat skip as an immediate, host-triggered timeout (winner is whatever was already locked in, if any race with a just-arrived correct answer is resolved by processing order, not skip priority). |
| `IN_ROUND` (not paused) | `HOST_PAUSE` | `IN_ROUND` (paused) | Clear the deadline timer, record `pausedAt = now`, broadcast `ROUND_PAUSED`. Guesses are ignored while paused (see §2). |
| `IN_ROUND` (paused) | `HOST_RESUME` | `IN_ROUND` (not paused) | `deadline += now - pausedAt`; reschedule the deadline timer; broadcast `ROUND_RESUMED`. |
| `REVEAL` | fixed timer elapses (e.g. 4000ms) | `IN_ROUND` (next question) or `FINISHED` | If more questions remain: advance the index, repeat the `COUNTDOWN`→`IN_ROUND` setup (this table folds the brief COUNTDOWN into this step for brevity — implementer may reintroduce an explicit COUNTDOWN broadcast here). If this was the last one: compute `finalRanks`, broadcast `GAME_OVER`. |
| `FINISHED` | — | — | Terminal. Room accepts `REJOIN` (read-only) until garbage-collected per analysis §8; no further phase transitions. |

Invariants the implementation must preserve:

1. **Only the server initiates phase transitions.** No client message
   directly sets `phase`; every transition above is triggered either by a
   validated host message or a server-owned timer.
2. **A scoring place can only be taken once, and only by a player who has
   not already taken one.** Places are claimed by appending to
   `round.scorers` synchronously inside the handler that validates the guess
   (analysis §4), so two answers arriving on the same millisecond are still
   separated by processing order and can never share a place. Once
   `round.scorers.length` reaches the mode's limit the round is marked
   resolved in the same handler, which is what stops a fourth correct answer
   — including one already in flight — from slipping in behind the third.
3. **Pausing preserves elapsed answer-window time exactly**: the
   `deadline += now - pausedAt` rule in the table is the only place round
   time is adjusted, so pause/resume cycles never shorten or lengthen the
   configured 5–15s window, only suspend it.
4. **`ERROR` never reveals more than necessary** — e.g. rejecting a
   mistimed `SUBMIT_ANSWER` should not accidentally include the correct
   answer or alias list in the payload.

## 5. Leaderboard and rank computation

- Score: **+1 per scoring place**, in every mode. What differs is how many
  places a round has, which is the length of that mode's `POINTS_BY_PLACE`
  entry in `server/gameRoom.ts` — the single source of truth for both numbers:

  | Mode | Places | Why |
  | --- | --- | --- |
  | `song` | 1 | Everyone hears the same clip at once, so the first correct answer is the whole race. |
  | `proverb`, `idiom` | 3 | The clue sits on screen with no audio to wait for; one place would be settled in about two seconds by whoever reads fastest. |

  `scorersPerRound(mode)` is a count of scoring places in one question. It is
  **not** a room size — that is `MAX_PLAYERS` (20), and the two are unrelated.
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
server -> *      : ROUND_START { question, song, mediaUrl, clipStartMs, clipEndMs, serverStartedAt, deadline, livePlayback }

player -> server : SUBMIT_ANSWER { guess: "다이나마이트" }
server -> player : ANSWER_ACCEPTED { pointsAwarded: 1, place: 1 }   // to that player alone
server -> *      : ROUND_REVEAL { answer, song, winner, scorers, leaderboard }
server -> each   : LEADERBOARD_UPDATE { topFive, you } // per-recipient payload, see §3

... REVEAL timer elapses, next ROUND_START, or GAME_OVER if no questions remain ...
```

In a proverb or idiom room the middle of that exchange has three steps rather
than one, and only the last of them resolves the round:

```
server -> *      : ROUND_START { question: { mode: 'proverb', index: 4, totalQuestions: 30, clue: "가는 말이 고와야", ... }, ... }

player A -> server : SUBMIT_ANSWER { guess: "오는 말이 곱다" }
server   -> A      : ANSWER_ACCEPTED { pointsAwarded: 1, place: 1 }   // round stays IN_ROUND
player B -> server : SUBMIT_ANSWER { guess: "가는 말이 고와야 오는 말이 곱다" }
server   -> B      : ANSWER_ACCEPTED { pointsAwarded: 1, place: 2 }   // still IN_ROUND
player C -> server : SUBMIT_ANSWER { guess: "오는말이곱다" }
server   -> C      : ANSWER_ACCEPTED { pointsAwarded: 1, place: 3 }   // last place taken
server   -> *      : ROUND_REVEAL { answer: { answer: "가는 말이 고와야 오는 말이 곱다", detail: "오는 말이 곱다", clue: "가는 말이 고와야", ... }, scorers: [A, B, C], ... }

player D -> server : SUBMIT_ANSWER { guess: "오는 말이 곱다" }
server   -> D      : ANSWER_TOO_LATE                                   // no verdict, no points
```
