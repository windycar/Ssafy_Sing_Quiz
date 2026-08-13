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

export interface CreateRoomResponse {
  roomId: string;
  /** Secret. Store it, never display it in a shareable place (analysis §7). */
  hostToken: string;
  songCount: number;
  playableCount: number;
  issueCounts: Record<string, number>;
  registrationIssues: CatalogIssue[];
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

export async function fetchSongs(baseUrl = ''): Promise<SongListResponse> {
  return parse<SongListResponse>(await fetch(`${baseUrl}/api/songs`));
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

export async function lookupRoom(roomId: string, baseUrl = ''): Promise<RoomLookupResponse> {
  return parse<RoomLookupResponse>(await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}`));
}
