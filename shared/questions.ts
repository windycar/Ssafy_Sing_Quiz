/**
 * What a round asks, across all three game modes.
 *
 * The engine used to be written around `SongConfig`. Adding proverbs and idioms
 * by copying the engine twice would have meant three copies of the pause/resume
 * accounting, three copies of the scoring rule, and three places to forget a
 * security fix. Instead every mode produces a `Question`, and the engine only
 * ever asks three things of it: what may players type to be right, what may
 * they see before the reveal, and what is shown afterwards.
 *
 * The security rule is the same in every mode and is enforced in exactly one
 * place, `toQuestionPublic`: nothing that answers the question leaves the
 * server before `ROUND_REVEAL`. For songs that means the title; for proverbs
 * the missing suffix; for idioms the four syllables.
 *
 * Browser-safe on purpose. The reference client imports `MODE_LABEL` and
 * `isGameMode` from here over `/shared/`, so this file must not import
 * `node:` anything. The question *data* lives in `data/*.json`, which is never
 * served — see `server/questionBanks.ts`.
 */

import { normalizeAnswer, normalizeAliasList } from './answerMatching.ts';
import type { SongConfig } from './songCatalog.ts';

export type GameMode = 'song' | 'proverb' | 'idiom';

export const GAME_MODES: readonly GameMode[] = ['song', 'proverb', 'idiom'];

/**
 * The order one game plays its three kinds of question in. Fixed.
 *
 * A room is not "a song room" or "a proverb room": it plays songs, then
 * proverbs, then idioms, start to finish, with nobody choosing anything. Songs
 * open because the music is what gets a room's attention, and the rounds get
 * shorter as the game goes on rather than longer — a 60-second round is the
 * wrong thing to end on.
 *
 * The same three values as `GAME_MODES`, and deliberately a separate constant:
 * that one says which kinds of question exist, this one says what order they
 * are played in, and a fourth kind added later would want a considered position
 * here rather than wherever it landed in the other list.
 */
export const SECTION_ORDER: readonly GameMode[] = ['song', 'proverb', 'idiom'];

/** Korean labels, so the server and both clients cannot drift apart. */
export const MODE_LABEL: Record<GameMode, string> = {
  song: '노래 맞히기',
  proverb: '속담 맞히기',
  idiom: '사자성어 맞히기',
};

/** What the answer box should say it wants, per mode. */
export const MODE_PROMPT: Record<GameMode, string> = {
  song: '이 노래의 제목은?',
  proverb: '속담의 뒷부분은?',
  idiom: '이 뜻을 가진 사자성어는?',
};

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (GAME_MODES as readonly string[]).includes(value);
}

/** True for the modes whose clue is text rather than audio. */
export function isTextMode(mode: GameMode): boolean {
  return mode === 'proverb' || mode === 'idiom';
}

interface QuestionCommon {
  id: string;
  /** Everything the server accepts as correct. Never leaves the process. */
  aliases: string[];
}

export type Question =
  | (QuestionCommon & { mode: 'song'; song: SongConfig })
  | (QuestionCommon & {
      mode: 'proverb';
      /** Shown as the clue. */
      prefix: string;
      /** The part players supply. Secret until the reveal. */
      suffix: string;
      full: string;
      /** What the saying means. Shown at the reveal, never before it. */
      explanation: string | null;
      /**
       * The curated core keyword shown as the halfway hint, or null when this
       * record has none. Curated rather than derived: a word picked out of the
       * answer automatically is a word that sometimes *is* the answer.
       */
      hint: string | null;
    })
  | (QuestionCommon & {
      mode: 'idiom';
      /** Shown as the clue. */
      meaning: string;
      /** Secret until the reveal. */
      answer: string;
      hanja: string | null;
      explanation: string | null;
    });

/**
 * The public half of a question: what every player may see while answering.
 *
 * `clue` is null for songs, where the clue is the audio rather than text.
 */
export interface QuestionPublicInfo {
  mode: GameMode;
  /** 0-based position in the room's question list. */
  index: number;
  totalQuestions: number;
  /** How long the answering window is, for a client that wants to show it. */
  durationMs: number;
  clue: string | null;
}

/** What the reveal may say. Only ever sent with `ROUND_REVEAL`. */
export interface QuestionRevealInfo {
  mode: GameMode;
  /** Song title, full proverb, or the four syllables. */
  answer: string;
  /** Artist, or null. */
  artist: string | null;
  /** Proverb: the part players had to supply. Idiom: its meaning. */
  detail: string | null;
  /** Proverb: the prefix that was on screen. Idiom: null. */
  clue: string | null;
  /** Idiom only. */
  hanja: string | null;
  /** A sentence on what it means, for the text modes. Null when there is none. */
  explanation: string | null;
}

