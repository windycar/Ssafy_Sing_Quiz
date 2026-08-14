/**
 * Turns a host's playlist file into the songs a room will play.
 *
 * Two kinds of line, from `shared/playlist.ts`:
 *
 * - with answers — used verbatim, so a host can play anything at all;
 * - link only — the video's title is read and matched against the catalog.
 *
 * Resolution happens once, at startup, on purpose: an unreachable video or a
 * title nobody can identify should stop the operator before the event, not
 * surface as a dead round in front of a room.
 */

import { expandTitleAliases } from '../shared/songCatalog.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';
import { identifySongFromVideo } from '../shared/youtube.ts';
import type { IdentifiableSong } from '../shared/youtube.ts';
import type { PlaylistEntry } from '../shared/playlist.ts';
import { lookupVideo } from './youtubeLookup.ts';
import type { VideoLookup } from './youtubeLookup.ts';

export interface ResolvedSong {
  record: RawSongRecord;
  /** How the answer was decided, for the startup report. */
  source: 'file' | 'catalog';
  /** What the video is called, when it had to be looked up. */
  videoTitle?: string;
}

export interface UnresolvedSong {
  line: number;
  videoId: string;
  message: string;
}

export interface PlaylistResolution {
  songs: ResolvedSong[];
  failures: UnresolvedSong[];
}

/** Injectable so the resolver can be tested without the network. */
export type TitleLookup = (videoId: string) => Promise<VideoLookup>;

/**
 * @param catalog Songs a link-only line may be identified as. Pass an empty
 *   list to require every line to carry its own answers.
 */
export async function resolvePlaylist(
  entries: readonly PlaylistEntry[],
  catalog: readonly IdentifiableSong[],
  lookup: TitleLookup = lookupVideo,
): Promise<PlaylistResolution> {
  const songs: ResolvedSong[] = [];
  const failures: UnresolvedSong[] = [];

  for (const entry of entries) {
    const id = `yt-${entry.videoId}`;
    const common = {
      id,
      youtubeId: entry.videoId,
      youtubeStart: entry.startSeconds ?? 0,
      source: 'playlist',
    };

    if (entry.answers.length > 0) {
      // The host wrote the answers, so nothing needs looking up — and the
      // first one is what the reveal screen shows.
      const [title = '', ...rest] = entry.answers;
      songs.push({
        record: { ...common, title, artist: '', aliases: [...expandTitleAliases(title), ...rest] },
        source: 'file',
      });
      continue;
    }

    const found = await lookup(entry.videoId);
    if (!found.ok) {
      failures.push({ line: entry.line, videoId: entry.videoId, message: found.message });
      continue;
    }

    const identified = identifySongFromVideo(found.title, found.channel, catalog);
    if (identified === null) {
      failures.push({
        line: entry.line,
        videoId: entry.videoId,
        message:
          `"${found.title}" 이(가) 어느 곡인지 찾지 못했습니다. ` +
          '이 줄 뒤에 " | 정답" 을 직접 적어 주세요.',
      });
      continue;
    }

    songs.push({
      record: {
        ...common,
        title: identified.song.title,
        artist: identified.song.artist,
        aliases: expandTitleAliases(identified.song.title),
      },
      source: 'catalog',
      videoTitle: found.title,
    });
  }

  return { songs, failures };
}
