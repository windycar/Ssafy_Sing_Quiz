/**
 * Typed wrapper over the HTTP half of the protocol (`server/http.ts`).
 *
 * Separate from `protocolClient.ts` because the two halves have different
 * lifetimes: this one runs before a room exists, to bootstrap a `roomId` and
 * `hostToken`; the WebSocket client runs for as long as the game does.
 */

import type { CatalogIssue } from '../shared/songCatalog.ts';
import type { RoomPhase } from '../server/protocol.ts';
import type { MediaRegistration } from '../shared/songCatalog.ts';

export interface SongListEntry {
  id: string;
  title: string;
  artist: string;
  playable: boolean;
  issue: { code: CatalogIssue['code']; message: string } | null;
}

export interface SongListResponse {
  total: number;
  playableCount: number;
  songs: SongListEntry[];
}

/** The setlist a host just drew, and what was rejected from it. */
export interface SetlistResponse {
  songCount: number;
  playableCount: number;
  issueCounts: Record<string, number>;
  registrationIssues: CatalogIssue[];
}

export interface CreateRoomResponse extends SetlistResponse {
  roomId: string;
  /** Secret. Store it, never display it in a shareable place (analysis §7). */
  hostToken: string;
}

export interface CreateRoomBody {
  songCount?: number;
  songIds?: string[];
  shuffle?: boolean;
  media?: MediaRegistration[];
}

export interface RoomLookupResponse {
  roomId: string;
  phase: RoomPhase;
  playerCount: number;
  joinable: boolean;
  /** False until the host has configured a setlist. */
  ready: boolean;
}

/** A failed request that still carried a server-authored Korean explanation. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body as T;

  const detail = (body ?? {}) as { error?: string; message?: string };
  throw new ApiError(
    response.status,
    detail.error ?? 'UNKNOWN',
    detail.message ?? `요청이 실패했습니다 (HTTP ${response.status}).`,
  );
}

/** Header carrying the host secret. Mirrors `HOST_TOKEN_HEADER` on the server. */
const HOST_TOKEN_HEADER = 'x-host-token';

/**
 * The song catalog, which only a room's host may read.
 *
 * Room-scoped rather than global because the playable set is a short list of
 * candidate answers once a host has registered media for a handful of songs
 * (analysis §7). A host token is the only thing that opens it.
 */
export async function fetchCatalog(roomId: string, hostToken: string, baseUrl = ''): Promise<SongListResponse> {
  return parse<SongListResponse>(
    await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/catalog`, {
      headers: { [HOST_TOKEN_HEADER]: hostToken },
    }),
  );
}

export async function createRoom(body: CreateRoomBody, baseUrl = ''): Promise<CreateRoomResponse> {
  return parse<CreateRoomResponse>(
    await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Draws the room's setlist. Only valid while the room is still in the lobby. */
export async function setSetlist(
  roomId: string,
  hostToken: string,
  body: CreateRoomBody,
  baseUrl = '',
): Promise<SetlistResponse> {
  return parse<SetlistResponse>(
    await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [HOST_TOKEN_HEADER]: hostToken },
      body: JSON.stringify(body),
    }),
  );
}

export async function lookupRoom(roomId: string, baseUrl = ''): Promise<RoomLookupResponse> {
  return parse<RoomLookupResponse>(await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}`));
}
