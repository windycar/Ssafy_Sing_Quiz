/**
 * HTTP surface: room creation, catalog lookup, and the static client.
 *
 * The WebSocket protocol has no "create a room" message, and it cannot have
 * one: a host needs a `roomId` and a `hostToken` *before* there is a room to
 * connect to. That bootstrap is this file's reason to exist, and it is the
 * last piece named as missing in docs/integration-plan.md §3 step 4.
 *
 * Everything here is request/response only. No game state is mutated except
 * through `GameServer`, and no route ever returns a song title for a round in
 * progress — see `GameServer.listSongs` and `selectSongs` for why the
 * candidate pool being readable is not the same as the answer being readable.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateRoomOptions, GameServer, RoomCreation } from './index.ts';
import type { StaticHandler } from './staticFiles.ts';
import type { CatalogIssue, MediaRegistration } from '../shared/songCatalog.ts';
import { GAME_MODES, isGameMode } from '../shared/questions.ts';
import { identifySongFromVideo, parseYouTubeLink } from '../shared/youtube.ts';
import { lookupVideo } from './youtubeLookup.ts';

/** Refuses to hold more than this many rooms at once (memory is the limit). */
export const MAX_ROOMS = 500;
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_MEDIA_URL_LENGTH = 2048;
/** A hundred one-minute rounds is already a long event; this is the ceiling. */
export const MAX_SONGS_PER_GAME = 100;
export const MAX_MEDIA_REGISTRATIONS = 1_000;

/**
 * Creating a room allocates memory and a join code, so it is metered far more
 * tightly than reads. Closes the "방 생성·참여 요청 빈도 제한" gap recorded as
 * unimplemented in README and docs/OPERATIONS.md.
 */
export const CREATE_ROOM_RATE = { limit: 10, windowMs: 60_000 } as const;
export const READ_RATE = { limit: 120, windowMs: 60_000 } as const;

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window counter keyed by client address.
 *
 * Fixed rather than sliding because the failure mode of a fixed window — up to
 * 2x the limit across a window boundary — is irrelevant at these limits, and a
 * sliding window costs per-request bookkeeping for no benefit here.
 */
