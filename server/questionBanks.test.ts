/**
 * Tests for the question banks this repository actually ships.
 *
 * `shared/questions.test.ts` proves the rules against fixtures. This file
 * proves the rules hold for the real `data/*.json`, which is the thing an event
 * is played from — a curation mistake there is a broken question in front of a
 * room, and the rules being correct does not help if the data breaks them.
 *
 * Importing this module is itself part of the test: the banks are built at
 * module load, so a data file that violates any rule fails before the first
 * assertion runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDIOM_BANK, PROVERB_BANK, textBankFor } from './questionBanks.ts';
import { selectQuestions } from './index.ts';
import { normalizeAnswer } from '../shared/answerMatching.ts';
import { QUESTIONS_PER_TEXT_GAME, TEXT_BANK_SIZE } from '../shared/questions.ts';
import type { Question } from '../shared/questions.ts';

const BANKS: [string, readonly Question[]][] = [
  ['속담', PROVERB_BANK],
  ['사자성어', IDIOM_BANK],
];

test('both shipped banks hold exactly the bank size', () => {
  assert.equal(PROVERB_BANK.length, TEXT_BANK_SIZE);
  assert.equal(IDIOM_BANK.length, TEXT_BANK_SIZE);
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
  for (const question of PROVERB_BANK) {
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
  for (const question of IDIOM_BANK) {
    assert.equal(question.mode, 'idiom');
    if (question.mode !== 'idiom') continue;

    assert.equal([...question.answer].length, 4, `${question.id}: ${question.answer}`);
    assert.ok(question.hanja !== null, `${question.id} has no Hanja`);
    assert.equal([...(question.hanja ?? '')].length, 4, `${question.id}: ${question.hanja}`);

    assert.ok(question.aliases.includes(normalizeAnswer(question.answer)));
    assert.ok(question.aliases.includes(normalizeAnswer(question.hanja ?? '')));
  }
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
  const a = selectQuestions(PROVERB_BANK).map((question) => question.id);
  const b = selectQuestions(PROVERB_BANK).map((question) => question.id);
  assert.notDeepEqual(a, b, 'the order must differ between rooms');
  assert.notDeepEqual(new Set(a), new Set(b), 'the selected set must differ between rooms');
});

test('a draw can be made deterministic for a test that needs it', () => {
  const drawn = selectQuestions(PROVERB_BANK, QUESTIONS_PER_TEXT_GAME, false);
  assert.deepEqual(
    drawn.map((question) => question.id),
    PROVERB_BANK.slice(0, QUESTIONS_PER_TEXT_GAME).map((question) => question.id),
  );
});
