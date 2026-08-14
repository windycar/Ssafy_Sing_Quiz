# Real-time architecture analysis — Korean song-guessing game

Scope note: this document is analysis and design only. No frontend, server
implementation, or media pipeline is included in this contribution — see
`realtime-protocol.md` for the concrete wire contract the implementing agent
should build against, and `shared/` for the one piece of runtime logic
delivered here (answer normalization/matching), which both server and any
client should import so judging is never ambiguous between them.

Target scale: one host + up to 20 players, desktop browsers, a single room
per game. This is a *small*-scale, single-room-at-a-time concurrency problem,
and the design below deliberately avoids solving problems the product doesn't
have (massive horizontal scale, cross-region consensus, persistence).

## 1. Transport choice

**Recommendation: a single WebSocket connection per client, per room.**

- The game needs low-latency, bidirectional, server-push communication:
  round start/pause/skip, live "someone answered" pings, and reveal all need
  to reach 20 clients within tens of milliseconds of each other for the game
  to feel fair and synchronized.
- Guess submission is latency-sensitive (see §6 on fairness) — a persistent
  socket avoids repeated HTTP handshake/TLS overhead per guess.
- Alternative considered: SSE (server→client) + HTTP POST (client→server
  guesses). This works but adds a second connection, complicates host-control
  acks, and doesn't meaningfully simplify anything at 20 concurrent users.
  Not recommended here.
- 20 concurrent sockets on one room is trivial load for a single Node.js
  process; no connection-pooling or load-balancing concerns at this scale.

## 2. Process/concurrency model

**Recommendation: one room = one authoritative in-memory state object, owned
by exactly one Node.js process for the room's lifetime.**

Node.js's single-threaded event loop means that as long as all messages for
a given room are handled by the same process, message handling for that room
is inherently serialized — there is no race window between two "first
correct answer" checks. This is the single most important correctness
property for §6 and should not be given up for premature horizontal scaling.

