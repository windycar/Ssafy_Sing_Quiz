/**
 * Asking YouTube what a video is called.
 *
 * Shared by the host's paste-a-link route (`http.ts`) and the startup
 * playlist loader (`playlistLoader.ts`), so both report the same failures in
 * the same words.
 */

import { oEmbedUrl } from '../shared/youtube.ts';
import type { OEmbedResponse } from '../shared/youtube.ts';

/** A slow or unreachable YouTube must not hold a host's request open. */
const OEMBED_TIMEOUT_MS = 8_000;

export type VideoLookup =
  | { ok: true; title: string; channel: string | null }
  | { ok: false; message: string };

/**
 * oEmbed is used because it needs no API key and no account. The request goes
 * to a URL this process builds from an already-validated 11-character id, so a
 * host cannot steer this fetch anywhere else — which is the only reason a
 * server-side fetch of a user-supplied link is safe here.
 */
export async function lookupVideo(videoId: string): Promise<VideoLookup> {
  let response: Response;
  try {
    response = await fetch(oEmbedUrl(videoId), {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    return { ok: false, message: '유튜브에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { ok: false, message: '비공개이거나 삭제된 영상입니다. 다른 링크를 사용해 주세요.' };
  }
  if (!response.ok) {
    return { ok: false, message: `유튜브가 응답하지 않았습니다 (HTTP ${response.status}).` };
  }

  let body: OEmbedResponse;
  try {
    body = (await response.json()) as OEmbedResponse;
  } catch {
    return { ok: false, message: '유튜브 응답을 이해하지 못했습니다.' };
  }

  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return { ok: false, message: '영상 제목을 읽지 못했습니다.' };

  return {
    ok: true,
    title,
    channel: typeof body.author_name === 'string' ? body.author_name : null,
  };
}
