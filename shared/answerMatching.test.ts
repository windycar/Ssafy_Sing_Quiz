import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnswer,
  normalizeAliasList,
  createAliasMatcher,
  isCorrectAnswer,
} from './answerMatching.ts';

// Example aliases for a fictional song config. No copyrighted lyrics/media,
// just the kind of title/alias strings a host would type in.
const EXAMPLE_ALIASES = ['Dynamite', '다이나마이트', 'BTS Dynamite'];

test('normalizeAnswer folds case for Latin text', () => {
  assert.equal(normalizeAnswer('Dynamite'), normalizeAnswer('DYNAMITE'));
  assert.equal(normalizeAnswer('dynamite'), 'dynamite');
});

test('normalizeAnswer strips whitespace and punctuation', () => {
  assert.equal(normalizeAnswer('dyna-mite!'), 'dynamite');
  assert.equal(normalizeAnswer('  Dynamite  '), 'dynamite');
  assert.equal(normalizeAnswer("dyna'mite?!"), 'dynamite');
});

test('normalizeAnswer treats Korean spacing as insignificant', () => {
  assert.equal(normalizeAnswer('다이나마이트'), normalizeAnswer('다이나 마이트'));
  assert.equal(normalizeAnswer('다 이 나 마 이 트'), normalizeAnswer('다이나마이트'));
});

test('normalizeAnswer unifies decomposed (NFD) and precomposed (NFC) Hangul', () => {
  const precomposed = '다이나마이트';
  const decomposed = precomposed.normalize('NFD');
  assert.notEqual(precomposed, decomposed, 'test fixture should actually differ before normalizing');
  assert.equal(normalizeAnswer(precomposed), normalizeAnswer(decomposed));
});

test('normalizeAnswer folds full-width Latin characters via NFKC', () => {
  const fullWidth = 'Ｄｙｎａｍｉｔｅ'; // "Dynamite"
  assert.equal(normalizeAnswer(fullWidth), normalizeAnswer('Dynamite'));
});

test('normalizeAnswer returns empty string for whitespace/punctuation-only input', () => {
  assert.equal(normalizeAnswer('   '), '');
  assert.equal(normalizeAnswer('!!! ---'), '');
  assert.equal(normalizeAnswer(''), '');
});

test('normalizeAliasList de-duplicates and drops empty aliases', () => {
  const result = normalizeAliasList(['Dynamite', 'dynamite', '  DYNAMITE  ', '', '   ']);
  assert.deepEqual(result, ['dynamite']);
});

test('isCorrectAnswer matches any accepted alias, case/space/punctuation-insensitive', () => {
  assert.equal(isCorrectAnswer('dynamite', EXAMPLE_ALIASES), true);
  assert.equal(isCorrectAnswer('DYNAMITE!', EXAMPLE_ALIASES), true);
  assert.equal(isCorrectAnswer('다이나마이트', EXAMPLE_ALIASES), true);
  assert.equal(isCorrectAnswer('다이나 마이트', EXAMPLE_ALIASES), true);
  assert.equal(isCorrectAnswer('bts dynamite', EXAMPLE_ALIASES), true);
});

test('isCorrectAnswer rejects unrelated or empty guesses', () => {
  assert.equal(isCorrectAnswer('butter', EXAMPLE_ALIASES), false);
  assert.equal(isCorrectAnswer('', EXAMPLE_ALIASES), false);
  assert.equal(isCorrectAnswer('   ', EXAMPLE_ALIASES), false);
});

test('createAliasMatcher precomputes normalized aliases and can be reused', () => {
  const matcher = createAliasMatcher(EXAMPLE_ALIASES);
  assert.equal(matcher.normalizedAliases.size, 3);
  assert.equal(matcher.matches('Dynamite'), true);
  assert.equal(matcher.matches('다이나마이트'), true);
  assert.equal(matcher.matches('not it'), false);
  // Reusable across many calls without re-normalizing the alias list.
  assert.equal(matcher.matches('DyNaMiTe'), true);
});

test('createAliasMatcher treats an all-empty alias list as never matching', () => {
  const matcher = createAliasMatcher(['', '   ', '!!!']);
  assert.equal(matcher.normalizedAliases.size, 0);
  assert.equal(matcher.matches('anything'), false);
  assert.equal(matcher.matches(''), false);
});