- Store rooms in an in-memory `Map<roomId, RoomState>` inside the process.
- If the deployment ever needs multiple server instances (e.g. many
  simultaneous rooms exceeding one process's capacity), route by **sticky
  session on `roomId`** (consistent hashing or a simple gateway lookup) so
  every connection for a room lands on the same instance. Do **not** reach
  for a distributed lock / Redis compare-and-swap for a single room's
  "who answered first" question — that trades a free, already-correct
  guarantee (single-threaded JS) for a much more complex and slower one, for
  no benefit at this scale.
- Room state does not need to survive a process restart for this product
  (casual, short-lived games). Treat in-memory-only as an accepted
  limitation, not a gap to fill (see §8).

## 3. Room lifecycle

Phases: `lobby → round_active ⇄ round_paused → round_reveal → (loop) → finished`

1. **Create**: host requests a new room. Server generates a short, unguessable
   room code (join link) and a separate, higher-entropy host token (host
   link). See §7 for why these must not have the same entropy/exposure.
2. **Lobby**: players open the join link, pick a nickname (server
   deduplicates collisions, e.g. by suffixing `-2`), and toggle ready.
   Nicknames are display-only and never used for identity — identity is the
   session token issued at join (see §5).
3. **Start**: host triggers start once satisfied with the roster (no hard
   "everyone ready" gate is enforced server-side — the host is the sole
   authority on when to begin, per the product spec).
4. **Round loop**: for each configured song, the server broadcasts round
   metadata and clip timing, starts a server-owned countdown, accepts
   guesses, resolves the round (first correct guess, or timeout, or host
   skip), broadcasts the reveal, then advances to the next song. See
   `realtime-protocol.md` for the exact transition table.
5. **Finish**: after the last round's reveal, the server computes final
   standings and broadcasts the podium + full ranked list. The room then
   accepts no further game actions (it may still be joined read-only for
   viewing final results, at the implementer's discretion).

## 4. Authoritative first-answer logic

This is the correctness-critical piece of the whole system.

- Every guess is timestamped by **server receipt time**, never a
  client-reported timestamp. Client clocks and client-reported timestamps
  are untrusted input.
- Each round carries a single mutable `resolved: boolean` flag plus
  `winnerId: string | null` on the server's room state. On receiving a guess
  while `phase === 'round_active'`:
  1. If `resolved === true` already, respond to the sender with a private
     "too late" acknowledgment. Do **not** reveal whether their guess was
     itself correct — see §7 on not leaking the answer early.
  2. Otherwise, normalize the guess with `shared/normalizeAnswer` and check
     it against the round's precomputed accepted-answer set
     (`shared/buildAcceptedAnswers`, built once when the round starts).
  3. If correct: synchronously set `resolved = true`, `winnerId = <player>`,
     record the elapsed time, and transition the round to `round_reveal`.
     Because this happens synchronously within one message handler on a
     single-threaded process (§2), no second "first" winner can ever be
     recorded, regardless of how close in time two correct guesses arrive.
  4. If incorrect: only the guessing player is told "incorrect". Wrong
     guesses are never broadcast to other players — this prevents guess
     copying/piggybacking, which would otherwise be a severe fairness bug in
     a first-correct-answer game.
- Scoring: the product spec does not mandate a formula. Recommend a simple,
  transparent scheme — flat points per round win (e.g. +1), tie-broken by
  total correct answers, then by earliest cumulative answer time — but this
  is a suggestion for the implementing agent, not a requirement of this
  analysis.
- Rate-limit guesses per player per round (e.g. ignore/soft-reject after N
  rapid submissions) to blunt trivial spam/flooding.

## 5. Reconnect handling

- At join, the server issues each player an opaque, random session token
  (128-bit+ entropy) bound to `{roomId, playerId, nickname}` server-side.
  The client persists it in `sessionStorage` (not `localStorage` — a game
  session should not silently resume days later in a different tab context)
  and presents it on reconnect.
- On WebSocket close, the server marks the player `connected: false` but
  **keeps their score and roster slot** — no grace-period deletion. A
  refresh or brief network drop must not cost a player their progress.
- On reconnect, the client sends its stored session token; the server
  matches it to the existing player record, re-attaches the new socket, and
  replies with a full state snapshot: current phase, time remaining in the
  phase, leaderboard, the player's own rank/score, and whether they've
  already answered the current round (so the client doesn't re-prompt for a
  guess it already knows is settled).
- The host holds the same kind of session token plus host privileges bound
  to it. If the host disconnects mid-round, recommend the server
  auto-transitions to `round_paused` (freezing the timer) rather than
  letting the round run with no one able to skip/pause it. If the host
  never returns, there is no automatic remediation in this design — that is
  an accepted limitation for a casual product (see §8), not something to
  solve with e.g. host migration/election, which would add real complexity
  for an edge case in a ~20-player casual game.

  > **Superseded in part.** The pause is still right; "no remediation" was
  > not. A pause with no end is a room locked for good, because `HOST_RESUME`
  > needs the token that left with the host — and in practice the host is a
  > phone that dies or refreshes. The implementation puts a clock on the
  > pause: the host returning inside it resumes automatically, and the clock
  > running out either resumes without them or, where their device was the
  > only source of the music, ends the game on the scores already earned. Host
  > migration is still not in the design, for the reason given above. See
  > `docs/realtime-protocol.md` §3 "An absent host".
  >
  > The same paragraph's premise — that the disconnecting player *is* the
  > host — did not hold either: host was assigned by join order rather than by
  > the token, so an invited player arriving first became the host. It is the
  > token now, on `JOIN_ROOM` and `REJOIN`.

## 6. Fairness limitation (read before treating "first correct" as exact)

"First correct answer" as measured by server receipt time is biased by each
player's network latency to the server, not by who actually knew the answer
first. A player with 20ms RTT will beat a player with 150ms RTT who typed
faster and hit enter earlier in wall-clock time. Additionally, clip playback
itself starts at a slightly different wall-clock moment per client depending
on buffering and the time it takes the `round_started` message to arrive and
audio to begin.

This is a fundamental limitation of any "server broadcasts a cue, clients
play local media, clients type an answer" design, not a bug in this
implementation. Full mitigation (e.g., measuring per-client RTT and applying
a compensating offset, or requiring server-relayed synchronized media
streaming) is disproportionate engineering for a casual 20-player game and is
explicitly **not** attempted here. Documenting it is the deliverable: the
implementing agent and product owner should treat "first correct" as "first
correct as observed by the server," not as a millisecond-perfect reaction
time measurement.

## 7. Security

- **The answer never reaches non-host clients before reveal.** The server
  must never send a round's title/aliases to player clients in the
  `round_started` payload — only clip URL and start/end offsets. Sending the
  answer client-side (even "hidden" in the DOM/JS state) would let any
  player trivially read it via devtools, which defeats the entire
  server-authoritative model.
- **Media URL leakage risk (flagged, not solved here):** if the configured
  media URL is a direct link to a file or third-party page whose filename,
  page title, or metadata names the song, a player can read the answer
  outside the game UI (e.g. a browser tab title, or a filename in a network
  request). This is out of scope for this contribution (no media pipeline
  was built), but the implementing agent should be aware: prefer
  proxying/obfuscating clip URLs or hosting generically-named audio-only
  clips rather than linking directly to descriptively-named source files.
- **Room and host tokens must have different exposure and different
  entropy.** The player join link is meant to be shared (low friction, can
  be a short code); the host link/token grants control (start/pause/skip)
  and must never be shared or guessable — generate it with high entropy and
  treat it as a secret, separately from the room join code.
- **Origin validation on WebSocket upgrade**: verify the `Origin` header
  matches the expected deployment origin to block naive cross-site socket
  hijacking. This does not replace the token model above, but is a cheap
  additional layer.
- **Input validation**: cap nickname length, strip control characters,
  reject empty/whitespace-only nicknames after normalization. Cap guess
  message size. Never trust any client-supplied score, rank, or timestamp
  field — the server is the sole source of truth for all of these.
- **XSS**: nicknames and guesses are player-controlled strings that will be
  rendered in every other player's UI (roster, leaderboard). This is a
  frontend rendering concern (escape on render / use a framework that does
  so by default), noted here because the shared normalization module is
  *not* an HTML-sanitization step and must not be relied on as one.
- **No anti-cheat beyond server authority** is attempted (e.g., a player
  alt-tabbing to search lyrics online is not technically preventable, and is
  out of scope).

## 8. Summary of explicit limitations / non-goals of this contribution

- No frontend was built (explicitly excluded from this contribution's scope).
- No media hosting/streaming pipeline was designed; clip delivery mechanics
  beyond "server tells clients a URL + start/end offsets" are unspecified.
- Room state is in-memory only; a server process restart loses all active
  games. Acceptable for a casual, short-lived game; flagged for the record.
- Answer matching (`shared/`) is exact-normalized-match only — no fuzzy or
  typo-tolerant matching. This is a deliberate choice: fuzzy matching would
  introduce ambiguity into "who was first and correct," which conflicts with
  the authoritative-server fairness goal. A future enhancement could add a
  bounded edit-distance mode, but that changes the fairness model and should
  be a deliberate product decision, not a default.
- "First correct answer" fairness is bounded by network latency, not just
  player skill/knowledge (§6) — an accepted limitation, not a defect.
- Host-disconnect-forever has no automatic remediation (§5) — acceptable for
  a casual product; a production system with SLAs would want host migration,
  which was deliberately not designed here as disproportionate to the stated
  ~20-player casual use case.