/**
 * The one function that decides what leaves the server before REVEAL.
 *
 * Mirrors `toRoundPublicPayload` in `songCatalog.ts` and exists for the same
 * reason (claude-analysis.md §7): one place to audit, one place to test. It
 * returns a fresh object rather than a filtered copy of the question, so a
 * field added to `Question` cannot leak by default — it has to be added here
 * deliberately.
 */
export function toQuestionPublic(
  question: Question,
  index: number,
  totalQuestions: number,
  durationMs: number,
): QuestionPublicInfo {
  let clue: string | null = null;
  // Written as a switch rather than a chain of ternaries so that adding a mode
  // is a type error here instead of a silent `null` clue.
  switch (question.mode) {
    case 'song':
      clue = null;
      break;
    case 'proverb':
      clue = question.prefix;
      break;
    case 'idiom':
      clue = question.meaning;
      break;
  }
  return { mode: question.mode, index, totalQuestions, durationMs, clue };
}

export function toQuestionReveal(question: Question): QuestionRevealInfo {
  switch (question.mode) {
    case 'song':
      return {
        mode: 'song',
        answer: question.song.title,
        artist: question.song.artist,
        detail: null,
        clue: null,
        hanja: null,
        explanation: null,
      };
    case 'proverb':
      return {
        mode: 'proverb',
        answer: question.full,
        artist: null,
        detail: question.suffix,
        clue: question.prefix,
        hanja: null,
        explanation: question.explanation,
      };
    case 'idiom':
      return {
        mode: 'idiom',
        answer: question.answer,
        artist: null,
        detail: question.meaning,
        clue: null,
        hanja: question.hanja,
        explanation: question.explanation,
      };
  }
}

// ---------------------------------------------------------------------------
// The halfway hint
// ---------------------------------------------------------------------------

/**
 * What a text round shows when it is half over and nobody has it yet.
 *
 * Deliberately not derived from the answer for proverbs — see `hint` on the
 * proverb question — and deliberately *only* derived from it for idioms, where
 * the initial consonants are a shape rather than a reading: `ㅇㅇㅈㅇ` narrows
 * 우왕좌왕 down without spelling any of it.
 *
 * The example is deliberately an idiom that is *not* in this repository's
 * bank. This file is mounted at `/shared/` for the reference client, so a
 * real answer written into a comment here would be an answer the browser can
 * fetch — see the served-files test in `server/http.test.ts`.
 */

/**
 * Shown for a proverb somebody wrote themselves and gave no `hint`.
 *
 * A generic sentence rather than a word taken out of the saying: picking one
 * automatically would hand over part of the answer on exactly the records
 * nobody curated, and refusing to load the bank over a missing hint would cost
 * a host their own questions for a field that did not exist when they wrote
 * the file.
 */
export const PROVERB_HINT_FALLBACK = '이 문제에는 준비된 힌트가 없습니다. 앞부분을 다시 읽어 보세요!';

/** Hangul syllables start here and run 588 apart, one block per initial. */
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const SYLLABLES_PER_INITIAL = 588;

/** The 19 initial consonants, in Unicode order. */
const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

/**
 * The initial consonant of every Hangul syllable in `text`.
 *
 * `우왕좌왕` → `ㅇㅇㅈㅇ`. Anything that is not a composed Hangul syllable —
 * Hanja, a space, a jamo already on its own — is passed through unchanged,
 * because dropping it would silently shorten a hint that is supposed to be one
 * mark per character.
 */
export function hangulInitials(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < HANGUL_BASE || code > HANGUL_LAST) {
      out += character;
      continue;
    }
    out += CHOSEONG[Math.floor((code - HANGUL_BASE) / SYLLABLES_PER_INITIAL)] ?? character;
  }
  return out;
}

/**
 * The one function that decides what a hint may say, mirroring
 * `toQuestionPublic`.
 *
 * Returns null for a song round, which has no hint: the clip is the clue and
 * it has been playing since the first millisecond.
 */
export function toQuestionHint(question: Question): string | null {
  switch (question.mode) {
    case 'song':
      return null;
    case 'proverb':
      return question.hint ?? PROVERB_HINT_FALLBACK;
    case 'idiom':
      return hangulInitials(question.answer);
  }
}

// ---------------------------------------------------------------------------
// Question banks
// ---------------------------------------------------------------------------

export interface RawProverb {
  id: string;
  full: string;
  prefix: string;
  suffix: string;
  aliases?: readonly string[];
  /** Curation metadata. Every shipped record is `medium`. */
  difficulty?: string;
  /** Shown at the reveal, never before it. */
  explanation?: string;
  /**
   * The core keyword shown once the round is half over.
   *
   * Optional because the field did not exist when hosts started writing their
   * own `문제/속담.json`. A record without one still loads and plays; it gets
   * `PROVERB_HINT_FALLBACK` instead of a word chosen out of its own answer.
   */
  hint?: string;
}

