import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist } from './playlist.ts';

const A = 'AbCdEfGhIjK';
const B = 'LmNoPqRsTuV';
const C = 'WxYzAbCdEfG';

test('a link on its own means "work the answer out from the video"', () => {
  const { entries, problems } = parsePlaylist(`https://youtu.be/${A}?t=45`);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.videoId, A);
  assert.equal(entries[0]?.startSeconds, 45);
  assert.deepEqual(entries[0]?.answers, []);
});

test('answers after the separator are taken verbatim', () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A} | 좋은 날`);
  assert.deepEqual(entries[0]?.answers, ['좋은 날']);
});

test('several answers are separated by commas', () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A}?t=60 | Hype Boy, 하입보이 , 하이프보이`);
  assert.deepEqual(entries[0]?.answers, ['Hype Boy', '하입보이', '하이프보이']);
  assert.equal(entries[0]?.startSeconds, 60);
});

test('a tab works as a separator too, for anyone pasting from a spreadsheet', () => {
  const { entries } = parsePlaylist(`https://youtu.be/${A}\t좋은 날`);
  assert.deepEqual(entries[0]?.answers, ['좋은 날']);
});

test('comments and blank lines are ignored', () => {
  const { entries, problems } = parsePlaylist(
    ['# 우리 반 플레이리스트', '', `https://youtu.be/${A}`, '   ', `# https://youtu.be/${B}`].join('\n'),
  );
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 1, 'a commented-out link stays commented out');
});

test('one bad line does not cost the host the rest of the file', () => {
  const { entries, problems } = parsePlaylist(
    [`https://youtu.be/${A}`, '오타난 줄', `https://youtu.be/${B} | 좋은 날`].join('\n'),
  );
  assert.deepEqual(
    entries.map((entry) => entry.videoId),
    [A, B],
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.line, 2, 'the line number is what the host needs');
  assert.equal(problems[0]?.text, '오타난 줄');
});

test('the same video twice is reported rather than played twice', () => {
  const { entries, problems } = parsePlaylist(
    [`https://youtu.be/${A}`, `https://www.youtube.com/watch?v=${A}&t=30`].join('\n'),
  );
  assert.equal(entries.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.message, /1번째 줄/u);
});

test('a separator with nothing after it is a mistake, not an empty answer', () => {
  // Silently treating this as "auto-detect" would hide a truncated line.
  const { entries, problems } = parsePlaylist(`https://youtu.be/${A} | `);
  assert.deepEqual(entries, []);
  assert.equal(problems.length, 1);
});

test('line numbers count comments and blanks, so they match the editor', () => {
  const { entries } = parsePlaylist(['# 머리말', '', `https://youtu.be/${C}`].join('\n'));
  assert.equal(entries[0]?.line, 3);
});

test('an empty file is an empty playlist, not an error', () => {
  assert.deepEqual(parsePlaylist(''), { entries: [], problems: [] });
  assert.deepEqual(parsePlaylist('\n\n# 아무것도 없음\n'), { entries: [], problems: [] });
});

test('CRLF files parse the same as LF ones', () => {
  const { entries, problems } = parsePlaylist(`https://youtu.be/${A}\r\nhttps://youtu.be/${B}\r\n`);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 2);
});
