/**
 * The host bootstrap sequence, against a real server.
 *
 * `protocolClient.test.ts` covers the WebSocket half but reaches the HTTP half
 * with raw `fetch`, so these wrappers went unexercised while `music-quiz`
 * started depending on all four of them. The order below is the order
 * `app/page.tsx` calls them in: a host has no token until the room exists, and
 * no catalog until it has the token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ApiError, createRoom, fetchCatalog, lookupRoom, setSetlist } from './api.ts';
import { startServer } from '../server/index.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';

/** One playable song and one that a host must register media for. */
const SONGS: RawSongRecord[] = [
  {
    id: 's1',
    artist: '아이유',
    title: '좋은 날',
    aliases: ['좋은날'],
    mediaUrl: 'https://media.invalid/a',
    clipStart: 0,
    clipEnd: 5,
  },
  {
    id: 's2',
    artist: '방탄소년단',
    title: 'Dynamite',
    aliases: ['Dynamite'],
    mediaUrl: null,
    clipStart: null,
    clipEnd: null,
  },
];

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const running = startServer({ port: 0, songs: SONGS });
  await once(running.server, 'listening');
  const base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await running.stop();
  }
}

test('the host bootstrap runs create → catalog → setlist → lookup', async () => {
  await withServer(async (base) => {
    const created = await createRoom({}, base);
    assert.match(created.roomId, /^[\w-]+$/u);
    assert.notEqual(created.hostToken, created.roomId, 'the two secrets must not be the same value');

    const catalog = await fetchCatalog(created.roomId, created.hostToken, base);
    assert.equal(catalog.total, 2);
    assert.equal(catalog.playableCount, 1);

    const blocked = catalog.songs.find((song) => song.id === 's2');
    assert.equal(blocked?.playable, false);
    assert.ok(blocked?.issue, 'the host UI lists the blocker, so the server must name it');

    // What the setup screen submits: media for the song that lacked it.
    const setlist = await setSetlist(
      created.roomId,
      created.hostToken,
      { counts: { song: 2, proverb: 0, idiom: 0 }, media: [{ id: 's2', mediaUrl: 'https://media.invalid/b', clipStart: 0, clipEnd: 10 }] },
      base,
    );
    assert.equal(setlist.playableCount, 2, 'registering media makes the second song playable');
    assert.deepEqual(setlist.registrationIssues, []);

    const room = await lookupRoom(created.roomId, base);
    assert.equal(room.joinable, true);
    assert.equal(room.ready, true);
    assert.equal(room.phase, 'LOBBY');
  });
});

test('a wrong host token is answered like a missing room, not a forbidden one', async () => {
  await withServer(async (base) => {
    const created = await createRoom({}, base);
    await assert.rejects(
      () => fetchCatalog(created.roomId, 'not-the-token', base),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        // 404 and not 403 on purpose: a 403 would confirm the room exists, so
        // guessing tokens would double as a room-enumeration oracle.
        assert.equal(error.status, 404);
        // The UI renders `error.message` directly, so it has to be readable.
        assert.notEqual(error.message.trim(), '');
        return true;
      },
    );
  });
});

test('a lookup for a room that does not exist fails as an ApiError', async () => {
  await withServer(async (base) => {
    await assert.rejects(
      () => lookupRoom('nope', base),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
  });
});
