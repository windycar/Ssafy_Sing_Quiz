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
import { IDIOM_BANK, PROVERB_BANK, textBankFor } from './questionBanks.ts';
import { QUESTIONS_PER_TEXT_GAME } from '../shared/questions.ts';
import type { GameMode } from '../shared/questions.ts';
import type { RawSongRecord, SongConfig } from '../shared/songCatalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * How many questions a text room actually draws on this machine.
 *
 * `QUESTIONS_PER_TEXT_GAME` on a clean checkout, and that is what these
 * assertions are about. It is read from the live bank rather than hardcoded
 * because a host running the suite may have a shorter `문제/속담.json` of their
 * own — the server drawing all of it is correct behaviour, not a regression in
 * the HTTP layer these tests cover.
 */
function drawnQuestions(mode: GameMode): number {
  return Math.min(textBankFor(mode)?.length ?? 0, QUESTIONS_PER_TEXT_GAME);
}

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
    counts: { song: 5, proverb: 10, idiom: 0 },
    shuffle: false,
    songIds: ['ready'],
    media: [{ id: 'blank', mediaUrl: 'https://cdn.example/a.mp3', clipStart: 30, clipEnd: 40 }],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.counts : null, { song: 5, proverb: 10, idiom: 0 });
  assert.deepEqual(parsed.ok ? parsed.value.songIds : null, ['ready']);
  assert.equal(parsed.ok ? parsed.value.media?.[0]?.clipStart : null, 30);
});

test('parseCreateRoomRequest takes a partial counts object and leaves the rest to the server', () => {
  // Only the song count matters to this host; the other two sections should
  // come out at whatever the server's defaults are, not at zero.
  const parsed = parseCreateRoomRequest({ counts: { song: 3 } });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.counts : null, { song: 3 });
});