export function createRateLimiter(rate: RateLimit): (key: string, now: number) => boolean {
  const windows = new Map<string, { start: number; count: number }>();

  return (key, now) => {
    const window = windows.get(key);
    if (window === undefined || now - window.start >= rate.windowMs) {
      // Expired entries are dropped as they are re-seen. A key that never
      // returns is collected by the sweep below rather than lingering forever.
      if (windows.size > 10_000) {
        for (const [existing, value] of windows) {
          if (now - value.start >= rate.windowMs) windows.delete(existing);
        }
      }
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (window.count >= rate.limit) return false;
    window.count += 1;
    return true;
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only `http:`/`https:` may reach an `<audio src>`. Without this a request
 * body could hand the client a `javascript:` or `data:` URL and turn host
 * media registration into stored XSS for everyone in the room.
 */
export function isSafeMediaUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseMediaRegistrations(raw: unknown): ParseResult<MediaRegistration[]> {
  if (!Array.isArray(raw)) return { ok: false, message: 'media 는 배열이어야 합니다.' };
  if (raw.length > MAX_MEDIA_REGISTRATIONS) {
    return { ok: false, message: `media 항목은 최대 ${MAX_MEDIA_REGISTRATIONS}개까지 등록할 수 있습니다.` };
  }

  const out: MediaRegistration[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return { ok: false, message: 'media 항목은 객체여야 합니다.' };
    const { id, mediaUrl, clipStart, clipEnd, youtubeId, youtubeStart } = entry;

    if (typeof id !== 'string' || id.length === 0) return { ok: false, message: 'media.id 가 필요합니다.' };

    // A YouTube registration carries no URL and no clip range: the host plays
    // the video in the room, so there is nothing for the server to serve.
    if (youtubeId !== undefined) {
      if (typeof youtubeId !== 'string' || parseYouTubeLink(youtubeId) === null) {
        return { ok: false, message: `"${id}" 의 youtubeId 형식이 올바르지 않습니다.` };
      }
      if (
        youtubeStart !== undefined &&
        (typeof youtubeStart !== 'number' || !Number.isFinite(youtubeStart) || youtubeStart < 0)
      ) {
        return { ok: false, message: `"${id}" 의 youtubeStart 는 0 이상의 초 단위 숫자여야 합니다.` };
      }
      out.push({
        id,
        youtubeId: parseYouTubeLink(youtubeId)!.videoId,
        ...(youtubeStart === undefined ? {} : { youtubeStart }),
      });
      continue;
    }

    if (typeof mediaUrl !== 'string' || !isSafeMediaUrl(mediaUrl)) {
      return { ok: false, message: `"${id}" 의 mediaUrl 은 http/https 주소여야 합니다.` };
    }
    if (typeof clipStart !== 'number' || !Number.isFinite(clipStart) || clipStart < 0) {
      return { ok: false, message: `"${id}" 의 clipStart 는 0 이상의 초 단위 숫자여야 합니다.` };
    }
    if (typeof clipEnd !== 'number' || !Number.isFinite(clipEnd) || clipEnd <= clipStart) {
      return { ok: false, message: `"${id}" 의 clipEnd 는 clipStart 보다 커야 합니다.` };
    }
    // The 5–15 s product range is NOT enforced here on purpose: buildSongCatalog
    // owns that rule and reports it per song, so a host sees which clip is out
    // of range instead of losing the whole request to one bad row.
    out.push({ id, mediaUrl, clipStart, clipEnd });
  }
  return { ok: true, value: out };
}

export function parseCreateRoomRequest(raw: unknown): ParseResult<CreateRoomOptions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, message: '요청 본문은 JSON 객체여야 합니다.' };

  const options: CreateRoomOptions = {};

  const { mode, songCount, songIds, shuffle, media } = raw;

  // Rejected rather than defaulted: a host who typed a mode this build does
  // not have should be told, not quietly given the song game.
  if (mode !== undefined) {
    if (!isGameMode(mode)) {
      return { ok: false, message: `mode 는 ${GAME_MODES.join(', ')} 중 하나여야 합니다.` };
    }
    options.mode = mode;
  }

  if (songCount !== undefined) {
    if (typeof songCount !== 'number' || !Number.isInteger(songCount) || songCount < 1 || songCount > MAX_SONGS_PER_GAME) {
      return { ok: false, message: `songCount 는 1 이상 ${MAX_SONGS_PER_GAME} 이하의 정수여야 합니다.` };
    }
    options.songCount = songCount;
  }

  if (songIds !== undefined) {
    if (!Array.isArray(songIds) || songIds.some((id) => typeof id !== 'string')) {
      return { ok: false, message: 'songIds 는 문자열 배열이어야 합니다.' };
    }
    options.songIds = songIds as string[];
  }

  if (shuffle !== undefined) {
    if (typeof shuffle !== 'boolean') return { ok: false, message: 'shuffle 은 true/false 여야 합니다.' };
    options.shuffle = shuffle;
  }

  if (media !== undefined) {
    const parsed = parseMediaRegistrations(media);
    if (!parsed.ok) return parsed;
    options.media = parsed.value;
  }

  return { ok: true, value: options };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export interface RequestHandlerOptions {
  game: GameServer;
  staticHandler?: StaticHandler | undefined;
  /** Origins allowed to call the API cross-origin. Empty disables the check. */
  allowedOrigins?: readonly string[];
  createRate?: RateLimit;
  readRate?: RateLimit;
  now?: () => number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A room-creation response carries a host token. It must never sit in a
    // proxy or browser cache.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Reads a JSON body, refusing anything over the cap. */
async function readJsonBody(request: IncomingMessage): Promise<ParseResult<unknown>> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, message: '요청 본문이 너무 큽니다.' };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // Checked while streaming too: content-length is client-supplied and a
    // chunked request does not send one at all.
    if (size > MAX_BODY_BYTES) return { ok: false, message: '요청 본문이 너무 큽니다.' };
    chunks.push(buffer);
  }

  if (size === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, message: 'JSON 을 해석할 수 없습니다.' };
  }
}

/**
 * Applies CORS for the allowed origins.
 *
 * An empty allow-list echoes the request origin, matching what
 * `attachWebSocketServer` does with the same option: both checks are off
 * together, or on together, and both are only safe to leave off locally.
 * Returns false when the request came from a rejected origin.
 */
function applyCors(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return true;

  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return false;

  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('access-control-allow-headers', `content-type, ${HOST_TOKEN_HEADER}`);
  response.setHeader('access-control-max-age', '600');
  return true;
}

