import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMediaRegistrations,
  expandTitleAliases,
  buildSongCatalog,
  createSongMatcher,
  toRoundPublicPayload,
  MIN_CLIP_MS,
  MAX_CLIP_MS,
  YOUTUBE_CLIP_MS,
} from './songCatalog.ts';
import type { RawSongRecord } from './songCatalog.ts';

/** A record shaped like the recovered data, but complete enough to play. */
function playableRecord(overrides: Partial<RawSongRecord> = {}): RawSongRecord {
  return {
    id: 'test-001',
    artist: '테스트 아티스트',
    title: 'Dynamite',
    aliases: ['Dynamite'],
    mediaUrl: 'https://example.invalid/clip-a1b2c3.mp3',
    clipStart: 30,
    clipEnd: 40,
    ...overrides,
  };
}

test('expandTitleAliases keeps the full title', () => {
  assert.deepEqual(expandTitleAliases('Dynamite'), ['Dynamite']);
});

test('expandTitleAliases accepts the title without its bracketed part', () => {
  const aliases = expandTitleAliases('피노키오 (Danger)');
  assert.deepEqual(aliases, ['피노키오 (Danger)', '피노키오', 'Danger']);
});

test('expandTitleAliases accepts either side of a bilingual title', () => {
  const aliases = expandTitleAliases('Crescendo (크레셴도)');
  assert.deepEqual(aliases, ['Crescendo (크레셴도)', 'Crescendo', '크레셴도']);
});

test('expandTitleAliases does not accept featured-artist credits as answers', () => {
  const aliases = expandTitleAliases('바람났어 (Feat. 박봄)');
  // The literal title is still accepted; the credit alone must never be.
  assert.deepEqual(aliases, ['바람났어 (Feat. 박봄)', '바람났어']);
  assert.equal(aliases.includes('박봄'), false);
  assert.equal(aliases.includes('Feat. 박봄'), false);
});

test('expandTitleAliases drops credit segments for ft./prod./remix forms too', () => {
  assert.deepEqual(expandTitleAliases('GANADARA (Feat. 아이유)'), [
    'GANADARA (Feat. 아이유)',
    'GANADARA',
  ]);
  assert.deepEqual(expandTitleAliases('Song (Prod. by Someone)'), ['Song (Prod. by Someone)', 'Song']);
  assert.deepEqual(expandTitleAliases('Song (Remix)'), ['Song (Remix)', 'Song']);
});

test('expandTitleAliases de-duplicates entries that normalize identically', () => {
  // Stripping the bracket yields the same normalized string as the title.
  assert.deepEqual(expandTitleAliases('200%'), ['200%']);
});

test('buildSongCatalog produces a playable config with expanded aliases', () => {
  const { playable, issues } = buildSongCatalog([
    playableRecord({ id: 's1', title: '피노키오 (Danger)', aliases: ['피노키오 (Danger)'] }),
  ]);
  assert.equal(issues.length, 0);
  assert.equal(playable.length, 1);
  const song = playable[0];
  assert.equal(song.clipStartMs, 30_000);
  assert.equal(song.clipEndMs, 40_000);
  // Aliases are stored already-normalized, ready for the matcher.
  assert.deepEqual(song.aliases, ['피노키오danger', '피노키오', 'danger']);
});

test('buildSongCatalog rejects records with no media URL (the recovered-data case)', () => {
  const { playable, issues } = buildSongCatalog([
    { id: 'scx-001', artist: '뉴진스', title: 'Hype boy', aliases: ['Hype boy'], mediaUrl: null, clipStart: null, clipEnd: null },
  ]);
  assert.equal(playable.length, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'MISSING_MEDIA_URL');
  assert.equal(issues[0].songId, 'scx-001');
});

test('buildSongCatalog reports a missing clip range separately from a missing URL', () => {
  const { issues } = buildSongCatalog([
    playableRecord({ id: 's2', clipStart: null, clipEnd: null }),
  ]);
  assert.deepEqual(issues.map((i) => i.code), ['MISSING_CLIP_RANGE']);
});

test('buildSongCatalog enforces the 5-15 second clip window', () => {
  const tooShort = buildSongCatalog([playableRecord({ id: 'short', clipStart: 10, clipEnd: 14 })]);
  assert.deepEqual(tooShort.issues.map((i) => i.code), ['CLIP_TOO_SHORT']);
  assert.equal(tooShort.playable.length, 0);

  const tooLong = buildSongCatalog([playableRecord({ id: 'long', clipStart: 10, clipEnd: 26 })]);
  assert.deepEqual(tooLong.issues.map((i) => i.code), ['CLIP_TOO_LONG']);

  const atBounds = buildSongCatalog([
    playableRecord({ id: 'min', clipStart: 0, clipEnd: MIN_CLIP_MS / 1000, title: 'Song One', aliases: [] }),
    playableRecord({ id: 'max', clipStart: 0, clipEnd: MAX_CLIP_MS / 1000, title: 'Song Two', aliases: [] }),
  ]);
  assert.equal(atBounds.issues.length, 0, 'exactly 5s and exactly 15s must be allowed');
  assert.equal(atBounds.playable.length, 2);
});

