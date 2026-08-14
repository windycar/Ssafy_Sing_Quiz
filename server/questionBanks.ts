/**
 * The proverb and idiom question banks.
 *
 * Read from the host's own `속담.json` / `사자성어.json` in the project root
 * when those exist, and from the copies this repository ships under `data/`
 * when they do not. `server/localFiles.ts` owns that choice.
 *
 * Server-side only, and deliberately so. `shared/` is mounted at `/shared/` for
 * the reference client, so anything placed there is public; `data/` and
 * `server/` are not served at all. The answers reach a client only through
 * `ROUND_REVEAL`.
 *
 * The banks are built once, at module load. What a bad record costs depends on
 * whose file it is in:
 *
 * - **Bundled**: throws, and the server does not start. These are fixed,
 *   version-controlled questions, so a broken one is a repository mistake
 *   somebody must fix, and startup is the loudest place to find out.
 * - **The host's own**: reported on the console and left as an empty bank. A
 *   typo in a file edited half an hour ago should not take down the song game
 *   too. Choosing that mode then fails at `HOST_START` with "출제할 문제가
 *   없습니다", which is the truth.
 *
 * A bundled bank holds exactly `TEXT_BANK_SIZE` questions; a host's own file
 * may hold any number. Either way a game plays up to `QUESTIONS_PER_TEXT_GAME`
 * of them, drawn by `selectQuestions` in `index.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildIdiomBank, buildProverbBank, QuestionBankError, TEXT_BANK_SIZE } from '../shared/questions.ts';
import type { GameMode, Question, RawIdiom, RawProverb } from '../shared/questions.ts';
import { IDIOM_FILE, PROVERB_FILE, PROJECT_ROOT, resolveLocalFile } from './localFiles.ts';
import type { LocalFileSpec } from './localFiles.ts';

/** Problems found while loading a host's own bank. Empty on a clean start. */
export const BANK_PROBLEMS: string[] = [];

/** Which text mode a bank belongs to. `song` has no bank. */
export type TextMode = 'proverb' | 'idiom';

interface BankSource {
  spec: LocalFileSpec;
  /** The key the records sit under in the JSON document. */
  key: string;
  build: (records: readonly never[], expectedSize: number | null) => Question[];
}

const SOURCES: Record<TextMode, BankSource> = {
  proverb: {
    spec: PROVERB_FILE,
    key: 'proverbs',
    build: (records, expectedSize) => buildProverbBank(records as readonly RawProverb[], { expectedSize }),
  },
  idiom: {
    spec: IDIOM_FILE,
    key: 'idioms',
    build: (records, expectedSize) => buildIdiomBank(records as readonly RawIdiom[], { expectedSize }),
  },
};

/**
 * Reads one bank file and returns the array under `key`.
 *
 * The files carry a `_comment` array alongside the records — JSON has no
 * comments and the curation rules have to live next to the data they govern —
 * so the records are read by key rather than by taking the whole document.
 */
function readRecords(path: string, key: string): never[] {
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
  return records as never[];
}

/**
 * Builds a bank from the file this repository ships, ignoring any root override.
 *
 * Exported for the data tests, which exist to check *this repository's*
 * questions. A host's own file happening to sit in the working copy of the
 * machine running the tests is not that, and letting it decide whether the
 * suite passes would mean a bad shipped bank could go unnoticed on exactly the
 * machines that edit these files most.
 */
export function bundledBank(mode: TextMode): readonly Question[] {
  const source = SOURCES[mode];
  const path = resolve(PROJECT_ROOT, source.spec.bundled);
  return Object.freeze(source.build(readRecords(path, source.key), TEXT_BANK_SIZE));
}

/** Loads one bank, letting a bundled file fail hard and a host's file fail soft. */
function loadBank(mode: TextMode): readonly Question[] {
  const source = SOURCES[mode];
  const file = resolveLocalFile(source.spec);
  if (!file.fromRoot) return bundledBank(mode);

  try {
    // A host's own file may hold any number of questions; a bundled one is
    // held to the exact count, so a short bank cannot ship unnoticed.
    return Object.freeze(source.build(readRecords(file.path, source.key), null));
  } catch (cause) {
    // The message already names the file; only the mode it costs is missing.
    BANK_PROBLEMS.push(`${source.spec.label} — ${(cause as Error).message}`);
    return Object.freeze([]);
  }
}

/** The proverbs this room may draw from, validated. */
export const PROVERB_BANK: readonly Question[] = loadBank('proverb');

/** The four-character idioms this room may draw from, validated. */
export const IDIOM_BANK: readonly Question[] = loadBank('idiom');

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
