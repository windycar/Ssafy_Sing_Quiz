/**
 * The proverb and idiom question banks, loaded from `data/`.
 *
 * Server-side only, and deliberately so. `shared/` is mounted at `/shared/` for
 * the reference client, so anything placed there is public; `data/` and
 * `server/` are not served at all. The answers live in `data/*.json` and reach
 * a client only through `ROUND_REVEAL`.
 *
 * The banks are built once, at module load, and a bad record throws rather than
 * being skipped. These are fixed, version-controlled questions, so a broken one
 * is a repository mistake somebody must fix — quietly shipping a bank one
 * question short would hide it. Failing at startup is the loudest place to find
 * out.
 *
 * Each bank holds `TEXT_BANK_SIZE` questions and a game plays
 * `QUESTIONS_PER_TEXT_GAME` of them; `selectQuestions` in `index.ts` does the
 * drawing.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdiomBank, buildProverbBank, QuestionBankError } from '../shared/questions.ts';
import type { GameMode, Question, RawIdiom, RawProverb } from '../shared/questions.ts';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data');

/**
 * Reads one bank file and returns the array under `key`.
 *
 * The files carry a `_comment` array alongside the records — JSON has no
 * comments and the curation rules have to live next to the data they govern —
 * so the records are read by key rather than by taking the whole document.
 */
function readRecords<T>(fileName: string, key: string): T[] {
  const path = resolve(DATA_DIR, fileName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new QuestionBankError(`${path} 을(를) 읽을 수 없습니다: ${(cause as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new QuestionBankError(`${path} 의 최상위는 객체여야 합니다.`);
  }
  const records = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(records)) {
    throw new QuestionBankError(`${path} 에서 "${key}" 배열을 찾지 못했습니다.`);
  }
  return records as T[];
}

/** The curated proverbs, validated. `TEXT_BANK_SIZE` of them. */
export const PROVERB_BANK: readonly Question[] = Object.freeze(
  buildProverbBank(readRecords<RawProverb>('proverbs.json', 'proverbs')),
);

/** The curated four-character idioms, validated. `TEXT_BANK_SIZE` of them. */
export const IDIOM_BANK: readonly Question[] = Object.freeze(
  buildIdiomBank(readRecords<RawIdiom>('idioms.json', 'idioms')),
);

/**
 * The bank a text mode plays, or null for `song` — whose questions come from
 * the host's catalog rather than from this repository.
 */
export function textBankFor(mode: GameMode): readonly Question[] | null {
  switch (mode) {
    case 'proverb':
      return PROVERB_BANK;
    case 'idiom':
      return IDIOM_BANK;
    case 'song':
      return null;
  }
}