test('buildSongCatalog rejects an inverted clip range', () => {
  const { issues } = buildSongCatalog([playableRecord({ id: 'inv', clipStart: 40, clipEnd: 30 })]);
  assert.deepEqual(issues.map((i) => i.code), ['CLIP_RANGE_INVALID']);
});

test('buildSongCatalog never lets one guess be correct for two songs', () => {
  const { playable, issues } = buildSongCatalog([
    playableRecord({ id: 'a', title: '사계 (Four Seasons)', aliases: [] }),
    playableRecord({ id: 'b', title: '사계 (Winter)', aliases: [] }),
  ]);
  assert.equal(playable.length, 2, 'both songs keep at least one unique alias');
  const duplicates = issues.filter((i) => i.code === 'DUPLICATE_ALIAS');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].songId, 'b', 'the later song loses the contested alias');

  // The contested alias resolves to exactly one song.
  const owners = playable.filter((song) => createSongMatcher(song).matches('사계'));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].id, 'a');
});

test('buildSongCatalog drops a song that has no unique alias left', () => {
  const { playable, issues } = buildSongCatalog([
    playableRecord({ id: 'a', title: 'Dynamite' }),
    playableRecord({ id: 'b', title: 'dynamite!', aliases: ['DYNAMITE'] }),
  ]);
  assert.deepEqual(playable.map((s) => s.id), ['a']);
  assert.equal(issues.some((i) => i.code === 'NO_USABLE_ALIAS' && i.songId === 'b'), true);
});

test('an unplayable song does not reserve aliases from a playable one', () => {
  const { playable, issues } = buildSongCatalog([
    // Unplayable: no media URL. Must not claim "사계".
    playableRecord({ id: 'ghost', title: '사계', aliases: [], mediaUrl: null }),
    playableRecord({ id: 'real', title: '사계', aliases: [] }),
  ]);
  assert.deepEqual(playable.map((s) => s.id), ['real']);
  assert.equal(issues.some((i) => i.code === 'DUPLICATE_ALIAS'), false);
  assert.equal(createSongMatcher(playable[0]).matches('사계'), true);
});

test('createSongMatcher judges expanded aliases the same way the server will', () => {
  const { playable } = buildSongCatalog([playableRecord({ title: '피노키오 (Danger)' })]);
  const matcher = createSongMatcher(playable[0]);
  assert.equal(matcher.matches('피노키오'), true);
  assert.equal(matcher.matches('Danger'), true);
  assert.equal(matcher.matches('  피노키오  '), true);
  assert.equal(matcher.matches('danger!'), true);
  assert.equal(matcher.matches('피노키오 대소동'), false);
  assert.equal(matcher.matches(''), false);
});

test('toRoundPublicPayload never leaks the answer to clients', () => {
  const { playable } = buildSongCatalog([playableRecord({ title: 'Dynamite' })]);
  const payload = toRoundPublicPayload(playable[0], 0, 20);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('Dynamite'), false);
  assert.equal(serialized.includes('dynamite'), false);
  assert.equal(serialized.includes('테스트 아티스트'), false);
  assert.equal(payload.song.clipDurationMs, 10_000);
  assert.equal(payload.song.totalSongs, 20);
  assert.equal(payload.mediaUrl, 'https://example.invalid/clip-a1b2c3.mp3');
  assert.equal(payload.livePlayback, false);
});

// --- YouTube songs, played by the host in the room ---------------------------

