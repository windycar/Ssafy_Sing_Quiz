/**
 * Song catalog: turns raw, host-supplied or recovered song records into
 * validated, round-ready configs for the authoritative server.
 *
 * This is the integration seam between the data recovered on `agent/codex`
 * (`data/songs.recovered.json`) and the `SongConfig` shape defined in
 * `docs/realtime-protocol.md` §1. It is dependency-free and shares the same
 * normalization rules as `answerMatching.ts`, so a title that this module
 * accepts as an alias is judged identically by the server at round time.
 *
 * Deliberately NOT fuzzy: alias expansion is a fixed, auditable set of
 * deterministic rewrites applied once when the catalog is built. Matching
 * itself stays exact-normalized-match (see claude-analysis.md §8), so
 * "who was first and correct" remains unambiguous.
 */

import { normalizeAnswer, normalizeAliasList, createAliasMatcher } from './answerMatching.ts';
import type { AliasMatcher } from './answerMatching.ts';

/** A raw record as found in `data/songs.recovered.json` (codex branch). */
export interface RawSongRecord {
  id: string;
  artist: string;
  title: string;
  aliases?: readonly string[];
  /** Null in recovered data — a host must supply a licensed URL. */
  mediaUrl?: string | null;
  /** Seconds in the recovered file; null until a host sets the clip. */
  clipStart?: number | null;
  clipEnd?: number | null;
  /**
   * A YouTube video the host plays in the room instead of the server serving
   * audio. Present means "live playback": no `mediaUrl` is needed, and this id
   * must never reach a player (see `toRoundPublicPayload`).
   */
  youtubeId?: string | null;
  /** Seconds into the video to start from. Defaults to 0. */
  youtubeStart?: number | null;
  source?: string;
}

/** Round-ready config. Mirrors `SongConfig` in realtime-protocol.md §1. */
export interface SongConfig {
  id: string;
  title: string;
  artist: string;
  aliases: string[];
  /** Empty for a YouTube song: nothing is served to players to play. */
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  /**
   * Secret, like the title. Only the host's machine may learn it, because the
   * video's own title gives the answer away.
   */
  youtubeId: string | null;
}

export interface CatalogIssue {
  songId: string;
  /** Machine-readable so a host UI can group/localize these. */
  code:
    | 'MISSING_TITLE'
    | 'MISSING_MEDIA_URL'
    | 'MISSING_CLIP_RANGE'
    | 'CLIP_RANGE_INVALID'
    | 'CLIP_TOO_SHORT'
    | 'CLIP_TOO_LONG'
    | 'NO_USABLE_ALIAS'
    | 'DUPLICATE_ALIAS'
    | 'INVALID_YOUTUBE_ID';
  message: string;
}

export interface SongCatalog {
  /** Songs that passed every check and may be played. */
  playable: SongConfig[];
  /** Everything that blocked a song, or that a host should review. */
  issues: CatalogIssue[];
}

/** Product spec: clips are 5–15 seconds. */
export const MIN_CLIP_MS = 5_000;
export const MAX_CLIP_MS = 15_000;

/**
 * How long the host plays a YouTube video for.
 *
 * A round lasts this plus `ANSWER_GRACE_MS` (10 s) from `server/gameRoom.ts`,
 * which makes one round exactly a minute. Those two constants live in
 * different modules on purpose — `shared/` must not import from `server/` —
 * so `gameRoom.test.ts` asserts the minute they add up to. Change one and
 * that test tells you.
 */
export const YOUTUBE_CLIP_MS = 50_000;

/** Same alphabet and length YouTube itself uses. */
const YOUTUBE_ID = /^[\w-]{11}$/u;

/**
 * Parenthetical segments that are credits, not alternate titles. A player
 * will never type "feat. 박봄" as the answer, and accepting it as an alias
 * would let a lucky guess of a featured artist's name win the round.
 */
const CREDIT_SEGMENT = /^(feat\.?|ft\.?|featuring|with|prod\.?|inst\.?|remix|ver\.?|version)\b/i;

const BRACKETED_SEGMENT = /[([（【]([^)\]）】]*)[)\]）】]/gu;

/**
 * Expands a title into the set of strings a player might reasonably type.
 *
 * Rules, applied to the title only (host-supplied aliases are passed
 * through untouched):
 * 1. The full title is always accepted.
 * 2. The title with all bracketed segments removed is accepted
 *    ("피노키오 (Danger)" -> "피노키오").
 * 3. Each bracketed segment is accepted on its own ("Danger"), UNLESS it
 *    looks like a credit ("Feat. 박봄", "Prod. by X") — see CREDIT_SEGMENT.
 *
 * Results are de-duplicated by normalized form, preserving first-seen order.
 */
