/**
 * Tests for the mode-neutral question model.
 *
 * Two things are being defended here. First, that a bank which would make the
 * game unfair or unplayable is rejected loudly at construction rather than
 * quietly shipped — a duplicate answer, a clue that gives itself away, a bank
 * that is not thirty questions. Second, that `toQuestionPublic` never emits an
 * answer, in any mode, however the question is shaped.
 *
 * The real banks are tested in `server/questionBanks.test.ts`, which is where
 * the data files are read; these are fixtures, so a curation change to the data
 * cannot make a rule test pass or fail by accident.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdiomBank,
  buildProverbBank,
  isGameMode,
  isTextMode,
  songQuestions,
  toQuestionPublic,
  toQuestionReveal,
  GAME_MODES,
  MODE_LABEL,
  QUESTIONS_PER_TEXT_GAME,
  TEXT_BANK_SIZE,
  QuestionBankError,
} from './questions.ts';
import type { RawIdiom, RawProverb } from './questions.ts';
import { createAliasMatcher } from './answerMatching.ts';
import { buildSongCatalog } from './songCatalog.ts';

// --- Fixtures ---------------------------------------------------------------

/** Four distinct characters from `block`, unique per index. */
function four(block: number, index: number): string {
  return String.fromCodePoint(...[0, 1, 2, 3].map((offset) => block + index * 4 + offset));
}

/** A valid bank of the required size, built from a per-index generator. */
function proverbs(overrides: Partial<RawProverb>[] = []): RawProverb[] {
  return Array.from({ length: TEXT_BANK_SIZE }, (_, i) => ({
    id: `p${i}`,
    full: `앞부분${i} 뒷부분${i}`,
    prefix: `앞부분${i}`,
    suffix: `뒷부분${i}`,
    ...overrides[i],
  }));
}

/**
 * Idiom fixtures are generated from the Hangul syllable and CJK blocks rather
 * than written out, because every record has to be exactly four characters in
 * both scripts and distinct from the other forty-nine.
 */
function idioms(overrides: Partial<RawIdiom>[] = []): RawIdiom[] {
  return Array.from({ length: TEXT_BANK_SIZE }, (_, i) => ({
    id: `i${i}`,
    answer: four(0xac00, i),
    hanja: four(0x4e00, i),
    meaning: `${i}번째 뜻풀이`,
    ...overrides[i],
  }));
}

/** The first fixture idiom's generated answer and Hanja, for assertions. */
const FIRST_IDIOM = { answer: four(0xac00, 0), hanja: four(0x4e00, 0) };

// --- Mode helpers -----------------------------------------------------------

test('the three modes are exactly song, proverb and idiom', () => {
  assert.deepEqual(GAME_MODES, ['song', 'proverb', 'idiom']);
  for (const mode of GAME_MODES) assert.notEqual(MODE_LABEL[mode], undefined);
  assert.equal(MODE_LABEL.proverb, '속담 맞히기');
  assert.equal(MODE_LABEL.idiom, '사자성어 맞히기');
});

test('isGameMode refuses anything that is not one of the three', () => {
  assert.equal(isGameMode('song'), true);
  assert.equal(isGameMode('proverb'), true);
  assert.equal(isGameMode('idiom'), true);
  for (const value of ['', 'SONG', 'quiz', 42, null, undefined, {}, ['song']]) {
    assert.equal(isGameMode(value), false, `should have refused ${JSON.stringify(value)}`);
  }
});

test('the text modes are the two whose clue is text', () => {
  assert.equal(isTextMode('proverb'), true);
  assert.equal(isTextMode('idiom'), true);
  assert.equal(isTextMode('song'), false);
});

// --- Bank validation --------------------------------------------------------

test('a bank holds fifty questions and a game plays thirty of them', () => {
  // Two separate numbers on purpose. A bank exactly one game long could only
  // ever be reordered, so two groups on the same evening would get the same
  // questions; drawing thirty out of fifty gives them different sets.
  assert.equal(TEXT_BANK_SIZE, 50);
  assert.equal(QUESTIONS_PER_TEXT_GAME, 30);
  assert.ok(TEXT_BANK_SIZE > QUESTIONS_PER_TEXT_GAME);

  assert.equal(buildProverbBank(proverbs()).length, TEXT_BANK_SIZE);
  assert.equal(buildIdiomBank(idioms()).length, TEXT_BANK_SIZE);
});

test('a bank of the wrong size is refused', () => {
  // Short and long alike: the count is a fixed product requirement, so
  // "close enough" would silently change the game.
  assert.throws(() => buildProverbBank(proverbs().slice(0, TEXT_BANK_SIZE - 1)), QuestionBankError);
  assert.throws(() => buildProverbBank([...proverbs(), ...proverbs().slice(0, 1)]), QuestionBankError);
  assert.throws(() => buildIdiomBank(idioms().slice(0, QUESTIONS_PER_TEXT_GAME)), QuestionBankError);
  assert.throws(() => buildIdiomBank([]), QuestionBankError);
});

