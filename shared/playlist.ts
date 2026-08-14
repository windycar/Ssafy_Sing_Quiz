/**
 * The host's setlist, as a text file.
 *
 * Pasting twenty links through a web form before an event is worse than
 * editing twenty lines in a text file, and a file survives a reload, a crash,
 * and next year's event. This module only parses; resolving the titles needs
 * the network and belongs to the server.
 *
 * ```
 * # 한 줄에 한 곡. #으로 시작하는 줄은 무시됩니다.
 * https://youtu.be/AbCdEfGhIjK?t=45
 * https://youtu.be/LmNoPqRsTuV | 좋은 날
 * https://youtu.be/WxYzAbCdEfG?t=60 | Hype Boy, 하입보이
 * ```
 *
 * A line with no answers is resolved against the catalog from the video's
 * title; a line with answers uses them verbatim, which is what lets a host
 * play a song the catalog has never heard of.
 */

import { parseYouTubeLink } from './youtube.ts';

export interface PlaylistEntry {
  /** 1-based, so an error message can name the line the host has to fix. */
  line: number;
  videoId: string;
  startSeconds: number | null;
  /** Empty when the host wants the answer worked out from the video title. */
  answers: string[];
}

export interface PlaylistProblem {
  line: number;
  /** The line as written, so the host can find it. */
  text: string;
  message: string;
}

export interface Playlist {
  entries: PlaylistEntry[];
  problems: PlaylistProblem[];
}

/** Splits on the first separator only, so an answer may itself contain one. */
const SEPARATOR = /\s*[|\t]\s*/u;

/**
 * Parses the file. Never throws: a bad line becomes a problem the host can
 * read, and the good lines still load, because a typo on line 7 should not
 * cost someone their other nineteen songs an hour before an event.
 */
export function parsePlaylist(text: string): Playlist {
  const entries: PlaylistEntry[] = [];
  const problems: PlaylistProblem[] = [];
  const seen = new Map<string, number>();

  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const [linkPart = '', answerPart] = splitOnce(trimmed);
    const link = parseYouTubeLink(linkPart);
    if (link === null) {
      problems.push({ line, text: trimmed, message: '유튜브 링크를 읽지 못했습니다.' });
      continue;
    }

    const duplicate = seen.get(link.videoId);
    if (duplicate !== undefined) {
      problems.push({
        line,
        text: trimmed,
        message: `${duplicate}번째 줄과 같은 영상입니다.`,
      });
      continue;
    }
    seen.set(link.videoId, line);

    const answers =
      answerPart === undefined
        ? []
        : answerPart
            .split(',')
            .map((answer) => answer.trim())
            .filter((answer) => answer !== '');

    if (answerPart !== undefined && answers.length === 0) {
      problems.push({
        line,
        text: trimmed,
        message: '구분자 뒤에 정답이 비어 있습니다. 정답을 적거나 구분자를 지우세요.',
      });
      continue;
    }

    entries.push({ line, videoId: link.videoId, startSeconds: link.startSeconds, answers });
  }

  return { entries, problems };
}

function splitOnce(line: string): [string, string | undefined] {
  const match = SEPARATOR.exec(line);
  if (match === null || match.index === undefined) return [line, undefined];
  return [line.slice(0, match.index), line.slice(match.index + match[0].length)];
}