export function expandTitleAliases(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string): void => {
    const trimmed = candidate.trim();
    const normalized = normalizeAnswer(trimmed);
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(trimmed);
  };

  push(title);

  const segments: string[] = [];
  for (const match of title.matchAll(BRACKETED_SEGMENT)) {
    segments.push(match[1] ?? '');
  }

  push(title.replace(BRACKETED_SEGMENT, ' ').replace(/\s+/gu, ' '));

  for (const segment of segments) {
    if (CREDIT_SEGMENT.test(segment.trim())) continue;
    push(segment);
  }

  return out;
}

function clipToMs(seconds: number | null | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000);
}

/**
 * Validates and normalizes raw records into a playable catalog.
 *
 * Cross-song alias collisions are reported as `DUPLICATE_ALIAS` and the
 * colliding alias is dropped from the *later* song, so no single guess can
 * ever be correct for two different songs. The songs themselves stay
 * playable as long as they retain at least one unique alias.
 */
export function buildSongCatalog(records: readonly RawSongRecord[]): SongCatalog {
  const playable: SongConfig[] = [];
  const issues: CatalogIssue[] = [];
  const claimedAliases = new Map<string, string>(); // normalized alias -> songId

  for (const record of records) {
    const songId = record.id;
    const title = (record.title ?? '').trim();

    if (title.length === 0) {
      issues.push({ songId, code: 'MISSING_TITLE', message: '곡 제목이 비어 있습니다.' });
      continue;
    }

    // Playability is checked before aliases are claimed: a song that can
    // never be played must not reserve an alias and push a playable song
    // into a spurious DUPLICATE_ALIAS.
    const youtubeId = (record.youtubeId ?? '').trim();
    let mediaUrl: string;
    let clipStartMs: number;
    let clipEndMs: number;

    if (youtubeId.length > 0) {
      // Live playback: the host's browser plays the video in the room, so the
      // server serves no audio and the 5–15 s clip rule does not apply.
      if (!YOUTUBE_ID.test(youtubeId)) {
        issues.push({
          songId,
          code: 'INVALID_YOUTUBE_ID',
          message: `유튜브 영상 ID "${youtubeId}" 형식이 올바르지 않습니다.`,
        });
        continue;
      }
      const startMs = clipToMs(record.youtubeStart) ?? 0;
      mediaUrl = '';
      clipStartMs = Math.max(0, startMs);
      clipEndMs = clipStartMs + YOUTUBE_CLIP_MS;
    } else {
      const url = (record.mediaUrl ?? '').trim();
      if (url.length === 0) {
        issues.push({
          songId,
          code: 'MISSING_MEDIA_URL',
          message: '재생 가능한 미디어 URL이 없습니다. 방장이 등록해야 합니다.',
        });
        continue;
      }

      const start = clipToMs(record.clipStart);
      const end = clipToMs(record.clipEnd);
      if (start === null || end === null) {
        issues.push({
          songId,
          code: 'MISSING_CLIP_RANGE',
          message: 'clipStart/clipEnd 값이 없습니다.',
        });
        continue;
      }

      const duration = end - start;
      if (start < 0 || duration <= 0) {
        issues.push({
          songId,
          code: 'CLIP_RANGE_INVALID',
          message: 'clipEnd 는 clipStart 보다 커야 하며 clipStart 는 0 이상이어야 합니다.',
        });
        continue;
      }
      if (duration < MIN_CLIP_MS) {
        issues.push({
          songId,
          code: 'CLIP_TOO_SHORT',
          message: `클립 길이 ${duration}ms 는 최소 ${MIN_CLIP_MS}ms 보다 짧습니다.`,
        });
        continue;
      }
      if (duration > MAX_CLIP_MS) {
        issues.push({
          songId,
          code: 'CLIP_TOO_LONG',
          message: `클립 길이 ${duration}ms 는 최대 ${MAX_CLIP_MS}ms 를 초과합니다.`,
        });
        continue;
      }

      mediaUrl = url;
      clipStartMs = start;
      clipEndMs = end;
    }

    const candidates = [...expandTitleAliases(title), ...(record.aliases ?? [])];
    const aliases: string[] = [];
    for (const alias of normalizeAliasList(candidates)) {
      const owner = claimedAliases.get(alias);
      if (owner !== undefined && owner !== songId) {
        issues.push({
          songId,
          code: 'DUPLICATE_ALIAS',
          message: `정답 "${alias}" 이(가) 다른 곡(${owner})과 겹쳐 이 곡에서는 제외되었습니다.`,
        });
        continue;
      }
      claimedAliases.set(alias, songId);
      aliases.push(alias);
    }

    if (aliases.length === 0) {
      issues.push({
        songId,
        code: 'NO_USABLE_ALIAS',
        message: '정규화 후 남는 정답 문자열이 없습니다.',
      });
      continue;
    }

    playable.push({
      id: songId,
      title,
      artist: (record.artist ?? '').trim(),
      aliases,
      mediaUrl,
      clipStartMs,
      clipEndMs,
      youtubeId: youtubeId.length > 0 ? youtubeId : null,
    });
  }

  return { playable, issues };
}