export function createRequestHandler(
  options: RequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const { game, staticHandler } = options;
  const allowedOrigins = options.allowedOrigins ?? [];
  const now = options.now ?? Date.now;
  const allowCreate = createRateLimiter(options.createRate ?? CREATE_ROOM_RATE);
  const allowRead = createRateLimiter(options.readRate ?? READ_RATE);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const { pathname } = url;
    // Behind a reverse proxy every request appears to come from the proxy, so
    // the limiter degrades to a global one. See docs/OPERATIONS.md.
    const client = request.socket.remoteAddress ?? 'unknown';

    if (!applyCors(request, response, allowedOrigins)) {
      sendJson(response, 403, { error: 'ORIGIN_NOT_ALLOWED', message: '허용되지 않은 출처입니다.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    if (pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, {
        status: 'ok',
        playableSongs: game.baseCatalog.playable.length,
        rooms: game.roomCount(),
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const isCreate = pathname === '/api/rooms' && request.method === 'POST';
      if (!(isCreate ? allowCreate : allowRead)(client, now())) {
        sendJson(response, 429, { error: 'RATE_LIMITED', message: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      await handleApi(request, response, pathname, game);
      return;
    }

    if (staticHandler !== undefined && (request.method === 'GET' || request.method === 'HEAD')) {
      if (await staticHandler(pathname, response)) return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND', message: '경로를 찾을 수 없습니다.' });
  };

  return (request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'INTERNAL', message: '서버 오류입니다.' });
      else response.end();
    });
  };
}

/** Header carrying the host secret. Never a query parameter — those get logged. */
export const HOST_TOKEN_HEADER = 'x-host-token';

/**
 * Resolves a room and proves the caller is its host.
 *
 * Answers 404 for both "no such room" and "wrong token", so this endpoint
 * cannot be used to confirm that a guessed room code exists.
 */
function authorizeRoom(request: IncomingMessage, response: ServerResponse, game: GameServer, roomId: string) {
  const room = game.getRoom(roomId);
  const token = request.headers[HOST_TOKEN_HEADER];

  if (room === undefined || typeof token !== 'string' || !room.authorize(token)) {
    sendJson(response, 404, { error: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없거나 방장 권한이 없습니다.' });
    return null;
  }
  return room;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  game: GameServer,
): Promise<void> {
  if (pathname === '/api/rooms' && request.method === 'POST') {
    if (game.roomCount() >= MAX_ROOMS) {
      sendJson(response, 503, { error: 'TOO_MANY_ROOMS', message: '서버가 수용 가능한 방 수를 초과했습니다.' });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { error: 'INVALID_BODY', message: body.message });
      return;
    }
    const parsed = parseCreateRoomRequest(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: 'INVALID_BODY', message: parsed.message });
      return;
    }

    // A room may legitimately start with no playable songs: the host needs its
    // token before they can read the catalog and register media. `HOST_START`
    // is the gate that refuses to run an empty setlist.
    const created = game.createRoom(parsed.value);
    sendJson(response, 201, {
      roomId: created.room.roomId,
      // The only time this value ever leaves the server. It is not broadcast,
      // not logged, and not recoverable — losing it means losing the room.
      hostToken: created.room.hostToken,
      ...songSummary(created, parsed.value),
    });
    return;
  }

  const catalogMatch = /^\/api\/rooms\/([^/]+)\/catalog$/u.exec(pathname);
  if (catalogMatch !== null && request.method === 'GET') {
    const room = authorizeRoom(request, response, game, decodeURIComponent(catalogMatch[1] as string));
    if (room === null) return;

    const playable = new Set(game.baseCatalog.playable.map((song) => song.id));
    // First issue per song: the catalog stops at the first blocker anyway, so
    // showing more than one would imply a checklist the builder does not run.
    const firstIssue = new Map<string, CatalogIssue>();
    for (const issue of game.baseCatalog.issues) {
      if (!firstIssue.has(issue.songId)) firstIssue.set(issue.songId, issue);
    }

    sendJson(response, 200, {
      total: game.baseCatalog.playable.length + firstIssue.size,
      playableCount: playable.size,
      songs: game.listSongs().map((song) => {
        const issue = firstIssue.get(song.id);
        return {
          ...song,
          playable: playable.has(song.id),
          issue: issue === undefined ? null : { code: issue.code, message: issue.message },
        };
      }),
    });
    return;
  }

  const songsMatch = /^\/api\/rooms\/([^/]+)\/songs$/u.exec(pathname);
  if (songsMatch !== null && request.method === 'PUT') {
    const room = authorizeRoom(request, response, game, decodeURIComponent(songsMatch[1] as string));
    if (room === null) return;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { error: 'INVALID_BODY', message: body.message });
      return;
    }
    const parsed = parseCreateRoomRequest(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: 'INVALID_BODY', message: parsed.message });
      return;
    }

    const configured = game.configureRoom(room, parsed.value);
    if (configured === null) {
      sendJson(response, 409, { error: 'GAME_ALREADY_STARTED', message: '게임이 시작된 뒤에는 곡을 바꿀 수 없습니다.' });
      return;
    }
    sendJson(response, 200, songSummary(configured, parsed.value));
    return;
  }

  const youtubeMatch = /^\/api\/rooms\/([^/]+)\/youtube$/u.exec(pathname);
  if (youtubeMatch !== null && request.method === 'POST') {
    const room = authorizeRoom(request, response, game, decodeURIComponent(youtubeMatch[1] as string));
    if (room === null) return;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { error: 'INVALID_BODY', message: body.message });
      return;
    }
    const url = isPlainObject(body.value) ? body.value.url : undefined;
    if (typeof url !== 'string') {
      sendJson(response, 400, { error: 'INVALID_BODY', message: 'url 문자열이 필요합니다.' });
      return;
    }

    const link = parseYouTubeLink(url);
    if (link === null) {
      sendJson(response, 400, {
        error: 'NOT_A_YOUTUBE_LINK',
        message: '유튜브 링크로 보이지 않습니다. 주소를 다시 확인해 주세요.',
      });
      return;
    }

    const lookup = await lookupVideo(link.videoId);
    if (!lookup.ok) {
      sendJson(response, 502, { error: 'YOUTUBE_LOOKUP_FAILED', message: lookup.message });
      return;
    }

    // The catalog decides what the answer is. An uploader's title only points
    // at a song; it never becomes one, or a host could smuggle in an answer
    // the judging side has never seen.
    const identified = identifySongFromVideo(lookup.title, lookup.channel, game.listSongs());

    sendJson(response, 200, {
      videoId: link.videoId,
      startSeconds: link.startSeconds,
      videoTitle: lookup.title,
      channel: lookup.channel,
      match:
        identified === null
          ? null
          : {
              id: identified.song.id,
              title: identified.song.title,
              artist: identified.song.artist,
              artistConfirmed: identified.artistConfirmed,
            },
    });
    return;
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)$/u.exec(pathname);
  if (roomMatch !== null && request.method === 'GET') {
    const roomId = decodeURIComponent(roomMatch[1] as string);
    const room = game.getRoom(roomId);
    if (room === undefined) {
      sendJson(response, 404, { error: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없습니다.' });
      return;
    }
    // Enough for a join screen to say "this code is real and still open", and
    // nothing more. No song, no roster, no token.
    sendJson(response, 200, {
      roomId: room.roomId,
      phase: room.getPhase(),
      // Safe to publish: which game is being played is not an answer to any of
      // its questions, and a joining player needs it to know what to expect.
      mode: room.getMode(),
      playerCount: game.connectedCount(roomId),
      joinable: room.getPhase() === 'LOBBY',
      ready: room.getQuestionCount() > 0,
    });
    return;
  }

  sendJson(response, 404, { error: 'NOT_FOUND', message: '경로를 찾을 수 없습니다.' });
}

/** What a host learns about their setlist after creating or configuring it. */
function songSummary(created: RoomCreation, options: CreateRoomOptions): Record<string, unknown> {
  const registered = new Set((options.media ?? []).map((entry) => entry.id));
  return {
    mode: created.mode,
    questionCount: created.questionCount,
    songCount: created.songCount,
    playableCount: created.catalog.playable.length,
    issueCounts: summarizeIssues(created.catalog.issues),
    // Per-song detail only for what this host just registered; the rest they
    // already saw on the catalog endpoint.
    registrationIssues: created.catalog.issues.filter((issue) => registered.has(issue.songId)),
  };
}

function summarizeIssues(issues: readonly CatalogIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  return counts;
}