export interface RawIdiom {
  id: string;
  answer: string;
  hanja?: string | null;
  meaning: string;
  aliases?: readonly string[];
  difficulty?: string;
  explanation?: string;
}

/**
 * How many questions each text bank holds.
 *
 * Deliberately larger than a game, and deliberately a separate constant from
 * `QUESTIONS_PER_TEXT_GAME`. Two groups playing the same mode on the same
 * evening should not get the same thirty questions, and they would if the bank
 * were exactly one game long — shuffling a set you draw all of only changes the
 * order.
 */
export const TEXT_BANK_SIZE = 50;

/** How many questions one text game plays. All of them, once each. */
export const QUESTIONS_PER_TEXT_GAME = 30;

/** Hangul and Hanja answers alike are four characters. */
const IDIOM_LENGTH = 4;

export class QuestionBankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionBankError';
  }
}

/**
 * How many questions a bank must hold.
 *
 * `TEXT_BANK_SIZE` for the banks this repository ships: they are fixed,
 * version-controlled content, so 49 questions is a mistake somebody has to fix
 * rather than a bank that is merely one short.
 *
 * `null` for a bank somebody wrote themselves at the project root. Their file
 * is theirs, and a host who wants a twelve-question round of proverbs is not
 * making a mistake — a game just plays whatever is there, up to
 * `QUESTIONS_PER_TEXT_GAME`. Everything else on the checklist below still
 * applies: those rules are about questions being *playable*, not about how many
 * of them there are.
 */
export interface BankOptions {
  expectedSize?: number | null;
}

/**
 * Checks the things that make a text question unplayable rather than merely
 * imperfect, and throws instead of dropping the record.
 *
 * Dropping is right for a song catalog, where one missing media URL should not
 * cost the host the other hundred and seventy. It is wrong here: a bad record
 * is something someone must fix, and quietly playing 29 questions would hide
 * it.
 */
function assertBank(
  kind: string,
  ids: readonly string[],
  answers: readonly string[][],
  clues: readonly string[],
  expectedSize: number | null,
): void {
  if (expectedSize !== null && ids.length !== expectedSize) {
    throw new QuestionBankError(`${kind} 문제 은행은 정확히 ${expectedSize}문항이어야 합니다 (현재 ${ids.length}).`);
  }
  if (ids.length === 0) {
    throw new QuestionBankError(`${kind} 문제가 하나도 없습니다.`);
  }

  const seenIds = new Set<string>();
  for (const id of ids) {
    if (id.trim() === '') throw new QuestionBankError(`${kind}: 비어 있는 id 가 있습니다.`);
    if (seenIds.has(id)) throw new QuestionBankError(`${kind}: id "${id}" 가 중복됩니다.`);
    seenIds.add(id);
  }

  for (const [index, clue] of clues.entries()) {
    if (clue.trim() === '') {
      throw new QuestionBankError(`${kind} "${ids[index]}": 화면에 보여 줄 단서가 비어 있습니다.`);
    }
  }

  // A guess that is correct for two questions makes "who was right" ambiguous,
  // which is the one thing the whole judging model must never be.
  const owner = new Map<string, string>();
  for (const [index, list] of answers.entries()) {
    if (list.length === 0) {
      throw new QuestionBankError(`${kind} "${ids[index]}": 정답으로 쓸 수 있는 문자열이 없습니다.`);
    }
    for (const alias of list) {
      const existing = owner.get(alias);
      if (existing !== undefined) {
        throw new QuestionBankError(`${kind}: 정답 "${alias}" 이(가) ${existing} 와(과) ${ids[index]} 에 겹칩니다.`);
      }
      owner.set(alias, ids[index] as string);
    }
  }
}

/**
 * Builds the proverb bank.
 *
 * Both the whole proverb and the missing half are accepted, because a player
 * reading "가는 말이 고와야" may reasonably type either the rest or the lot.
 */
