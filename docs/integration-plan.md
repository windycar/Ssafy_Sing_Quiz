# Integration plan — `agent/codex` prototype × `agent/claude` protocol

Companion to [`claude-analysis.md`](./claude-analysis.md) and
[`realtime-protocol.md`](./realtime-protocol.md). This document is the
integration contract between the two agent branches. It states what each
branch currently holds, every concrete conflict between them, and the order
in which they should be merged so that no step leaves `main` in a state
where the game is judgeable but unfair.

Nothing in `.worktrees/codex` was modified to produce this document. All
findings about the prototype come from reading `agent/codex` via
`git show`; all new code lives in `shared/` on `agent/claude`.

## 0. Current state of the two branches

State as of `agent/claude` 655da28 and `agent/codex` 696b908, both already
merged up to `main` d1d09f5.

| | `agent/claude` | `agent/codex` |
| --- | --- | --- |
| Content | `docs/claude-analysis.md`, `docs/realtime-protocol.md`, `shared/answerMatching.ts` (+ tests) | `music-quiz/` (Next.js/vinext on Cloudflare Workers), `data/songs.recovered.json` (171 songs), `tools/extract-scx-song-text.py`, `docs/scx-recovery.md` |
| Nature | Design + one runtime module, no app | Working single-player UI prototype, all state client-side |
| Server | Specified, not built | None — `music-quiz/worker/index.ts` is the stock template worker |

The two trees do **not** overlap on any file path. `git merge` will not
report a textual conflict. This is the danger: the merge will look clean
while leaving two different answer-judging implementations in the tree
(§1.1) and an answer-leaking client (§1.2). Merging is therefore gated on
the steps in §3, not on the absence of conflicts.

The only textual difference is `.gitignore` — `agent/codex` adds three
entries (`.scxenv/`, `music-quiz/dev-server*.log`, `music-quiz/.wrangler/`)
that `agent/claude` does not have. Take the codex version wholesale; it is
a strict superset.

Note for whoever merges: the files in `.worktrees/claude` were checked out
with CRLF endings and show as modified under a Linux/LF git. That diff is
whitespace-only (`git diff --ignore-cr-at-eol` is empty) and must not be
committed as a content change.

## 1. Conflicts that block a naive merge

### 1.1 Two different `normalizeAnswer` implementations (must converge)

`music-quiz/app/page.tsx` defines its own:

```ts
value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\p{P}\p{S}\s]/gu, "")
```

`shared/answerMatching.ts` defines:

```ts
input.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
```

These agree on every realistic case tested (case folding, Korean spacing,
NFD/NFC Hangul, full-width Latin, `200%`, `롤린 (Rollin')`, Roman numerals)
but **diverge on invisible format characters**: a zero-width joiner
(U+200D) inside a guess is stripped by the shared version and kept by the
prototype's. Copy-pasted answers do contain such characters.

The consequence is not cosmetic. Once the server judges with `shared/` and
the client previews with its own copy, a player can see "correct" locally
and be told "wrong" by the server, or the reverse — in a game whose entire
premise is *who was correct first*, that is a trust-destroying bug.

**Resolution:** delete the local copy in `page.tsx` and import from
`shared/`. The shared version is the one to keep: it is allow-list based
(only letters and numbers survive), so any new Unicode category can only
ever be stripped, never silently admitted. `toLocaleLowerCase("ko-KR")` is
also not what the prototype wants — a locale-sensitive fold is a liability
on a multilingual alias set and a no-op for Hangul.

### 1.2 The prototype ships the answer to the client (must be removed)

The prototype holds `recoveredSongs[0].aliases` in client state, judges
guesses in the browser, and hardcodes `<h2>Dynamite</h2>` in the reveal
panel. This directly violates `claude-analysis.md` §7: any player can read
the answer from devtools before the round ends.

**Resolution:** the client keeps `normalizeAnswer` only for cosmetic input
hinting; it must never hold aliases. The reveal title/artist arrives in
`ROUND_REVEAL` and nowhere earlier. `toRoundPublicPayload` in
`shared/songCatalog.ts` exists so exactly one function decides what leaves
the server before reveal, and it is unit-tested to not serialize the title,
artist, or aliases.

### 1.3 Wrong guesses are broadcast to everyone (fairness defect)

