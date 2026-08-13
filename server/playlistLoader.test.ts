import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaylist } from './playlistLoader.ts';
import type { TitleLookup } from './playlistLoader.ts';
import { parsePlaylist } from '../shared/playlist.ts';
import { buildSongCatalog } from '../shared/songCatalog.ts';

const A = 'AbCdEfGhIjK';
const B = 'LmNoPqRsTuV';

const CATALOG = [
  { id: 's1', title: 'Hype boy', artist: '뉴진스' },
  { id: 's2', title: '좋은 날', artist: '아이유' },
];

/** A lookup that answers from a table instead of the network. */
function lookupFrom(titles: Record<string, { title: string; channel?: string }>): TitleLookup {
  return async (videoId) => {
    const found = titles[videoId];
    if (found === undefined) return { ok: false, message: '비공개이거나 삭제된 영상입니다.' };
    return { ok: true, title: found.title, channel: found.channel ?? null };
  };
}

test('a line with answers needs no lookup at all', async () => {
  let called = 0;
  const lookup: TitleLookup = async () => {
    called += 1;
    return { ok: false, message: 'should not be reached' };
  };

  const { entries } = parsePlaylist(`https://youtu.be/${A}?t=45 | 좋은 날, 굿데이`);
  const { songs, failures } = await resolvePlaylist(entries, [], lookup);

  assert.equal(called, 0, 'the network is not touched for a line that answers itself');
  assert.deepEqual(failures, []);
  assert.equal(songs[0]?.source, 'file');
  assert.equal(songs[0]?.record.title, '좋은 날');
  assert.equal(songs[0]?.record.youtubeId, A);
  assert.equal(songs[0]?.record.youtubeStart, 45);
  assert.ok(songs[0]?.record.aliases?.includes('굿데이'), 'every answer the host wrote is accepted');
});

test('a link-only line is identified from the video title', async () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A}`);
  const { songs, failures } = await resolvePlaylist(
    entries,
    CATALOG,
    lookupFrom({ [A]: { title: "뉴진스 (NewJeans) 'Hype Boy' Official MV", channel: 'HYBE LABELS' } }),
  );

  assert.deepEqual(failures, []);
  assert.equal(songs[0]?.source, 'catalog');
  assert.equal(songs[0]?.record.title, 'Hype boy');
  assert.equal(songs[0]?.record.artist, '뉴진스');
});

test('a title nobody can identify is reported with the line to fix', async () => {
  const { entries } = parsePlaylist(`# 머리말\nhttps://youtu.be/${A}`);
  const { songs, failures } = await resolvePlaylist(
    entries,
    CATALOG,
    lookupFrom({ [A]: { title: 'Beethoven Symphony No. 5' } }),
  );

  assert.deepEqual(songs, []);
  assert.equal(failures[0]?.line, 2);
  assert.match(failures[0]!.message, /정답/u, 'the message says how to fix it');
});

test('an unreachable video is reported rather than silently dropped', async () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A}`);
  const { failures } = await resolvePlaylist(entries, CATALOG, lookupFrom({}));
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.message, /비공개/u);
});

test('one unresolvable line does not take the others down with it', async () => {
  const { entries } = parsePlaylist([`https://youtu.be/${A}`, `https://youtu.be/${B} | 좋은 날`].join('\n'));
  const { songs, failures } = await resolvePlaylist(entries, CATALOG, lookupFrom({}));
  assert.equal(songs.length, 1);
  assert.equal(failures.length, 1);
});

test('the resolved records build into a playable catalog', async () => {
  // The point of the whole file: these songs must be playable with no media
  // URL, because the host plays the video.
  const { entries } = parsePlaylist(
    [`https://youtu.be/${A} | Hype Boy`, `https://youtu.be/${B}?t=30 | 좋은 날`].join('\n'),
  );
  const { songs } = await resolvePlaylist(entries, [], lookupFrom({}));

  const { playable, issues } = buildSongCatalog(songs.map((song) => song.record));
  assert.deepEqual(issues, []);
  assert.equal(playable.length, 2);
  assert.equal(playable[0]?.youtubeId, A);
  assert.equal(playable[1]?.clipStartMs, 30_000);
});

test('a title alias expands, so a bracketed answer still wins', async () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A} | 피노키오 (Danger)`);
  const { songs } = await resolvePlaylist(entries, [], lookupFrom({}));
  const { playable } = buildSongCatalog(songs.map((song) => song.record));
  assert.ok(playable[0]?.aliases.includes('피노키오'));
  assert.ok(playable[0]?.aliases.includes('danger'));
});
