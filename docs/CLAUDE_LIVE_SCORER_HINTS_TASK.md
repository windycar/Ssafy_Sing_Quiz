# Claude implementation task: live scorer feed and timed text hints

> **완료됨.** 구현 커밋 `2784fc9`와 후속 안내 커밋 `80e5918`은 `main`에
> 통합됐습니다. 아래 내용은 구현 요구사항과 검토 기준을 보존한 기록입니다.

## Objective

Implement the following behavior for the **proverb** and **four-character idiom**
chapters. The song chapter must keep its current scoring and secrecy behavior.

1. As each of the first three correct players is accepted, broadcast a live scorer
   entry and render it in the existing right-side chat/feed panel using this exact
   visible format:

   ```text
   1등 - 닉네임
   2등 - 닉네임
   3등 - 닉네임
   ```

2. Change proverb and idiom rounds from 30 seconds to **60 seconds**.
3. When exactly **30 seconds remain**, broadcast and display one hint:
   - idiom: the four Hangul initial consonants, e.g. `일석이조` → `ㅇㅅㅇㅈ`;
   - proverb: a curated core keyword stored with the question data.

Claude Code is the lead implementer. Work only in `.worktrees/claude` on branch
`agent/claude`, commit the completed change, and report the commit hash, files,
checks, and known risks. Do not touch untracked `.claude/` files.

## Required architecture and protocol

- The server remains authoritative for time, scorer order, and hints. The client
  must not derive hints from hidden answers or infer places locally.
- Add explicit server messages (names may be adjusted only with a strong reason):
  - `ROUND_SCORER`: public scorer payload with `playerId`, `nickname`, `place`, and
    `pointsAwarded`;
  - `ROUND_HINT`: public hint payload containing only the safe display hint.
- Keep `ANSWER_ACCEPTED` private to the player who submitted the correct answer.
- Broadcast `ROUND_SCORER` only in proverb/idiom rounds and only after a correct
  answer has been accepted. Never broadcast wrong guesses or submitted answer text.
- `ROUND_HINT` must be emitted once per text round, no earlier than 30 seconds
  remaining. It must never contain the complete proverb or idiom answer.
- A late join or reconnect during a round must receive the already-public scorer
  list and hint in `ROOM_STATE`/`RoundPublicState`. Before the hint time, the
  snapshot must not contain the hint.
- Pause/resume must preserve remaining time. It must neither skip nor duplicate the
  hint. Skip, early completion, and reveal must cancel any pending hint timer.
- Song rounds keep their existing duration, one-winner behavior, and must not emit
  the new text-only scorer/hint messages.

## Question data

- Extend the proverb data/model with an explicit safe `hint`/core-keyword field.
- Add a useful curated keyword to every bundled proverb in both
  `data/proverbs.json` and `data/proverbs.50.json` when both are maintained as
  canonical copies.
- Keep existing user-created `문제/속담.json` files compatible. If an old custom
  record has no hint, use a generic non-answer-revealing fallback message rather
  than rejecting the entire proverb bank or exposing a word selected from the
  answer automatically.
- Idiom initials must correctly handle Korean syllables and produce the expected
  four consonants for valid four-syllable answers. Put the conversion in tested
  shared/server code; do not send the full idiom to clients before reveal.

## Client behavior

Implement the same behavior in both clients:

- reference client: `client/`;
- React client: `music-quiz/`.

Use the existing right-side `chat-log`/feed area. During a text round it must show:

- one distinct hint entry when the 30-second hint arrives;
- scorer entries in acceptance order with the exact text `N등 - 닉네임`;
- no fake chat, wrong answers, or submitted answer values.

Clear round-specific feed entries when the next round starts. Preserve them when a
snapshot restores the current round. Existing private answer feedback may remain,
but public scorer/hint entries must be visually distinguishable and accessible.
Escape/render nicknames safely; do not introduce `innerHTML` injection.

## Documentation

Update all statements that currently say text rounds are 30 seconds or that scorer
updates remain private until reveal, including at least:

- `README.md`;
- `docs/GAME_RULES.md`;
- `docs/USER_GUIDE.md`;
- `docs/realtime-protocol.md`;
- relevant development/operations notes if they contain stale behavior.

## Required verification

Add focused tests for all of the following, then run the complete relevant suites:

1. text round duration is 60,000 ms;
2. no hint exists in messages/snapshots before the threshold;
3. exactly one hint is sent with 30,000 ms remaining;
4. pause/resume before and after the threshold preserves timing and prevents
   duplicate hints;
5. idiom initials are correct (`일석이조` → `ㅇㅅㅇㅈ`);
6. custom proverb without `hint` loads and gets only the safe generic fallback;
7. the first, second, and third accepted text scorers produce ordered public events;
8. reconnect snapshot restores only already-public hint/scorers;
9. song rounds do not emit text hint/scorer events;
10. both clients render `1등 - 닉네임`, `2등 - 닉네임`, `3등 - 닉네임` and the hint;
11. malformed client frames, wrong answers, and duplicate submissions still do not
    leak anything publicly;
12. lint/type/tests for shared, server, reference client, and React client pass.

Run at minimum the repository's documented full test commands. If browser tooling
is available, verify one desktop and one mobile text-round flow through hint and
three scorers. Do not weaken existing secrecy/security assertions just to make the
new behavior pass; update them narrowly to permit only the new safe public fields.

