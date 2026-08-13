import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySongFromVideo, oEmbedUrl, parseYouTubeLink } from './youtube.ts';

// --- Link parsing -----------------------------------------------------------

test('parseYouTubeLink accepts the forms a host actually pastes', () => {
  const cases: [string, string][] = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'], // pasted without a scheme
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'], // the bare id
    ['  https://youtu.be/dQw4w9WgXcQ  ', 'dQw4w9WgXcQ'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseYouTubeLink(input)?.videoId, expected, input);
  }
});

test('parseYouTubeLink reads the start time from a share link', () => {
  assert.equal(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ?t=75')?.startSeconds, 75);
  assert.equal(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ?t=75s')?.startSeconds, 75);
  assert.equal(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ?t=1m30s')?.startSeconds, 90);
  assert.equal(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s')?.startSeconds, 3723);
  assert.equal(parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=42')?.startSeconds, 42);
});

test('parseYouTubeLink reports no start time rather than zero', () => {
  // Null and 0 mean different things to the caller: "host did not choose" vs
  // "host chose the very beginning".
  assert.equal(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ')?.startSeconds, null);
});

test('parseYouTubeLink refuses anything it cannot be sure of', () => {
  const rejected = [
    '',
    '   ',
    'https://vimeo.com/123456',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/results?search_query=iu',
    'https://example.com/watch?v=dQw4w9WgXcQ', // right shape, wrong host
    'not a url at all',
  ];
  for (const input of rejected) {
    assert.equal(parseYouTubeLink(input), null, input);
  }
});

// --- Song identification ----------------------------------------------------

const CATALOG = [
  { id: 's1', title: 'Hype boy', artist: '뉴진스' },
  { id: 's2', title: '200%', artist: '악뮤' },
  { id: 's3', title: '좋은 날', artist: '아이유' },
  { id: 's4', title: 'HIP', artist: '마마무' },
  { id: 's5', title: 'Oh!', artist: '소녀시대' },
  { id: 's6', title: '다정히 내 이름을 부르면', artist: '경서예지, 전건호' },
];

test('identifySongFromVideo reads the real title formats uploaders use', () => {
  const cases: [string, string | null, string][] = [
    ["뉴진스 (NewJeans) 'Hype Boy' Official MV", 'HYBE LABELS', 's1'],
    ['[MV] AKMU(악뮤) - 200%', '1theK', 's2'],
    ['IU(아이유) _ Good Day(좋은 날) MV', '1theK', 's3'],
    ['마마무 (MAMAMOO) - HIP MV', 'RBW', 's4'],
    ['경서예지, 전건호 - 다정히 내 이름을 부르면', 'Music', 's6'],
  ];
  for (const [title, channel, expected] of cases) {
    assert.equal(identifySongFromVideo(title, channel, CATALOG)?.song.id, expected, title);
  }
});

test('a short title alone never wins — this is what stops the false matches', () => {
  // Each of these contains a catalog title as a substring and must still lose.
  const traps = [
    'Best Hip Hop Mix 2024 | 1 Hour Nonstop',
    'Johnny Cash - Hurt (Official Video)',
    'Top 200 Billboard Songs of 2003',
    'Ohio State Marching Band',
  ];
  for (const title of traps) {
    assert.equal(identifySongFromVideo(title, 'Some Channel', CATALOG), null, title);
  }
});

test('the artist name alone is not enough either', () => {
  // A different song by a catalogued artist must not be mistaken for the one
  // song of theirs that happens to be in the catalog.
  assert.equal(identifySongFromVideo('아이유 - 밤편지', '1theK', CATALOG), null);
});

test('a corroborated match beats a longer uncorroborated one', () => {
  const songs = [
    { id: 'long', title: '다정히 내 이름을 부르면', artist: '전혀 다른 가수' },
    { id: 'short', title: 'Hype boy', artist: '뉴진스' },
  ];
  const title = '뉴진스 Hype Boy · 다정히 내 이름을 부르면 커버';
  assert.equal(identifySongFromVideo(title, null, songs)?.song.id, 'short');
});

test('identifySongFromVideo reports whether the artist was confirmed', () => {
  const confirmed = identifySongFromVideo('뉴진스 - Hype Boy', null, CATALOG);
  assert.equal(confirmed?.artistConfirmed, true);

  // Long enough to match on its own, but nobody corroborated the artist.
  const unconfirmed = identifySongFromVideo('다정히 내 이름을 부르면 (cover)', null, CATALOG);
  assert.equal(unconfirmed?.song.id, 's6');
  assert.equal(unconfirmed?.artistConfirmed, false);
});

test('an empty or unmatchable video title matches nothing', () => {
  assert.equal(identifySongFromVideo('', null, CATALOG), null);
  assert.equal(identifySongFromVideo('!!! ???', null, CATALOG), null);
  assert.equal(identifySongFromVideo('Beethoven Symphony No. 5', 'Classical', CATALOG), null);
});

test('oEmbedUrl escapes the video id it is given', () => {
  const url = oEmbedUrl('abc&evil=1');
  assert.ok(!url.includes('&evil=1'), 'a crafted id must not add query parameters');
});