/**
 * A host-supplied media assignment for one song.
 *
 * The recovered catalog ships with `mediaUrl: null` on every record, so this
 * is the only way a real song becomes playable. Seconds rather than
 * milliseconds, to match `RawSongRecord` and the source data.
 *
 * Two mutually exclusive kinds: a hosted audio clip (`mediaUrl` + a 5–15 s
 * range), or a YouTube video the host plays in the room (`youtubeId`).
 */
export type MediaRegistration =
  | {
      id: string;
      mediaUrl: string;
      clipStart: number;
      clipEnd: number;
      youtubeId?: undefined;
      youtubeStart?: undefined;
    }
  | {
      id: string;
      youtubeId: string;
      /** Seconds into the video. Omitted means from the beginning. */
      youtubeStart?: number;
      mediaUrl?: undefined;
      clipStart?: undefined;
      clipEnd?: undefined;
    };

/**
 * Overlays host registrations onto raw records, returning a new array.
 *
 * Registrations for unknown song ids are ignored rather than appended: a host
 * may only fill in media for songs the server already knows about, so a
 * request body can never inject a song (and therefore an answer) of its own.
 */
export function applyMediaRegistrations(
  records: readonly RawSongRecord[],
  registrations: readonly MediaRegistration[],
): RawSongRecord[] {
  if (registrations.length === 0) return [...records];

  // Last registration for an id wins, so a host correcting a clip in one
  // request body does not depend on array order elsewhere.
  const byId = new Map<string, MediaRegistration>();
  for (const registration of registrations) byId.set(registration.id, registration);

  return records.map((record) => {
    const registration = byId.get(record.id);
    if (registration === undefined) return record;

    // The two kinds are exclusive, so registering one clears the other. A song
    // left holding both would depend on `buildSongCatalog`'s branch order to
    // decide how it plays, which is not something a host can see.
    if (registration.youtubeId !== undefined) {
      return {
        ...record,
        youtubeId: registration.youtubeId,
        youtubeStart: registration.youtubeStart ?? 0,
        mediaUrl: null,
        clipStart: null,
        clipEnd: null,
      };
    }
    return {
      ...record,
      mediaUrl: registration.mediaUrl,
      clipStart: registration.clipStart,
      clipEnd: registration.clipEnd,
      youtubeId: null,
      youtubeStart: null,
    };
  });
}

/**
 * Builds the per-round matcher the server uses on its hot path. Kept here
 * (rather than in the server) so the catalog's alias set and the judging
 * alias set can never drift apart.
 */
export function createSongMatcher(song: SongConfig): AliasMatcher {
  return createAliasMatcher(song.aliases);
}

/**
 * The public payload for a round. Exists so the server has exactly one
 * function that decides what leaves the process before REVEAL — see
 * claude-analysis.md §7. Never returns `title`, `artist`, `aliases`, or
 * `youtubeId`.
 *
 * `youtubeId` is as secret as the title: the video's own title names the song,
 * so handing it to a player is handing them the answer. It reaches the host
 * alone, through a separate targeted message (`ROUND_CUE`).
 */
export function toRoundPublicPayload(
  song: SongConfig,
  index: number,
  totalSongs: number,
): {
  song: { index: number; totalSongs: number; clipDurationMs: number };
  mediaUrl: string;
  clipStartMs: number;
  clipEndMs: number;
  /** True when the host plays the song in the room and nobody else plays anything. */
  livePlayback: boolean;
} {
  const livePlayback = song.youtubeId !== null;
  return {
    song: {
      index,
      totalSongs,
      clipDurationMs: song.clipEndMs - song.clipStartMs,
    },
    // Not merely empty-by-accident: a live-playback round has no URL for a
    // player to fetch, and the client keys off `livePlayback`, not this.
    mediaUrl: livePlayback ? '' : song.mediaUrl,
    clipStartMs: song.clipStartMs,
    clipEndMs: song.clipEndMs,
    livePlayback,
  };
}
