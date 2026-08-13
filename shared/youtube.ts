/**
 * YouTube links as a song source.
 *
 * The host sits at the front computer and its browser plays the video through
 * the room speakers; players only ever type answers. That inverts one rule
 * from claude-analysis.md §7: a media URL normally goes to everybody, but a
 * YouTube video ID must go to the host alone, because the video's title *is*
 * the answer. `toRoundPublicPayload` enforces that; this module only parses
 * and identifies.
 *
 * Identification is deliberately conservative. A video title is written by
 * whoever uploaded it, so it is matched against the catalog rather than
 * trusted: the catalog decides what the answer is, and an unmatched link is
 * reported as unmatched instead of inventing a song.
 */

import { normalizeAnswer } from './answerMatching.ts';

export interface ParsedYouTubeLink {
  videoId: string;
  /** From `&t=` / `#t=`. Null when the link carries no start time. */
  startSeconds: number | null;
}

/** Video IDs are 11 chars of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[\w-]{11}$/u;

/** `t=90`, `t=90s`, `t=1m30s`, `t=1h2m3s`. */
function parseTimeParam(raw: string | null): number | null {
  if (raw === null || raw === '') return null;

  if (/^\d+$/u.test(raw)) return Number(raw);

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/iu.exec(raw);
  if (match === null || match[0] === '') return null;
  const [, h, m, s] = match;
  const seconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return seconds > 0 ? seconds : null;
}

/**
 * Accepts the forms a host actually pastes: a watch URL, a share link, an
 * embed URL, or a bare video ID. Returns null for anything else rather than
 * guessing — a wrong ID would play the wrong song in front of a room.
 */
export function parseYouTubeLink(input: string): ParsedYouTubeLink | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  if (VIDEO_ID.test(trimmed)) return { videoId: trimmed, startSeconds: null };

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./u, '').toLowerCase();
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0] ?? null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const fromQuery = url.searchParams.get('v');
    if (fromQuery !== null) {
      videoId = fromQuery;
    } else {
      // /embed/ID, /shorts/ID, /live/ID
      const segments = url.pathname.split('/').filter((part) => part !== '');
      if (segments.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(segments[0] as string)) {
        videoId = segments[1] as string;
      }
    }
  }

  if (videoId === null || !VIDEO_ID.test(videoId)) return null;

  const startSeconds =
    parseTimeParam(url.searchParams.get('t')) ??
    parseTimeParam(url.searchParams.get('start')) ??
    parseTimeParam(url.hash.startsWith('#t=') ? url.hash.slice(3) : null);

  return { videoId, startSeconds };
}

/** The subset of a catalog record this module needs to identify a video. */
export interface IdentifiableSong {
  id: string;
  title: string;
  artist: string;
}

export interface TitleMatch<T extends IdentifiableSong> {
  song: T;
  /** True when the artist was corroborated, not just the title. */
  artistConfirmed: boolean;
}

/**
 * Below this many normalized characters a title proves nothing on its own:
 * "HIP" is inside "hiphop", "Oh" is inside "Johnny", "200" is inside "2003".
 * Such songs are only matched when the artist appears too.
 */
const SHORT_TITLE_CHARS = 4;

/** "경서예지, 전건호" and "IU & Suga" both list several people; any one counts. */
function artistKeys(artist: string): string[] {
  return artist
    .split(/[,&×\/]|\bx\b/iu)
    .map((part) => normalizeAnswer(part))
    .filter((key) => key.length >= 2);
}

/**
 * Identifies which catalog song a video is, from its title and channel name.
 *
 * Uploaders write titles like "[MV] AKMU(악뮤) - 200%" or
 * "뉴진스 (NewJeans) 'Hype Boy' Official MV", so the catalog entry is looked
 * for *inside* the video title rather than compared to it. The longest
 * matching title wins, and an artist hit outranks any title length — a
 * corroborated match is always better than a longer uncorroborated one.
 *
 * Returns null when nothing matches, which is the correct answer for a link
 * to a song that is not in the catalog.
 */
export function identifySongFromVideo<T extends IdentifiableSong>(
  videoTitle: string,
  channelName: string | null,
  songs: readonly T[],
): TitleMatch<T> | null {
  const haystack = normalizeAnswer(`${videoTitle} ${channelName ?? ''}`);
  if (haystack === '') return null;

  let best: (TitleMatch<T> & { score: number }) | null = null;

  for (const song of songs) {
    const titleKey = normalizeAnswer(song.title);
    if (titleKey === '' || !haystack.includes(titleKey)) continue;

    const artistConfirmed = artistKeys(song.artist).some((key) => haystack.includes(key));
    if (titleKey.length < SHORT_TITLE_CHARS && !artistConfirmed) continue;

    // The artist bonus is larger than any realistic title length, so it
    // dominates rather than merely nudging.
    const score = titleKey.length + (artistConfirmed ? 1_000 : 0);
    if (best === null || score > best.score) best = { song, artistConfirmed, score };
  }

  if (best === null) return null;
  return { song: best.song, artistConfirmed: best.artistConfirmed };
}

/** oEmbed needs no API key and no account, which is why it is used here. */
export function oEmbedUrl(videoId: string): string {
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`;
}

export interface OEmbedResponse {
  title: string;
  author_name?: string;
}