test('parseCreateRoomRequest rejects every malformed shape', () => {
  const rejected: unknown[] = [
    'not an object',
    [],
    { counts: 5 },
    { counts: [] },
    // Zero is allowed — it drops a section — but negatives, fractions, and
    // counts past what the banks hold are not.
    { counts: { song: -1 } },
    { counts: { song: 2.5 } },
    { counts: { song: 999 } },
    { counts: { proverb: 51 } },
    { counts: { quiz: 3 } },
    { counts: { song: '5' } },
    // Both removed, and refused rather than ignored: a client still sending
    // either was built when a room played one mode, and quietly handing it a
    // three-section game would look like the picker had stopped working.
    { mode: 'proverb' },
    { songCount: 5 },
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

test('a YouTube registration needs no media URL and no clip range', () => {
  const parsed = parseCreateRoomRequest({
    media: [{ id: 'song-1', youtubeId: 'dQw4w9WgXcQ', youtubeStart: 45 }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.media?.[0]?.youtubeId : null, 'dQw4w9WgXcQ');
  assert.equal(parsed.ok ? parsed.value.media?.[0]?.youtubeStart : null, 45);
});

test('a pasted YouTube URL is reduced to its video id', () => {
  // The host UI sends whatever was in the box; the id is what gets stored.
  const parsed = parseCreateRoomRequest({
    media: [{ id: 'song-1', youtubeId: 'https://youtu.be/dQw4w9WgXcQ?t=90' }],
  });
  assert.equal(parsed.ok ? parsed.value.media?.[0]?.youtubeId : null, 'dQw4w9WgXcQ');
});

test('a YouTube registration with a junk id is refused', () => {
  // Note "not-a-video" is absent on purpose: it is 11 characters of the video
  // id alphabet, so it is a well-formed id. Only YouTube can say whether an
  // id exists, and that check belongs to the lookup route, not to parsing.
  const rejected: unknown[] = [
    { media: [{ id: 'a', youtubeId: 'too-short' }] },
    { media: [{ id: 'a', youtubeId: 'way-too-long-for-an-id' }] },
    { media: [{ id: 'a', youtubeId: 'has spaces' }] },
    { media: [{ id: 'a', youtubeId: 'https://vimeo.com/12345' }] },
    { media: [{ id: 'a', youtubeId: 42 }] },
    { media: [{ id: 'a', youtubeId: 'dQw4w9WgXcQ', youtubeStart: -5 }] },
    { media: [{ id: 'a', youtubeId: 'dQw4w9WgXcQ', youtubeStart: 'soon' }] },
  ];
  for (const body of rejected) {
    assert.equal(parseCreateRoomRequest(body).ok, false, `should have rejected ${JSON.stringify(body)}`);
  }
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
      body: JSON.stringify({ counts: { song: 1, proverb: 0, idiom: 0 } }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = (await response.json()) as { roomId: string; hostToken: string; questionCount: number };
    assert.equal(body.questionCount, 1);
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

/** Creates a room and returns its id and host token. */
async function createRoom(base: string, body: unknown = {}): Promise<{ roomId: string; hostToken: string }> {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { roomId: string; hostToken: string };
}

test('host media registration turns an unplayable song into a playable one', async () => {
  await withServer(async ({ base }) => {
    const { roomId, hostToken } = await createRoom(base);
    const response = await fetch(`${base}/api/rooms/${roomId}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-host-token': hostToken },
      body: JSON.stringify({
        media: [{ id: 'blank', mediaUrl: 'https://cdn.example/dynamite.mp3', clipStart: 30, clipEnd: 40 }],
      }),
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { playableCount: number; registrationIssues: unknown[] };
    // 'ready' was already playable; 'blank' just became so.
    assert.equal(body.playableCount, 2);
    assert.deepEqual(body.registrationIssues, []);
  });
});

test('a clip outside the 5-15s range is reported per song rather than failing the request', async () => {
  await withServer(async ({ base }) => {
    const { roomId, hostToken } = await createRoom(base);
    const response = await fetch(`${base}/api/rooms/${roomId}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-host-token': hostToken },
      body: JSON.stringify({
        media: [{ id: 'blank', mediaUrl: 'https://cdn.example/x.mp3', clipStart: 0, clipEnd: 60 }],
      }),
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { playableCount: number; registrationIssues: { code: string }[] };
    assert.equal(body.playableCount, 1);
    assert.equal(body.registrationIssues[0]?.code, 'CLIP_TOO_LONG');
  });
});

test('a room that draws nothing at all is created anyway, so its host can fix it', async () => {
  await withServer(
    async ({ base, game }) => {
      // Nothing playable in the catalog *and* both text sections dropped, which
      // is the only way a room comes out empty now. The host needs their token
      // before they may read the catalog, so refusing creation here would leave
      // them with no way forward.
      const { roomId } = await createRoom(base, { counts: { song: 5, proverb: 0, idiom: 0 } });
      const room = game.getRoom(roomId);
      assert.equal(room?.getQuestionCount(), 0);

      const lookup = (await (await fetch(`${base}/api/rooms/${roomId}`)).json()) as { ready: boolean };
      assert.equal(lookup.ready, false, 'a joining player can see the room is not configured yet');

      // Starting is what gets refused, by the engine.
      const denied = room?.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 0);
      assert.equal(denied?.[0]?.kind === 'send' && denied[0].message.type === 'ERROR', true);
    },
    { songs: [SONGS[1] as RawSongRecord] },
  );
});

// --- One room, three sections in order --------------------------------------

test('a room with no body at all plays every section, songs first', async () => {
  await withServer(async ({ base, game }) => {
    // No `mode`, no counts, no body: this is the whole "make a room" flow now.
    const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      roomId: string;
      sections: { mode: string; count: number }[];
      questionCount: number;
    };

    assert.deepEqual(
      body.sections.map((section) => section.mode),
      ['song', 'proverb', 'idiom'],
      'the running order is fixed and reported in playing order',
    );
    assert.equal(
      body.questionCount,
      body.sections.reduce((total, section) => total + section.count, 0),
    );

    // The room holds the same plan, and it starts with a song.
    const room = game.getRoom(body.roomId);
    assert.equal(room?.getQuestionCount(), body.questionCount);
    assert.equal(room?.getMode(), 'song');
    assert.deepEqual(room?.getSectionCounts(), body.sections);
  });
});

test('a count is clamped to what is actually available, and reported clamped', async () => {
  await withServer(async ({ base }) => {
    // One playable song in the fixture, so asking for 100 must come back as 1.
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ counts: { song: 100, proverb: 2, idiom: 3 } }),
    });
    const body = (await response.json()) as { sections: { mode: string; count: number }[] };
    assert.deepEqual(body.sections, [
      { mode: 'song', count: 1 },
      { mode: 'proverb', count: 2 },
      { mode: 'idiom', count: 3 },
    ]);
  });
});

test('a section set to zero is dropped from the game', async () => {
  await withServer(async ({ base, game }) => {
    const { roomId } = await createRoom(base, { counts: { song: 0, proverb: 2, idiom: 0 } });
    const room = game.getRoom(roomId);
    assert.deepEqual(room?.getSectionCounts(), [
      { mode: 'song', count: 0 },
      { mode: 'proverb', count: 2 },
      { mode: 'idiom', count: 0 },
    ]);
    // With no songs, the first question is a proverb — so is the reported mode.
    assert.equal(room?.getMode(), 'proverb');
  });
});

test('a room with no playable songs still starts, on its text sections alone', async () => {
  // The song catalog here has nothing playable on purpose. Songs are one
  // section of three, so losing them must not stop the game.
  await withServer(
    async ({ base, game }) => {
      const { roomId } = await createRoom(base, {});
      const room = game.getRoom(roomId);
      assert.deepEqual(room?.getSectionCounts(), [
        { mode: 'song', count: 0 },
        { mode: 'proverb', count: drawnQuestions('proverb') },
        { mode: 'idiom', count: drawnQuestions('idiom') },
      ]);

      room?.handleMessage({ type: 'JOIN_ROOM', roomId, nickname: '방장', hostToken: room.hostToken }, null, 0);
      const started = room?.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 0);
      assert.equal(
        started?.some((effect) => effect.kind === 'broadcast' && effect.message.type === 'COUNTDOWN_STARTED'),
        true,
      );
    },
    { songs: [SONGS[1] as RawSongRecord] },
  );
});

test('a joining player can read the plan without a host token', async () => {
  await withServer(async ({ base }) => {
    const { roomId } = await createRoom(base, { counts: { song: 1, proverb: 2, idiom: 3 } });
    const lookup = (await (await fetch(`${base}/api/rooms/${roomId}`)).json()) as {
      mode: string;
      sections: { mode: string; count: number }[];
      questionCount: number;
      ready: boolean;
    };
    assert.equal(lookup.mode, 'song', 'songs open, so that is what is next up');
    assert.deepEqual(lookup.sections, [
      { mode: 'song', count: 1 },
      { mode: 'proverb', count: 2 },
      { mode: 'idiom', count: 3 },
    ]);
    assert.equal(lookup.questionCount, 6);
    assert.equal(lookup.ready, true);
  });
});

test('a room creation response never contains an answer, in any mode', async () => {
  await withServer(async ({ base }) => {
    for (const mode of ['proverb', 'idiom'] as const) {
      const response = await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const text = await response.text();
      const bank = mode === 'proverb' ? PROVERB_BANK : IDIOM_BANK;
      for (const question of bank) {
        for (const alias of question.aliases) {
          assert.equal(text.includes(alias), false, `${mode}: "${alias}" reached a client`);
        }
      }
    }
  });
});

test('the host may change the section counts while the room is still in the lobby', async () => {
  await withServer(async ({ base, game }) => {
    const { roomId, hostToken } = await createRoom(base, { counts: { song: 1, proverb: 0, idiom: 0 } });
    assert.equal(game.getRoom(roomId)?.getQuestionCount(), 1);

    const response = await fetch(`${base}/api/rooms/${roomId}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-host-token': hostToken },
      body: JSON.stringify({ counts: { song: 0, proverb: 4, idiom: 0 } }),
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { sections: { mode: string; count: number }[]; questionCount: number };
    assert.deepEqual(body.sections, [
      { mode: 'song', count: 0 },
      { mode: 'proverb', count: 4 },
      { mode: 'idiom', count: 0 },
    ]);
    assert.equal(body.questionCount, 4);
    assert.equal(game.getRoom(roomId)?.getQuestionCount(), 4);
    assert.equal(game.getRoom(roomId)?.getMode(), 'proverb', 'the first question is a proverb now');
  });
});

test('the setlist is frozen once the game starts', async () => {
  await withServer(async ({ base, game }) => {
    const { roomId, hostToken } = await createRoom(base, { counts: { song: 1, proverb: 0, idiom: 0 } });
    const room = game.getRoom(roomId);
    assert.ok(room);

    room.handleMessage({ type: 'JOIN_ROOM', roomId, nickname: '방장', hostToken: room.hostToken }, null, 0);
    room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 0);

    const response = await fetch(`${base}/api/rooms/${roomId}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-host-token': hostToken },
      body: JSON.stringify({ counts: { song: 1 } }),
    });
    assert.equal(response.status, 409);
  });
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
    const { room } = game.createRoom({ counts: { song: 1, proverb: 0, idiom: 0 } });

    const found = await fetch(`${base}/api/rooms/${room.roomId}`);
    assert.equal(found.status, 200);
    // Everything a join screen needs, and nothing else. The plan is safe to
    // publish: what a room is going to play is not an answer to any of it.
    assert.deepEqual(await found.json(), {
      roomId: room.roomId,
      phase: 'LOBBY',
      mode: 'song',
      sections: [
        { mode: 'song', count: 1 },
        { mode: 'proverb', count: 0 },
        { mode: 'idiom', count: 0 },
      ],
      questionCount: 1,
      playerCount: 0,
      joinable: true,
      ready: true,
    });

    const missing = await fetch(`${base}/api/rooms/nope`);
    assert.equal(missing.status, 404);
  });
});