test('an idiom that is not four characters in either script is refused', () => {
  assert.throws(() => buildIdiomBank(idioms([{ answer: '세글자' }])), /한글 정답은 4글자/u);
  assert.throws(() => buildIdiomBank(idioms([{ answer: '다섯 글자요' }])), /한글 정답은 4글자/u);
  assert.throws(() => buildIdiomBank(idioms([{ hanja: '三字만' }])), /한자 표기는 4글자/u);
  // An idiom with no Hanja at all is allowed; only a wrong-length one is not.
  assert.equal(buildIdiomBank(idioms([{ hanja: null }]))[0]?.mode, 'idiom');
});

test('a duplicate id is refused', () => {
  assert.throws(() => buildProverbBank(proverbs([{}, { id: 'p0' }])), /중복/u);
  assert.throws(() => buildIdiomBank(idioms([{}, { id: 'i0' }])), /중복/u);
});

test('two questions that share an accepted answer are refused', () => {
  // A guess that is correct for two questions makes "who was right" ambiguous,
  // which is the one thing the judging model must never be.
  assert.throws(
    () => buildProverbBank(proverbs([{}, { full: '앞부분0 뒷부분0', prefix: '앞부분0', suffix: '뒷부분0' }])),
    /겹칩니다/u,
  );
  assert.throws(() => buildIdiomBank(idioms([{}, { answer: FIRST_IDIOM.answer }])), /겹칩니다/u);
});

test('a proverb whose prefix already contains the answer is refused', () => {
  assert.throws(
    () => buildProverbBank(proverbs([{ full: '가는 말이 곱다 곱다', prefix: '가는 말이 곱다', suffix: '곱다' }])),
    /단서에 정답이/u,
  );
  // Spacing cannot hide it: the check runs on normalized text.
  assert.throws(
    () => buildProverbBank(proverbs([{ full: '뒷 부분0 뒷부분0', prefix: '뒷 부분0', suffix: '뒷부분0' }])),
    /단서에 정답이/u,
  );
});

test('a proverb whose three fields disagree is refused', () => {
  assert.throws(() => buildProverbBank(proverbs([{ prefix: '다른 앞부분' }])), /앞부분이 아닙니다/u);
  assert.throws(() => buildProverbBank(proverbs([{ suffix: '다른 뒷부분' }])), /뒷부분이 아닙니다/u);
  assert.throws(() => buildProverbBank(proverbs([{ suffix: '   ' }])), QuestionBankError);
});

test('an idiom whose meaning gives the answer away is refused', () => {
  assert.throws(
    () => buildIdiomBank(idioms([{ meaning: `${FIRST_IDIOM.answer} 라는 뜻` }])),
    /뜻풀이에 정답이/u,
  );
  assert.throws(
    () => buildIdiomBank(idioms([{ meaning: `${FIRST_IDIOM.hanja} 를 쓴다` }])),
    /한자 정답이/u,
  );
  assert.throws(() => buildIdiomBank(idioms([{ answer: '  ' }])), QuestionBankError);
});

test('an empty clue is refused', () => {
  assert.throws(() => buildIdiomBank(idioms([{ meaning: '   ' }])), /단서가 비어/u);
});

test('a question with no usable alias is refused', () => {
  // Punctuation normalizes to nothing, so this record would accept no guess at
  // all and could never be answered.
  assert.throws(() => buildIdiomBank(idioms([{ answer: '!!!!', hanja: null }])), QuestionBankError);
});

// --- What a guess is judged against -----------------------------------------

test('a proverb accepts the whole saying and the missing half, not the prefix', () => {
  const bank = buildProverbBank(
    proverbs([{ id: 'pv', full: '가는 말이 고와야 오는 말이 곱다', prefix: '가는 말이 고와야', suffix: '오는 말이 곱다' }]),
  );
  const question = bank[0];
  assert.ok(question !== undefined && question.mode === 'proverb');
  const matcher = createAliasMatcher(question.aliases);

  assert.equal(matcher.matches('오는 말이 곱다'), true, 'the missing half');
  assert.equal(matcher.matches('가는 말이 고와야 오는 말이 곱다'), true, 'the whole proverb');
  // Spacing, punctuation, and composed/decomposed Hangul all fold away.
  assert.equal(matcher.matches('오는말이곱다'), true);
  assert.equal(matcher.matches('  오는 말이, 곱다!  '), true);
  assert.equal(matcher.matches('오는 말이 곱다'.normalize('NFD')), true);

  // Not fuzzy: a near-spelling stays wrong, and the clue is not an answer.
  assert.equal(matcher.matches('오는 말이 고와요'), false);
  assert.equal(matcher.matches('오는 말이 곱다요'), false);
  assert.equal(matcher.matches('가는 말이 고와야'), false, 'the clue is not the answer');
  assert.equal(matcher.matches(''), false);
});

