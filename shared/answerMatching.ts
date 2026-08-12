/**
 * Answer normalization and alias matching for the song-guessing game.
 *
 * Dependency-free: uses only built-in JS/TS string and Unicode facilities.
 * Designed to be imported unmodified by both the game server (authoritative
 * matching) and any client-side preview/validation code.
 */

/**
 * Normalizes a raw answer string into a comparable canonical form.
 *
 * Steps, in order:
 * 1. Unicode-normalize with NFKC. This composes decomposed Hangul jamo
 *    sequences into precomposed syllable blocks (NFD -> NFC) *and* folds
 *    compatibility forms (full-width Latin, half-width Hangul jamo, etc.)
 *    into their standard equivalents, so visually-identical input typed via
 *    different IMEs/keyboards compares equal.
 * 2. Case-fold (lowercase) for Latin/other cased scripts. Korean has no
 *    case, so this is a no-op for Hangul but required for aliases like
 *    "Dynamite".
 * 3. Strip everything that is not a Unicode letter or number, which removes
 *    whitespace, punctuation, and symbols (spaces, hyphens, apostrophes,
 *    exclamation marks, emoji, etc.) in one pass.
 */
export function normalizeAnswer(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Normalizes a list of aliases, de-duplicates them, and drops any alias
 * that normalizes to an empty string (e.g. an alias that was only
 * punctuation).
 */
export function normalizeAliasList(aliases: readonly string[]): string[] {
  const normalized = aliases.map(normalizeAnswer).filter((alias) => alias.length > 0);
  return Array.from(new Set(normalized));
}

/**
 * A precomputed matcher for a single song's set of accepted aliases.
 * Intended for the server's hot path: build once per round, then call
 * `matches` for every incoming guess without re-normalizing the alias list.
 */
export interface AliasMatcher {
  /** Normalized, de-duplicated aliases this matcher accepts. */
  readonly normalizedAliases: ReadonlySet<string>;
  /** Returns true if `guess` normalizes to one of the accepted aliases. */
  matches(guess: string): boolean;
}

export function createAliasMatcher(aliases: readonly string[]): AliasMatcher {
  const normalizedAliases = new Set(normalizeAliasList(aliases));
  return {
    normalizedAliases,
    matches(guess: string): boolean {
      const normalized = normalizeAnswer(guess);
      return normalized.length > 0 && normalizedAliases.has(normalized);
    },
  };
}

/**
 * Convenience one-shot check, equivalent to
 * `createAliasMatcher(aliases).matches(guess)`. Prefer `createAliasMatcher`
 * when checking many guesses against the same alias list (e.g. once per
 * round on the server), since it avoids re-normalizing the aliases on every
 * call.
 */
export function isCorrectAnswer(guess: string, aliases: readonly string[]): boolean {
  return createAliasMatcher(aliases).matches(guess);
}
