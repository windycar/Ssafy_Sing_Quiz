/**
 * Tests for the HTTP surface: room creation, catalog, and static serving.
 *
 * The room-creation route is the bootstrap the WebSocket protocol cannot
 * provide, so these tests care most about two things: that a `hostToken` is
 * issued exactly once and actually authorizes host actions, and that nothing
 * on this surface hands out an answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startServer, selectSongs } from './index.ts';
import { createRateLimiter, isSafeMediaUrl, parseCreateRoomRequest } from './http.ts';
import type { RawSongRecord, SongConfig } from '../shared/songCatalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const SONGS: RawSongRecord[] = [
  {
    id: 'ready',
    artist: '아이유',
    title: '좋은 날',
    mediaUrl: 'https://media.invalid/ready',
    clipStart: 10,
    clipEnd: 20,
  },
  { id: 'blank', artist: '방탄소년단', title: 'Dynamite', mediaUrl: null, clipStart: null, clipEnd: null },
];

async function withServer(
  run: (context: { base: string; game: ReturnType<typeof startServer>['game'] }) => Promise<void>,
  options: { songs?: RawSongRecord[]; serveClient?: boolean; allowedOrigins?: readonly string[] } = {},
): Promise<void> {
  const running = startServer({
    port: 0,
    songs: options.songs ?? SONGS,
    allowedOrigins: options.allowedOrigins,
    clientDir: options.serveClient === true ? resolve(HERE, '../client') : undefined,
    sharedDir: options.serveClient === true ? resolve(HERE, '../shared') : undefined,
  });
  await once(running.server, 'listening');
  const port = (running.server.address() as AddressInfo).port;
  try {
    await run({ base: `http://127.0.0.1:${port}`, game: running.game });
  } finally {
    await running.stop();
  }
}

// --- Pure validation --------------------------------------------------------

test('isSafeMediaUrl admits only http and https', () => {
  assert.equal(isSafeMediaUrl('https://cdn.example/clip.mp3'), true);
  assert.equal(isSafeMediaUrl('http://cdn.example/clip.mp3'), true);

  // These are the reason the check exists: any of them in an <audio src> would
  // turn host media registration into script execution or local file access.
  assert.equal(isSafeMediaUrl('javascript:alert(1)'), false);
  assert.equal(isSafeMediaUrl('data:audio/mp3;base64,AAAA'), false);
  assert.equal(isSafeMediaUrl('file:///etc/passwd'), false);
  assert.equal(isSafeMediaUrl(''), false);
  assert.equal(isSafeMediaUrl(`https://cdn.example/${'a'.repeat(3000)}`), false);
});

test('parseCreateRoomRequest accepts a well-formed body', () => {
  const parsed = parseCreateRoomRequest({
    songCount: 5,
    shuffle: false,
    songIds: ['ready'],
    media: [{ id: 'blank', mediaUrl: 'https://cdn.example/a.mp3', clipStart: 30, clipEnd: 40 }],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.songIds : null, ['ready']);
  assert.equal(parsed.ok ? parsed.value.media?.[0]?.clipStart : null, 30);
});

test('parseCreateRoomRequest rejects every malformed shape', () => {
  const rejected: unknown[] = [
    'not an object',
    [],
    { songCount: 0 },
    { songCount: 999 },
    { songCount: 2.5 },
    { songIds: [1, 2] },
    { shuffle: 'yes' },
    { media: {} },
    { media: [{ mediaUrl: 'https://a.example/x', clipStart: 1, clipEnd: 2 }] },
    { media: [{ id: 'a', mediaUrl: 'javascript:alert(1)', clipStart: 1, clipEnd: 2 }] },
    { media: [{ id: 'a', mediaUrl: 'https://a.example/x', clipStart: -1, clipEnd: 2 }] },
    { media: [{ id: 'a', mediaUrl: 'https://a.example/x', clipStart: 5, clipEnd: 5 }] },
  ];
  for (const body of rejected) {
    assert.equal(parseCreateRoomRequest(body).ok, false, `should have rejected ${JSON.stringify(body)}`);
  }

  // An absent body means "all defaults", not an error.
  assert.equal(parseCreateRoomRequest(null).ok, true);
});

test('createRateLimiter allows a burst up to the limit and then refuses', () => {
  const allow = createRateLimiter({ limit: 3, windowMs: 1_000 });
  assert.deepEqual(
    [allow('ip', 0), allow('ip', 10), allow('ip', 20), allow('ip', 30)],
    [true, true, true, false],
  );
  // Keys are independent, and the window resets.
  assert.equal(allow('other', 30), true);
  assert.equal(allow('ip', 1_100), true);
});

test('selectSongs draws a subset without reordering when shuffling is off', () => {
  const pool = ['a', 'b', 'c', 'd'].map((id) => ({ id, aliases: [id] }) as unknown as SongConfig);

  assert.deepEqual(
    selectSongs(pool, { shuffle: false, songCount: 2 }).map((song) => song.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    selectSongs(pool, { shuffle: false, songIds: ['d', 'b'] }).map((song) => song.id),
    ['b', 'd'],
  );
  assert.equal(selectSongs(pool, { shuffle: true }).length, 4);
  assert.equal(selectSongs(pool, { songCount: 99 }).length, 4);
});

// --- Room creation ----------------------------------------------------------

test('POST /api/rooms issues a join code and a host token that actually works', async () => {
  await withServer(async ({ base, game }) => {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ songCount: 1 }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = (await response.json()) as { roomId: string; hostToken: string; songCount: number };
    assert.equal(body.songCount, 1);
    assert.notEqual(body.roomId, body.hostToken);
    // Different exposure demands different entropy (analysis §7).
    assert.ok(body.hostToken.length > body.roomId.length * 2);

    const room = game.getRoom(body.roomId);
    assert.ok(room);
    assert.equal(room.hostToken, body.hostToken);
  });
});

test('a room creation response never contains a song title', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
    const text = await response.text();
    assert.equal(text.includes('좋은 날'), false);
    assert.equal(text.includes('Dynamite'), false);
  });
});

test('host media registration turns an unplayable song into a playable one', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media: [{ id: 'blank', mediaUrl: 'https://cdn.example/dynamite.mp3', clipStart: 30, clipEnd: 40 }],
      }),
    });
    assert.equal(response.status, 201);

    const body = (await response.json()) as { playableCount: number; registrationIssues: unknown[] };
    // 'ready' was already playable; 'blank' just became so.
    assert.equal(body.playableCount, 2);
    assert.deepEqual(body.registrationIssues, []);
  });
});

test('a clip outside the 5-15s range is reported per song rather than failing the request', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media: [{ id: 'blank', mediaUrl: 'https://cdn.example/x.mp3', clipStart: 0, clipEnd: 60 }],
      }),
    });
    assert.equal(response.status, 201);

    const body = (await response.json()) as { playableCount: number; registrationIssues: { code: string }[] };
    assert.equal(body.playableCount, 1);
    assert.equal(body.registrationIssues[0]?.code, 'CLIP_TOO_LONG');
  });
});

test('creating a room with nothing playable is refused with an explanation', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
      assert.equal(response.status, 400);

      const body = (await response.json()) as { error: string; issues: Record<string, number> };
      assert.equal(body.error, 'NO_PLAYABLE_SONGS');
      assert.equal(body.issues['MISSING_MEDIA_URL'], 1);
    },
    { songs: [SONGS[1] as RawSongRecord] },
  );
});

test('a malformed or oversized body is refused with 400', async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(bad.status, 400);

    const huge = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ songIds: [`${'x'.repeat(600_000)}`] }),
    });
    assert.equal(huge.status, 400);
  });
});

test('room creation is rate limited per client', async () => {
  await withServer(async ({ base }) => {
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ songCount: 1 }),
      });
      if (response.status === 429) limited += 1;
      await response.text();
    }
    assert.ok(limited >= 2, `expected some requests to be rate limited, got ${limited}`);
  });
});

// --- Lookup and catalog -----------------------------------------------------

test('GET /api/rooms/:id tells a join screen only whether the code is usable', async () => {
  await withServer(async ({ base, game }) => {
    const { room } = game.createRoom({ songCount: 1 });

    const found = await fetch(`${base}/api/rooms/${room.roomId}`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), {
      roomId: room.roomId,
      phase: 'LOBBY',
      playerCount: 0,
      joinable: true,
    });

    const missing = await fetch(`${base}/api/rooms/nope`);
    assert.equal(missing.status, 404);
  });
});

test('GET /api/songs reports playability per song and never leaks aliases', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/songs`);
    const body = (await response.json()) as {
      total: number;
      playableCount: number;
      songs: { id: string; title: string; playable: boolean; issue: { code: string } | null }[];
    };

    assert.equal(body.total, 2);
    assert.equal(body.playableCount, 1);
    assert.equal(body.songs.find((song) => song.id === 'ready')?.playable, true);
    assert.equal(body.songs.find((song) => song.id === 'blank')?.issue?.code, 'MISSING_MEDIA_URL');
    // Titles are the point of this endpoint; the accepted-answer set is not.
    assert.equal(JSON.stringify(body).includes('aliases'), false);
  });
});

// --- Static client ----------------------------------------------------------

test('the client is served with a content security policy', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/u);
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/u);
      assert.match(await response.text(), /Drop the Beat/u);
    },
    { serveClient: true },
  );
});

test('a .ts source is served as JavaScript that a browser can actually run', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/protocolClient.ts`);
      assert.match(response.headers.get('content-type') ?? '', /text\/javascript/u);

      const source = await response.text();
      assert.equal(source.includes('export interface'), false, 'types should be stripped');

      // The strongest available check short of a browser: hand the served bytes
      // to an ESM loader and see whether the module evaluates.
      const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
      const loaded = (await import(dataUrl)) as { applyServerMessage?: unknown };
      assert.equal(typeof loaded.applyServerMessage, 'function');
    },
    { serveClient: true },
  );
});

test('shared/ is reachable from the client so both judge by the same rules', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/shared/answerMatching.ts`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/javascript/u);
      assert.equal((await response.text()).includes('interface AliasMatcher'), false);
    },
    { serveClient: true },
  );
});

test('path traversal and unlisted file types are refused', async () => {
  await withServer(
    async ({ base }) => {
      // Percent-encoded so fetch does not normalise the `..` away before it is
      // sent; this is the spelling the handler has to defend against.
      const escaped = await fetch(`${base}/%2e%2e%2fserver%2fmain.ts`);
      assert.equal(escaped.status, 404);

      const notAllowed = await fetch(`${base}/package.json`);
      assert.equal(notAllowed.status, 404);
    },
    { serveClient: true },
  );
});

// --- CORS and lifecycle -----------------------------------------------------

test('an API call from a disallowed origin is refused', async () => {
  await withServer(
    async ({ base }) => {
      const blocked = await fetch(`${base}/api/songs`, { headers: { origin: 'https://evil.invalid' } });
      assert.equal(blocked.status, 403);

      const allowed = await fetch(`${base}/api/songs`, { headers: { origin: 'https://quiz.example' } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://quiz.example');
    },
    { allowedOrigins: ['https://quiz.example'] },
  );
});

test('reap collects abandoned rooms and leaves live ones alone', async () => {
  await withServer(async ({ game }) => {
    const abandoned = game.createRoom({ songCount: 1, now: 0 });
    const fresh = game.createRoom({ songCount: 1, now: 0 });
    assert.equal(game.roomCount(), 2);

    // Nothing has been collected yet: the idle window has not elapsed.
    assert.equal(game.reap(1_000, 60_000), 0);

    // A room with a connected player is never collected, however old it is.
    fresh.room.handleMessage({ type: 'JOIN_ROOM', roomId: fresh.room.roomId, nickname: '참가자' }, null, 0);

    assert.equal(game.reap(120_000, 60_000), 1);
    assert.equal(game.getRoom(abandoned.room.roomId), undefined);
    assert.ok(game.getRoom(fresh.room.roomId));
  });
});