export function buildProverbBank(records: readonly RawProverb[], options: BankOptions = {}): Question[] {
  const questions: Question[] = [];
  for (const record of records) {
    const prefix = record.prefix.trim();
    const suffix = record.suffix.trim();
    const full = record.full.trim();

    // The clue must not contain the answer. Checked on normalized text so that
    // spacing cannot hide it.
    if (normalizeAnswer(suffix) === '') {
      throw new QuestionBankError(`속담 "${record.id}": suffix 가 비어 있습니다.`);
    }
    if (normalizeAnswer(prefix).includes(normalizeAnswer(suffix))) {
      throw new QuestionBankError(`속담 "${record.id}": 단서에 정답이 들어 있습니다.`);
    }
    // A prefix that is not the opening of the proverb means one of the three
    // fields was edited without the others. Checked as a concatenation, not
    // merely as a prefix/suffix pair, so a record cannot lose its middle.
    if (!normalizeAnswer(full).startsWith(normalizeAnswer(prefix))) {
      throw new QuestionBankError(`속담 "${record.id}": prefix 가 full 의 앞부분이 아닙니다.`);
    }
    if (!normalizeAnswer(full).endsWith(normalizeAnswer(suffix))) {
      throw new QuestionBankError(`속담 "${record.id}": suffix 가 full 의 뒷부분이 아닙니다.`);
    }
    if (normalizeAnswer(prefix) + normalizeAnswer(suffix) !== normalizeAnswer(full)) {
      throw new QuestionBankError(`속담 "${record.id}": prefix + suffix 가 full 과 같지 않습니다.`);
    }

    // A hint is a nudge, not a second copy of the answer. Checked on normalized
    // text for the same reason the clue is: spacing must not be able to hide a
    // giveaway. A keyword that is *part* of the missing half is fine and is the
    // point; one that contains the whole of it is not.
    const hint = emptyToNull(record.hint);
    if (hint !== null) {
      const normalizedHint = normalizeAnswer(hint);
      if (normalizedHint.includes(normalizeAnswer(suffix)) || normalizedHint.includes(normalizeAnswer(full))) {
        throw new QuestionBankError(`속담 "${record.id}": 힌트에 정답이 그대로 들어 있습니다.`);
      }
    }

    questions.push({
      mode: 'proverb',
      id: record.id,
      prefix,
      suffix,
      full,
      explanation: emptyToNull(record.explanation),
      hint,
      aliases: normalizeAliasList([full, suffix, ...(record.aliases ?? [])]),
    });
  }

  assertBank(
    '속담',
    questions.map((q) => q.id),
    questions.map((q) => q.aliases),
    questions.map((q) => (q.mode === 'proverb' ? q.prefix : '')),
    options.expectedSize === undefined ? TEXT_BANK_SIZE : options.expectedSize,
  );
  return questions;
}

/** Builds the idiom bank. Both the Hangul reading and the Hanja are accepted. */
export function buildIdiomBank(records: readonly RawIdiom[], options: BankOptions = {}): Question[] {
  const questions: Question[] = [];
  for (const record of records) {
    const answer = record.answer.trim();
    const meaning = record.meaning.trim();
    const hanja = (record.hanja ?? '').trim();

    if (normalizeAnswer(answer) === '') {
      throw new QuestionBankError(`사자성어 "${record.id}": answer 가 비어 있습니다.`);
    }
    if (normalizeAnswer(meaning).includes(normalizeAnswer(answer))) {
      throw new QuestionBankError(`사자성어 "${record.id}": 뜻풀이에 정답이 들어 있습니다.`);
    }
    if (hanja !== '' && normalizeAnswer(meaning).includes(normalizeAnswer(hanja))) {
      throw new QuestionBankError(`사자성어 "${record.id}": 뜻풀이에 한자 정답이 들어 있습니다.`);
    }
    // 사자성어 is four characters by definition, in either script. A record of
    // any other length is a typo, not an idiom.
    if ([...answer].length !== IDIOM_LENGTH) {
      throw new QuestionBankError(`사자성어 "${record.id}": 한글 정답은 ${IDIOM_LENGTH}글자여야 합니다.`);
    }
    if (hanja !== '' && [...hanja].length !== IDIOM_LENGTH) {
      throw new QuestionBankError(`사자성어 "${record.id}": 한자 표기는 ${IDIOM_LENGTH}글자여야 합니다.`);
    }

    questions.push({
      mode: 'idiom',
      id: record.id,
      answer,
      hanja: hanja === '' ? null : hanja,
      meaning,
      explanation: emptyToNull(record.explanation),
      aliases: normalizeAliasList([answer, ...(hanja === '' ? [] : [hanja]), ...(record.aliases ?? [])]),
    });
  }

  assertBank(
    '사자성어',
    questions.map((q) => q.id),
    questions.map((q) => q.aliases),
    questions.map((q) => (q.mode === 'idiom' ? q.meaning : '')),
    options.expectedSize === undefined ? TEXT_BANK_SIZE : options.expectedSize,
  );
  return questions;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Wraps song configs as questions so the engine sees one shape. */
export function songQuestions(songs: readonly SongConfig[]): Question[] {
  return songs.map((song) => ({ mode: 'song', id: song.id, song, aliases: song.aliases }));
}