In the prototype, an incorrect guess is appended to the shared chat log.
`claude-analysis.md` §4 requires the opposite: wrong guesses are private to
the guesser, precisely so players cannot piggyback off each other's near
misses in a first-correct-answer game.

**Resolution:** answer submission and chat must be separate channels. Either
drop chat for the first server-backed version, or route chat as its own
message type that the answer input never writes to. The current UI merges
them in one form — that is a product decision to make deliberately, not an
implementation detail to preserve by accident.

### 1.4 Client-owned timer vs. server-owned deadline

The prototype decrements a local `remaining` state every 100 ms. The
protocol (§3, §4) makes the server the owner of `deadline` (epoch ms) and
extends it on resume via `deadline += now - pausedAt`.

**Resolution:** the client renders `deadline - now` and never mutates it.
Two clients whose tabs were throttled must still agree on when the round
ends. Compute a one-time clock offset from `serverStartedAt` at
`ROUND_START` and apply it to every render.

### 1.5 The 5-second hint leaks answer length

`"힌트: 영어 제목 · 8글자"` is derived client-side from the answer the
client should not have. If hints stay in the product, the server must send
them as an explicit field at an explicit time; they cannot be inferred.

### 1.6 Diverging constants

| Value | Prototype | Protocol | Resolution |
| --- | --- | --- | --- |
| Points per win | +320 | +100 (`realtime-protocol.md` §5) | Pick one; §5 of the protocol is the declared single source of truth. |
| Round length | 12 s, fixed | `clipDurationMs + ANSWER_GRACE_MS` | Server computes it; the lobby's "제한 시간 12초" becomes read-only or host-configurable via a real setting. |
| Tie-break | `score`, then `correct` | equal scores share a rank | Protocol wins; the prototype's extra `correct` field is fine to keep as display data. |
| Phases | `lobby / game / results` | `LOBBY / COUNTDOWN / IN_ROUND / REVEAL / FINISHED` | Client adds `COUNTDOWN` and distinguishes `IN_ROUND` from `REVEAL` (it currently overloads a `revealed` boolean). |

### 1.7 No host authority exists yet

The prototype's pause/skip/start are plain buttons; the room code `B7K2A`
is a hardcoded 5-character string, and there is no host token at all.
`claude-analysis.md` §7 requires the join code and the host token to have
*different* entropy and *different* exposure. Every host action in
`realtime-protocol.md` §2 carries a `hostToken` for this reason.

## 2. New code delivered on this branch

`shared/songCatalog.ts` (+ `songCatalog.test.ts`, 16 tests) is the adapter
between the codex data file and the protocol's `SongConfig`. It exists
because the recovered data is not directly playable, and the reasons are
quantifiable:

- **171/171 songs are unplayable as-is** — every record has
  `mediaUrl: null`, `clipStart: null`, `clipEnd: null`. `buildSongCatalog`
  reports these as `MISSING_MEDIA_URL` / `MISSING_CLIP_RANGE` per song
  rather than failing the whole load, so a host UI can show exactly what is
  left to fill in.
- **47/171 titles carry a parenthetical**, and every recovered record has
  `aliases === [title]`. Under exact-normalized matching, a player typing
  `피노키오` for `피노키오 (Danger)` is judged **wrong**, and
  `바람났어 (Feat. 박봄)` is only winnable by typing the credit line. This
  affects 27% of the catalog and would read as the game being broken.
- `expandTitleAliases` fixes this deterministically: the full title, the
  title minus bracketed segments, and each bracketed segment on its own —
  except segments that are credits (`Feat.`, `ft.`, `with`, `prod.`,
  `remix`, `ver.`), which are dropped so that guessing a featured artist's
  name cannot win a round.
- This is **not** fuzzy matching. It is a fixed set of rewrites applied once
  at load time; judging stays exact-normalized-match, so
  `claude-analysis.md` §8's fairness argument is untouched.
- Cross-song alias collisions are detected and the contested alias is
  dropped from the later song, so no single guess is ever correct for two
  songs. Verified against the real file: with media/clip fields filled in,
  **171/171 songs become playable with zero alias collisions**.
- Clip windows are validated against the 5–15 s product range, inclusive at
  both bounds. Playability is checked *before* aliases are claimed, so an
  unplayable song can never reserve an alias away from a playable one.

Checks run:

- `node --test *.test.ts` in `shared/` — 27 tests, 27 pass
  (11 pre-existing + 16 new).
