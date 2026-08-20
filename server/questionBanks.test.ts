/**
 * Tests for the question banks this repository actually ships.
 *
 * `shared/questions.test.ts` proves the rules against fixtures. This file
 * proves the rules hold for the real `data/*.json`, which is the thing an event
 * is played from — a curation mistake there is a broken question in front of a
 * room, and the rules being correct does not help if the data breaks them.
 *
 * Read through `bundledBank`, not through `PROVERB_BANK`/`IDIOM_BANK`. Those
 * two are whatever the machine will actually play, which on a host's own laptop
 * is their `문제/속담.json` — and if that decided whether this
 * suite passes, a bad *shipped* bank would go unnoticed on exactly the machines
 * that edit these files most.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledBank, IDIOM_BANK, missingHintNotice, PROVERB_BANK, textBankFor } from './questionBanks.ts';
import { selectQuestions } from './index.ts';
import { normalizeAnswer } from '../shared/answerMatching.ts';
import { buildProverbBank, QUESTIONS_PER_TEXT_GAME, TEXT_BANK_SIZE } from '../shared/questions.ts';
import type { Question } from '../shared/questions.ts';

const SHIPPED_PROVERBS = bundledBank('proverb');
const SHIPPED_IDIOMS = bundledBank('idiom');

const BANKS: [string, readonly Question[]][] = [
  ['속담', SHIPPED_PROVERBS],
  ['사자성어', SHIPPED_IDIOMS],
];

test('both shipped banks hold exactly the bank size', () => {
  assert.equal(SHIPPED_PROVERBS.length, TEXT_BANK_SIZE);
  assert.equal(SHIPPED_IDIOMS.length, TEXT_BANK_SIZE);
});

for (const [name, bank] of BANKS) {
  test(`${name} bank: ids, answers, and clues are all unique and usable`, () => {
    assert.equal(new Set(bank.map((question) => question.id)).size, bank.length, 'duplicate id');

    const clues: string[] = [];
    const owner = new Map<string, string>();
    for (const question of bank) {
      assert.notEqual(question.mode, 'song');
      assert.ok(question.aliases.length > 0, `${question.id} accepts no guess at all`);

      const clue = question.mode === 'proverb' ? question.prefix : question.mode === 'idiom' ? question.meaning : '';
      assert.notEqual(clue.trim(), '', `${question.id} has an empty clue`);
      clues.push(clue);

      for (const alias of question.aliases) {
        // Normalized, because that is the form a guess is judged in: two
        // questions whose answers differ only by spacing would still collide.
        assert.equal(alias, normalizeAnswer(alias), `${question.id} alias is not normalized`);
        assert.equal(owner.get(alias), undefined, `alias "${alias}" is correct for two questions`);
        owner.set(alias, question.id);
      }
    }
    assert.equal(new Set(clues).size, bank.length, 'two questions show the same clue');
  });

  test(`${name} bank: no clue contains its own answer`, () => {
    for (const question of bank) {
      const clue = normalizeAnswer(question.mode === 'proverb' ? question.prefix : (question as { meaning: string }).meaning);
      for (const alias of question.aliases) {
        assert.equal(clue.includes(alias), false, `${question.id}: the clue gives the answer away`);
      }
    }
  });
}

test('every proverb splits cleanly into the prefix shown and the suffix asked for', () => {
  for (const question of SHIPPED_PROVERBS) {
    assert.equal(question.mode, 'proverb');
    if (question.mode !== 'proverb') continue;

    assert.equal(
      normalizeAnswer(question.prefix) + normalizeAnswer(question.suffix),
      normalizeAnswer(question.full),
      `${question.id}: prefix + suffix must be the whole proverb`,
    );
    // The prefix has to be a real midpoint, not the whole saying with a word
    // taken off the end and not an empty string.
    assert.ok(question.prefix.trim().length > 0, `${question.id}: empty prefix`);
    assert.ok(question.suffix.trim().length > 0, `${question.id}: empty suffix`);
    // Both halves are accepted, so both must be in the alias set.
    assert.ok(question.aliases.includes(normalizeAnswer(question.full)));
    assert.ok(question.aliases.includes(normalizeAnswer(question.suffix)));
  }
});

test('every idiom is four characters in Hangul and in Hanja', () => {
  for (const question of SHIPPED_IDIOMS) {
    assert.equal(question.mode, 'idiom');
    if (question.mode !== 'idiom') continue;

    assert.equal([...question.answer].length, 4, `${question.id}: ${question.answer}`);
    assert.ok(question.hanja !== null, `${question.id} has no Hanja`);
    assert.equal([...(question.hanja ?? '')].length, 4, `${question.id}: ${question.hanja}`);

    assert.ok(question.aliases.includes(normalizeAnswer(question.answer)));
    assert.ok(question.aliases.includes(normalizeAnswer(question.hanja ?? '')));
  }
});

// --- The notice a host's own proverb file can earn ---------------------------

test('every shipped proverb carries a curated hint, so the bundled bank is silent', () => {
  for (const question of SHIPPED_PROVERBS) {
    assert.equal(question.mode, 'proverb');
    if (question.mode !== 'proverb') continue;
    assert.notEqual(question.hint, null, `${question.id} has no hint`);
  }
  assert.equal(missingHintNotice(SHIPPED_PROVERBS, '문제/속담.json'), null);
});

test('a proverb file written before hints existed says so, with a count and a path', () => {
  // What a host who copied `문제/속담.json` out of `data/` before the field
  // existed actually has: records that load and play, with no hint in any of
  // them. The bank is fine; the halfway hint is not what the rules describe.
  const hintless = buildProverbBank(
    SHIPPED_PROVERBS.slice(0, 3).map((question) => {
      assert.equal(question.mode, 'proverb');
      if (question.mode !== 'proverb') throw new Error('fixture must be proverbs');
      return { id: question.id, full: question.full, prefix: question.prefix, suffix: question.suffix };
    }),
    { expectedSize: null },
  );

  const notice = missingHintNotice(hintless, '문제/속담.json');
  assert.notEqual(notice, null, 'a bank with no hints at all must be reported');
  assert.match(notice ?? '', /3문항 중 3개/);
  assert.match(notice ?? '', /문제\/속담\.json/);
  // It must describe what happens rather than name the fallback's wording, and
  // it must never quote a hint — the file it is complaining about has none, but
  // a partly-curated one would.
  assert.match(notice ?? '', /일반 안내 문구/);
});

test('one missing hint among many is counted, not rounded to all or nothing', () => {
  const records = SHIPPED_PROVERBS.slice(0, 4).map((question, index) => {
    assert.equal(question.mode, 'proverb');
    if (question.mode !== 'proverb') throw new Error('fixture must be proverbs');
    const record = { id: question.id, full: question.full, prefix: question.prefix, suffix: question.suffix };
    return index === 0 ? record : { ...record, hint: question.hint ?? '낱말' };
  });

  assert.match(missingHintNotice(buildProverbBank(records, { expectedSize: null }), 'p.json') ?? '', /4문항 중 1개/);
});

test('an idiom bank never earns the notice — its hint is built, not stored', () => {
  assert.equal(missingHintNotice(SHIPPED_IDIOMS, '문제/사자성어.json'), null);
});

test('textBankFor names a bank for each text mode and none for song', () => {
  assert.equal(textBankFor('proverb'), PROVERB_BANK);
  assert.equal(textBankFor('idiom'), IDIOM_BANK);
  assert.equal(textBankFor('song'), null, 'song questions come from the host catalog');
});

// --- Drawing a game out of a bank -------------------------------------------

test('a draw takes thirty of the fifty, with no repeats', () => {
  for (const [, bank] of BANKS) {
    const drawn = selectQuestions(bank);
    assert.equal(drawn.length, QUESTIONS_PER_TEXT_GAME);
    assert.equal(new Set(drawn.map((question) => question.id)).size, QUESTIONS_PER_TEXT_GAME);

    // Every drawn question is one of the bank's own, not a synthesized one.
    const known = new Set(bank.map((question) => question.id));
    for (const question of drawn) assert.ok(known.has(question.id), `${question.id} is not in the bank`);
  }
});

test('two rooms drawing the same mode get different questions', () => {
  // The reason the bank is larger than a game. This is probabilistic in
  // principle — two draws could coincide — but choosing 30 of 50 twice makes an
  // identical set about 1 in 10^13, so a failure here means the shuffle is gone
  // rather than that the test was unlucky.
  const a = selectQuestions(SHIPPED_PROVERBS).map((question) => question.id);
  const b = selectQuestions(SHIPPED_PROVERBS).map((question) => question.id);
  assert.notDeepEqual(a, b, 'the order must differ between rooms');
  assert.notDeepEqual(new Set(a), new Set(b), 'the selected set must differ between rooms');
});

test('a draw can be made deterministic for a test that needs it', () => {
  const drawn = selectQuestions(SHIPPED_PROVERBS, QUESTIONS_PER_TEXT_GAME, false);
  assert.deepEqual(
    drawn.map((question) => question.id),
    SHIPPED_PROVERBS.slice(0, QUESTIONS_PER_TEXT_GAME).map((question) => question.id),
  );
});
