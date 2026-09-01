/**
 * Structural tests for the reference client's markup and wiring.
 *
 * `ui.ts` drives a real DOM, and this repository has no browser and no jsdom —
 * adding one for two screens would be the largest dependency in the project.
 * So these tests assert the two things a DOM test would have been for, in the
 * way that is actually available here:
 *
 * 1. **The screens exist and are addressable.** Every element `ui.ts` looks up
 *    by id is present in `index.html`, and the mode selector offers exactly the
 *    three modes. `el()` throws on a missing id, so a rename that breaks one of
 *    these is a blank screen at runtime — this is the test that catches it.
 * 2. **Nothing on this side judges an answer.** The client imports no matcher,
 *    holds no alias list, and reads no question data. `protocolClient.test.ts`
 *    proves the state it renders from; this proves it has nothing else to
 *    render from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_LABEL, SECTION_ORDER } from '../shared/questions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(resolve(HERE, name), 'utf8');

const HTML = read('index.html');
const UI = read('ui.ts');
const CSS = read('styles.css');

/** Every `el('...')` lookup in `ui.ts`, which throws if the id is missing. */
function lookedUpIds(source: string): string[] {
  return [...source.matchAll(/\bel(?:<[^>]*>)?\('([^']+)'\)/gu)].map((match) => match[1] as string);
}

test('every id the UI looks up exists in the markup', () => {
  const ids = new Set(lookedUpIds(UI));
  assert.ok(ids.size > 20, `expected the UI to address many elements, found ${ids.size}`);

  for (const id of ids) {
    assert.ok(
      HTML.includes(`id="${id}"`),
      `#${id} is looked up in ui.ts but is not in index.html — that screen would throw on load`,
    );
  }
});

test('the room-creation screen states the running order and offers no choice of mode', () => {
  const plan = /<ol id="section-plan"[\s\S]*?<\/ol>/u.exec(HTML)?.[0];
  assert.ok(plan, 'the running order is missing from the room-creation screen');

  // The Korean label a host actually reads, in playing order, from the shared
  // table so the two clients and the server cannot drift apart.
  const labels = [...plan.matchAll(/<b>([^<]+)<\/b>/gu)].map((match) => match[1]);
  assert.deepEqual(labels, SECTION_ORDER.map((mode) => MODE_LABEL[mode]), '노래 → 속담 → 사자성어');

  // And nothing to pick. A room is one game of all three; the only thing a
  // host sets is how many questions each section holds, on the next screen.
  assert.equal(HTML.includes('name="game-mode"'), false, 'the mode picker must be gone');
  assert.equal(HTML.includes('id="mode-select"'), false);
  for (const mode of SECTION_ORDER) {
    assert.ok(HTML.includes(`id="count-${mode}"`), `#count-${mode} is missing from the setup screen`);
  }
});

test('a text round has a clue card, and it is the media stage that gives way to it', () => {
  // The two occupy the same slot; `renderRound` hides whichever the mode does
  // not use, so both need an id and both need to start in a known state.
  assert.ok(HTML.includes('id="clue-card"'), 'no clue card to put a proverb or a meaning in');
  assert.ok(HTML.includes('id="vinyl-stage"'), 'the media stage needs an id to be hidden');
  assert.ok(/<div id="clue-card"[^>]*hidden/u.test(HTML), 'the clue card starts hidden, for song mode');

  assert.ok(UI.includes("el('vinyl-stage').hidden = text"), 'the media stage is not swapped out');
  assert.ok(UI.includes("el('clue-card').hidden = !text"), 'the clue card is not swapped in');

  // The clue itself comes from the server's round payload and nowhere else.
  assert.ok(
    UI.includes("el('clue-text').textContent = round?.question.clue ?? ''"),
    'the clue must be rendered straight from ROUND_START',
  );
});

test('progress, the mode badge, and the answer prompt all come from server state', () => {
  // `현재 문제 / 30` — both halves from the round payload, never counted locally.
  assert.ok(
    UI.includes('round.question.index + 1') && UI.includes('${total}'),
    'the progress counter must be built from question.index and totalQuestions',
  );
  assert.ok(
    UI.includes('describeSections(state.sections, state.totalQuestions)'),
    'the lobby badge must show the plan the server sent, not one this tab picked',
  );
  assert.ok(UI.includes('MODE_PROMPT[mode]'), 'the question prompt must follow the mode');
  assert.ok(UI.includes('ANSWER_PLACEHOLDER[mode]'), 'the answer box must follow the mode');

  // The reveal draws the parts separately so the missing half is visible.
  for (const id of ['reveal-known', 'reveal-title', 'reveal-detail', 'reveal-scorers']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is missing from the reveal screen`);
  }
  assert.ok(CSS.includes('#reveal-known'), 'the prefix has to be visually distinct from the answer');
});

test('every host control lives behind the host-only panel', () => {
  // Pause, resume, skip and end are all inside `#host-controls`, which
  // `renderRound` hides unless this tab holds a host token. The server checks
  // the token on every one of them too — this is the second lock, not the only
  // one — but a player must not even see a button that would fail.
  const panel = /<div id="host-controls"[\s\S]*?<\/div>/u.exec(HTML)?.[0];
  assert.ok(panel, 'the host control panel is missing');
  assert.ok(/<div id="host-controls"[^>]*hidden/u.test(HTML), 'it must start hidden, before we know who this is');
  assert.ok(UI.includes("el('host-controls').hidden = !isHost"), 'it must be shown only to a host');

  for (const id of ['host-pause', 'host-resume', 'host-skip', 'host-skip-section', 'host-end']) {
    assert.ok(panel.includes(`id="${id}"`), `#${id} must be inside the host-only panel`);
  }

  // The two that throw questions away in bulk ask first. Skipping one question
  // does not — that is the point of having three separate controls.
  assert.ok(/host-skip-section[\s\S]{0,500}confirm\(/u.test(UI), 'skipping a section must be confirmed');
  assert.ok(/host-end[\s\S]{0,500}confirm\(/u.test(UI), 'ending the game must be confirmed');
});

test('the hidden host player is allowed to play and recovers from blocked autoplay', () => {
  assert.ok(HTML.includes('id="yt-mount"'), 'the YouTube player has no mount point');
  assert.ok(HTML.includes('id="yt-retry"'), 'the host needs a manual playback fallback');
  assert.ok(UI.includes("https://www.youtube.com/iframe_api"), 'the official IFrame API is not loaded');
  assert.ok(UI.includes('origin: window.location.origin'), 'YouTube needs the page origin as client identity');
  assert.ok(UI.includes('브라우저가 자동 재생을 막았습니다'), 'silent autoplay refusal has no visible recovery');
  assert.ok(UI.includes('getPlayerState()'), 'the fallback must check whether playback really started');
  assert.ok(UI.includes('.unMute()'), 'the host player must not remain silently muted');
  assert.match(CSS, /#yt-stage[\s\S]{0,240}width: 480px/u);
  assert.match(CSS, /#yt-stage[\s\S]{0,260}height: 270px/u);
});

test('the reveal lists every scorer in order, from the server message', () => {
  const reveal = /function renderReveal[\s\S]*?\n\}/u.exec(UI)?.[0];
  assert.ok(reveal, 'renderReveal is gone');

  assert.ok(reveal.includes('reveal?.scorers ?? []'), 'the scorer list must come from ROUND_REVEAL');
  assert.ok(reveal.includes('entry.place'), 'each row says which place it was');
  assert.ok(reveal.includes('entry.pointsAwarded'), 'each row says what it was worth');
  // Not sliced, not sorted, not filtered: the server already ordered them.
  assert.equal(/scorers\.(slice|sort|filter)\(/u.test(reveal), false, 'the client must not reorder the scorers');
});

test('the client never judges an answer and never holds one', () => {
  // The one thing imported from the matching module is the normalizer, and it
  // is used only to show a player what their typing reduces to.
  assert.equal(/createAliasMatcher|isCorrectAnswer|normalizedAliases/u.test(UI), false, 'no matcher in the client');
  assert.equal(/\baliases\b/u.test(UI), false, 'no alias list in the client');
  // Nothing reaches for the question banks, which are server-side data.
  assert.equal(/data\/(proverbs|idioms)|questionBanks/u.test(UI), false, 'the client must not read the banks');
  assert.equal(/PROVERB_BANK|IDIOM_BANK/u.test(UI), false);

  // Wrong guesses are private, so there is no shared log to render one into.
  assert.equal(/ANSWER_REJECTED[\s\S]{0,200}broadcast/u.test(UI), false);
  assert.equal(HTML.includes('chat-log'), true, 'the answer panel exists');
  assert.equal(/id="chat-messages"|class="chat-message"/u.test(HTML), false, 'no shared guess log');
});

test('untrusted strings reach the DOM as text, never as markup', () => {
  // Nicknames and guesses are rendered in everyone else's browser (analysis §7).
  // Matched with the leading dot so the comments that say "textContent, not
  // innerHTML" are not themselves the failure.
  assert.equal(/\.innerHTML|\['innerHTML'\]|\["innerHTML"\]/u.test(UI), false, 'no innerHTML assignment');
  assert.equal(/\.(outerHTML|insertAdjacentHTML)/u.test(UI), false);
  assert.equal(UI.includes('document.write'), false);

  // And the positive side: player-supplied text goes through textContent.
  assert.ok(UI.includes('name.textContent = entry.nickname'), 'nicknames must be set as text');
});

test('the layout is built for a phone first', () => {
  // Participants are all on phones; only the host has a wide screen. The
  // stylesheet must therefore widen at a breakpoint rather than start wide.
  assert.ok(CSS.includes('@media (min-width:'), 'the layout has to grow into a wide screen, not shrink into a narrow one');
  assert.equal(/@media \(max-width:/u.test(CSS), false, 'a max-width breakpoint would mean a desktop-first layout');
  assert.ok(HTML.includes('width=device-width'), 'no viewport meta tag');
  // The clue is the whole screen in a text round, so it has to scale with it.
  assert.ok(/\.clue-text[\s\S]*?clamp\(/u.test(CSS), 'the clue card must scale with the viewport');
  assert.ok(/\.clue-text[\s\S]*?word-break: keep-all/u.test(CSS), 'a Korean proverb must not break mid-word');
});

test('the answer panel has a public feed, and it renders only what the server broadcast', () => {
  // The panel now shows two different things: my own verdict, which is private,
  // and what the room shares. They need separate homes so one cannot be
  // mistaken for the other.
  assert.ok(HTML.includes('id="round-feed"'), 'no public feed in the answer panel');
  const panel = /<div class="chat-log">[\s\S]*?<\/div>/u.exec(HTML)?.[0];
  assert.ok(panel, 'the answer panel is gone');
  assert.ok(panel.includes('id="answer-feedback"'), 'the private verdict still has its own node');
  assert.ok(panel.includes('id="round-feed"'), 'the public feed sits in the same panel');
  assert.ok(/id="round-feed"[^>]*aria-live/u.test(HTML), 'new entries have to be announced to a screen reader');

  const feed = /function renderRoundFeed[\s\S]*?\n\}/u.exec(UI)?.[0];
  assert.ok(feed, 'renderRoundFeed is gone');

  // Both halves come straight off the round state, which is filled by
  // ROUND_HINT and ROUND_SCORER and by nothing this file works out.
  assert.ok(feed.includes('round.hint'), 'the hint must come from the server');
  assert.ok(feed.includes('round.scorers'), 'the places must come from the server');
  assert.equal(/scorers\.(slice|sort|filter)\(/u.test(feed), false, 'the client must not reorder the scorers');
  assert.equal(/hangulInitials|toQuestionHint/u.test(UI), false, 'the client must not build a hint of its own');

  // The exact line the room reads.
  assert.ok(
    feed.includes('`${scorer.place}등 - ${scorer.nickname}`'),
    'the scorer line must read exactly "N등 - 닉네임"',
  );
  // As one text node, so a nickname can never be markup.
  assert.ok(feed.includes('item.textContent ='), 'the scorer line must be set as text');

  // Visually distinguishable, which is the accessibility half of the rule.
  assert.ok(CSS.includes('.round-feed'), 'the public feed needs styling of its own');
  assert.ok(CSS.includes('.feed-hint'), 'the hint has to look different from a place');
  assert.ok(CSS.includes('.feed-scorer'));
});