- `tsc --noEmit --strict` over all four `shared/*.ts` files — clean.
- Replay against the real `data/songs.recovered.json` (171 records):
  0 playable as-is (171 × `MISSING_MEDIA_URL`); with media and a 10 s clip
  filled in, 171 playable, 243 accepted aliases, 0 collisions.

## 3. Merge order

Each step is independently reviewable and leaves `main` in a coherent state.

1. **Merge `agent/claude` into `main` first.** Docs plus `shared/` only, no
   runtime surface. Establishes the protocol and the normalization module as
   the reference before any UI depends on them.
2. **Merge `agent/codex` into `main`.** Textually clean; take codex's
   `.gitignore`. At this point `main` deliberately contains two answer
   implementations — the prototype is still standalone and unshipped.
3. **Wire `shared/` into `music-quiz` (small, focused commit).** Add an npm
   workspace so `music-quiz` can import `@song-quiz/shared`; delete
   `normalizeAnswer` / `isCorrectAnswer` from `page.tsx`. This closes §1.1
   and is the first step that must not be skipped or deferred.
4. ~~**Build the authoritative server**~~ — **done**, in `server/` on this
   branch. `gameRoom.ts` is a transport-free state machine implementing
   `realtime-protocol.md` §4; `websocket.ts` is a dependency-free RFC 6455
   transport; `index.ts` wires them and owns the timers. It uses
   `buildSongCatalog` at construction and `createSongMatcher` per round, and
   holds one in-memory state object per room per `claude-analysis.md` §2.
   Still missing: an HTTP route for creating a room, so a browser host cannot
   yet obtain a `roomId`/`hostToken` pair.
5. **Convert the client to a protocol client.** Replace local state
   transitions with server messages; remove client-side judging, the
   hardcoded reveal, and the client-owned timer (§1.2, §1.4). Split answer
   input from chat (§1.3).
6. **Add the host media-registration screen.** Until a host can supply
   `mediaUrl` + clip offsets, `buildSongCatalog` correctly reports every
   recovered song as unplayable — the game cannot run on real data before
   this exists.

Steps 1–3 are mechanical. Step 4 is the bulk of the work and is the one
that must not be started before step 3, or the server will be written
against a second copy of the matching rules.

Per `AGENTS.md` ("Default workload policy"), each step's diff and test
evidence goes to Codex for independent inspection before it is integrated
into `main`; step 3 in particular should not be self-approved, since it is
the step that silently changes judging behaviour for existing UI code.

## 4. Packaging detail for step 3

`shared/package.json` is `"type": "module"` with `"main": "answerMatching.ts"`
and is consumed as raw TypeScript via Node 22's type stripping
(`node --test *.test.ts`). `music-quiz` builds through Vite/vinext.

The low-friction path is npm workspaces at the repository root:

```json
{ "workspaces": ["shared", "music-quiz"] }
```

Vite will transpile the imported `.ts` sources directly, so no build step is
needed for `shared`. If the Cloudflare Workers build objects to consuming
raw TS from `node_modules`, add a `tsup`/`tsc` build to `shared` and point
`main`/`exports` at the output — but try the workspace route first; the
module is dependency-free and small.

`shared` requires Node `>=22.13.0`; `music-quiz` requires the same. No
conflict.

## 5. Known risks and open decisions

- **Media licensing is unresolved and blocks launch, not just step 6.**
  `docs/scx-recovery.md` is explicit that the SCX provides no web-playable
  URLs. Nothing in either branch supplies one.
- **Media URL leakage** (`claude-analysis.md` §7): once real URLs exist, a
  descriptive filename in a network request gives the answer away. Prefer
  opaque, proxied clip URLs. The `mediaUrl` field in `SongConfig` does not
  enforce this.
- **The recovered data is unreviewed.** `docs/scx-recovery.md` notes some
  source strings are incomplete. `buildSongCatalog` catches structural
  problems, not wrong metadata; a human should review the 171 records.
- **Dropping a colliding alias is a silent product decision.** If two
  distinct songs genuinely share a title, the later one loses that alias and
  may become unplayable (`NO_USABLE_ALIAS`). Surfacing `issues` in the host
  UI is the intended mitigation, and it is not built yet.
- **Chat may be removed by §1.3.** That is a product call, flagged here
  rather than decided.
- **Nothing here addresses the §6 latency-fairness limit** of
  `claude-analysis.md`; integration does not change it.