test('a YouTube id makes a record playable with no media URL at all', () => {
  const { playable, issues } = buildSongCatalog([
    { id: 'yt-1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'dQw4w9WgXcQ', youtubeStart: 45 },
  ]);
  assert.deepEqual(issues, []);
  assert.equal(playable.length, 1);
  assert.equal(playable[0]?.youtubeId, 'dQw4w9WgXcQ');
  assert.equal(playable[0]?.mediaUrl, '');
  assert.equal(playable[0]?.clipStartMs, 45_000);
  // One minute of round: this window plus the 10 s answer grace.
  assert.equal(playable[0]!.clipEndMs - playable[0]!.clipStartMs, YOUTUBE_CLIP_MS);
});

test('a YouTube song with no start time begins at the beginning', () => {
  const { playable } = buildSongCatalog([
    { id: 'yt-1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'dQw4w9WgXcQ' },
  ]);
  assert.equal(playable[0]?.clipStartMs, 0);
});

test('the 5-15 second clip rule does not apply to a YouTube song', () => {
  // The same 50 s window would be CLIP_TOO_LONG as a hosted audio clip.
  const { issues } = buildSongCatalog([
    { id: 'yt-1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'dQw4w9WgXcQ' },
  ]);
  assert.deepEqual(issues, []);
});

test('a malformed YouTube id is refused rather than played', () => {
  const { playable, issues } = buildSongCatalog([
    { id: 'yt-1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'not-an-id' },
  ]);
  assert.deepEqual(playable, []);
  assert.equal(issues[0]?.code, 'INVALID_YOUTUBE_ID');
});

test('toRoundPublicPayload never leaks the YouTube id', () => {
  // The video's own title names the song, so the id is as secret as the title.
  const { playable } = buildSongCatalog([
    { id: 'yt-1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'dQw4w9WgXcQ' },
  ]);
  const payload = toRoundPublicPayload(playable[0]!, 0, 5);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('dQw4w9WgXcQ'), false);
  assert.equal(serialized.includes('Hype'), false);
  assert.equal(payload.mediaUrl, '');
  assert.equal(payload.livePlayback, true);
});

test('registering a YouTube link clears any audio clip on that song', () => {
  // Otherwise the song would carry both and how it plays would depend on
  // which branch buildSongCatalog happens to check first.
  const applied = applyMediaRegistrations(
    [playableRecord({ id: 'both' })],
    [{ id: 'both', youtubeId: 'dQw4w9WgXcQ', youtubeStart: 12 }],
  );
  assert.equal(applied[0]?.mediaUrl, null);
  assert.equal(applied[0]?.clipStart, null);
  assert.equal(applied[0]?.youtubeId, 'dQw4w9WgXcQ');

  const { playable } = buildSongCatalog(applied);
  assert.equal(playable[0]?.youtubeId, 'dQw4w9WgXcQ');
  assert.equal(playable[0]?.clipStartMs, 12_000);
});

test('registering an audio clip clears a YouTube link on that song', () => {
  const applied = applyMediaRegistrations(
    [{ id: 'yt', artist: 'a', title: 'b', youtubeId: 'dQw4w9WgXcQ' }],
    [{ id: 'yt', mediaUrl: 'https://example.invalid/x.mp3', clipStart: 0, clipEnd: 10 }],
  );
  assert.equal(applied[0]?.youtubeId, null);

  const { playable } = buildSongCatalog(applied);
  assert.equal(playable[0]?.youtubeId, null);
  assert.equal(playable[0]?.mediaUrl, 'https://example.invalid/x.mp3');
});

test('host media registration makes a recovered record playable', () => {
  // Exactly the shape every one of the 171 recovered records has.
  const recovered: RawSongRecord = {
    id: 'rec-1',
    artist: '아이유',
    title: '좋은 날',
    aliases: ['좋은 날'],
    mediaUrl: null,
    clipStart: null,
    clipEnd: null,
  };

  assert.equal(buildSongCatalog([recovered]).playable.length, 0);

  const registered = applyMediaRegistrations(
    [recovered],
    [{ id: 'rec-1', mediaUrl: 'https://cdn.invalid/a.mp3', clipStart: 30, clipEnd: 40 }],
  );
  const { playable } = buildSongCatalog(registered);

  assert.equal(playable.length, 1);
  assert.equal(playable[0].clipStartMs, 30_000);
  assert.equal(playable[0].clipEndMs, 40_000);
  // The original array is untouched, so a registration for one room cannot
  // change what another room sees.
  assert.equal(recovered.mediaUrl, null);
});

test('a registration for an unknown song id is ignored, never appended', () => {
  const records = [playableRecord({ id: 'known' })];
  const result = applyMediaRegistrations(records, [
    { id: 'ghost', mediaUrl: 'https://cdn.invalid/x.mp3', clipStart: 0, clipEnd: 10 },
  ]);

  // A request body must not be able to introduce a song — and therefore an
  // answer — the server never loaded.
  assert.deepEqual(result.map((record) => record.id), ['known']);
});

test('the last registration for a song wins', () => {
  const records = [playableRecord({ id: 'a' })];
  const result = applyMediaRegistrations(records, [
    { id: 'a', mediaUrl: 'https://cdn.invalid/first.mp3', clipStart: 0, clipEnd: 10 },
    { id: 'a', mediaUrl: 'https://cdn.invalid/second.mp3', clipStart: 5, clipEnd: 15 },
  ]);

  assert.equal(result[0].mediaUrl, 'https://cdn.invalid/second.mp3');
  assert.equal(result[0].clipStart, 5);
});