test('the catalog reports playability per song and never leaks aliases', async () => {
  await withServer(async ({ base }) => {
    const { roomId, hostToken } = await createRoom(base);
    const response = await fetch(`${base}/api/rooms/${roomId}/catalog`, {
      headers: { 'x-host-token': hostToken },
    });
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

test('the catalog is unreachable without the room host token', async () => {
  await withServer(async ({ base }) => {
    const { roomId, hostToken } = await createRoom(base);
    const other = await createRoom(base);

    // Once a host has registered media for a handful of songs, the playable set
    // is a short list of candidate answers. A player in the room must not be
    // able to read it.
    const attempts: Record<string, string>[] = [
      {},
      { 'x-host-token': 'guessed' },
      { 'x-host-token': other.hostToken },
    ];
    for (const headers of attempts) {
      const denied = await fetch(`${base}/api/rooms/${roomId}/catalog`, { headers });
      assert.equal(denied.status, 404, `expected refusal for ${JSON.stringify(headers)}`);
      assert.equal((await denied.text()).includes('좋은 날'), false);
    }

    // A near-miss of the right length must not pass either — the comparison is
    // constant time, not a prefix check.
    const nearMiss = `${hostToken.slice(0, -1)}${hostToken.endsWith('A') ? 'B' : 'A'}`;
    const refused = await fetch(`${base}/api/rooms/${roomId}/catalog`, { headers: { 'x-host-token': nearMiss } });
    assert.equal(refused.status, 404);

    // The legitimate host still gets in.
    const allowed = await fetch(`${base}/api/rooms/${roomId}/catalog`, { headers: { 'x-host-token': hostToken } });
    assert.equal(allowed.status, 200);
  });
});

test('the setlist route rejects a wrong host token', async () => {
  await withServer(async ({ base }) => {
    const { roomId } = await createRoom(base);
    const response = await fetch(`${base}/api/rooms/${roomId}/songs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-host-token': 'not-the-token' },
      body: JSON.stringify({ songCount: 1 }),
    });
    assert.equal(response.status, 404);
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

test('the question model is served but the question banks are not', async () => {
  // `shared/questions.ts` is mounted, because both clients import the mode
  // labels from it. That is only safe because the answers are not in it — they
  // are in `data/`, which is not mounted at all and whose extension is not even
  // in the allow-list. Both halves of that are asserted here.
  await withServer(
    async ({ base }) => {
      const model = await fetch(`${base}/shared/questions.ts`);
      assert.equal(model.status, 200);
      const source = await model.text();
      assert.ok(source.includes('노래 맞히기'), 'the client reads its mode labels from here');

      for (const question of [...PROVERB_BANK, ...IDIOM_BANK]) {
        for (const alias of question.aliases) {
          assert.equal(source.includes(alias), false, `"${alias}" is in a file the browser can fetch`);
        }
      }

      // And the data itself is unreachable, by every spelling worth trying.
      for (const path of [
        '/data/proverbs.json',
        '/shared/../data/idioms.json',
        '/shared/%2e%2e/data/idioms.json',
        '/proverbs.json',
        '/../data/proverbs.json',
      ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 404, `${path} must not be served`);
        const body = await response.text();
        assert.equal(body.includes('가는 말이'), false);
      }
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
    async ({ base, game }) => {
      const { room } = game.createRoom({ counts: { song: 1, proverb: 0, idiom: 0 } });

      const blocked = await fetch(`${base}/api/rooms/${room.roomId}`, {
        headers: { origin: 'https://evil.invalid' },
      });
      assert.equal(blocked.status, 403);

      const allowed = await fetch(`${base}/api/rooms/${room.roomId}`, {
        headers: { origin: 'https://quiz.example' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://quiz.example');
    },
    { allowedOrigins: ['https://quiz.example'] },
  );
});

test('reap collects abandoned rooms and leaves live ones alone', async () => {
  await withServer(async ({ game }) => {
    const abandoned = game.createRoom({ counts: { song: 1, proverb: 0, idiom: 0 }, now: 0 });
    const fresh = game.createRoom({ counts: { song: 1, proverb: 0, idiom: 0 }, now: 0 });
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