test('an idiom accepts the Hangul reading and the four Hanja, not the meaning', () => {
  const bank = buildIdiomBank(
    idioms([{ id: 'id', answer: '고진감래', hanja: '苦盡甘來', meaning: '힘든 시기가 지나면 좋은 날이 옴' }]),
  );
  const question = bank[0];
  assert.ok(question !== undefined && question.mode === 'idiom');
  const matcher = createAliasMatcher(question.aliases);

  assert.equal(matcher.matches('고진감래'), true);
  assert.equal(matcher.matches('苦盡甘來'), true);
  assert.equal(matcher.matches(' 고진 감래 '), true);
  assert.equal(matcher.matches('고진감래'.normalize('NFD')), true);

  assert.equal(matcher.matches('힘든 시기가 지나면 좋은 날이 옴'), false, 'the clue is not the answer');
  assert.equal(matcher.matches('고진감내'), false, 'a near-spelling stays wrong');
  assert.equal(matcher.matches('감래고진'), false);
});

test('host-supplied aliases are accepted alongside the built-in ones', () => {
  const bank = buildIdiomBank(idioms([{ aliases: ['별칭'] }]));
  const question = bank[0];
  assert.ok(question !== undefined);
  assert.equal(createAliasMatcher(question.aliases).matches('별칭'), true);
});

// --- The redaction seam -----------------------------------------------------

test('toQuestionPublic emits the clue and never the answer', () => {
  const proverb = buildProverbBank(proverbs())[0];
  const idiom = buildIdiomBank(idioms())[0];
  assert.ok(proverb !== undefined && proverb.mode === 'proverb');
  assert.ok(idiom !== undefined && idiom.mode === 'idiom');

  const proverbPublic = toQuestionPublic(proverb, 3, 30, 30_000);
  assert.deepEqual(proverbPublic, {
    mode: 'proverb',
    index: 3,
    totalQuestions: 30,
    durationMs: 30_000,
    clue: proverb.prefix,
  });
  const proverbJson = JSON.stringify(proverbPublic);
  assert.equal(proverbJson.includes(proverb.suffix), false);
  assert.equal(proverbJson.includes(proverb.full), false);
  for (const alias of proverb.aliases) assert.equal(proverbJson.includes(alias), false);

  const idiomPublic = toQuestionPublic(idiom, 0, 30, 30_000);
  assert.equal(idiomPublic.clue, idiom.meaning);
  const idiomJson = JSON.stringify(idiomPublic);
  assert.equal(idiomJson.includes(idiom.answer), false);
  assert.equal(idiomJson.includes(idiom.hanja ?? ' '), false);
});

test('a song question has no text clue and never leaks its title', () => {
  const songs = buildSongCatalog([
    {
      id: 's1',
      artist: '방탄소년단',
      title: 'Dynamite',
      aliases: ['다이나마이트'],
      mediaUrl: 'https://media.invalid/a',
      clipStart: 30,
      clipEnd: 40,
    },
  ]).playable;
  const question = songQuestions(songs)[0];
  assert.ok(question !== undefined && question.mode === 'song');

  const payload = toQuestionPublic(question, 0, 1, 20_000);
  assert.equal(payload.mode, 'song');
  assert.equal(payload.clue, null, 'the clue is the audio, not text');
  const json = JSON.stringify(payload);
  for (const secret of ['Dynamite', '다이나마이트', '방탄소년단']) {
    assert.equal(json.includes(secret), false);
  }
});

test('toQuestionReveal says everything, and only at the reveal', () => {
  const proverb = buildProverbBank(
    proverbs([{ full: '티끌 모아 태산', prefix: '티끌 모아', suffix: '태산', explanation: '작은 것도 모으면 커진다.' }]),
  )[0];
  const idiom = buildIdiomBank(idioms([{ answer: '고진감래', hanja: '苦盡甘來', meaning: '쓴 뒤에 단 것' }]))[0];
  assert.ok(proverb !== undefined && idiom !== undefined);

  assert.deepEqual(toQuestionReveal(proverb), {
    mode: 'proverb',
    answer: '티끌 모아 태산',
    artist: null,
    detail: '태산',
    clue: '티끌 모아',
    hanja: null,
    explanation: '작은 것도 모으면 커진다.',
  });
  // A record with no explanation gets null rather than an empty string, so a
  // client can test one thing to decide whether to render the line at all.
  assert.deepEqual(toQuestionReveal(idiom), {
    mode: 'idiom',
    answer: '고진감래',
    artist: null,
    detail: '쓴 뒤에 단 것',
    clue: null,
    hanja: '苦盡甘來',
    explanation: null,
  });
});
