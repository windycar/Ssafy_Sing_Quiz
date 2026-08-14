import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameRoom,
  sanitizeNickname,
  ANSWER_GRACE_MS,
  COUNTDOWN_MS,
  REVEAL_MS,
  TEXT_ROUND_MS,
  HOST_GRACE_MS,
  HOST_ABANDON_MS,
  POINTS_PER_WIN,
  POINTS_BY_PLACE,
  scorersPerRound,
  MAX_GUESSES_PER_ROUND,
  MAX_PLAYERS,
} from './gameRoom.ts';
import type { Effect, ServerMessage, PlayerId } from './protocol.ts';
import { parseClientMessage } from './protocol.ts';
import { buildSongCatalog, YOUTUBE_CLIP_MS } from '../shared/songCatalog.ts';
import type { RawSongRecord, SongConfig } from '../shared/songCatalog.ts';
import { songQuestions, QUESTIONS_PER_TEXT_GAME } from '../shared/questions.ts';
import type { GameMode, Question } from '../shared/questions.ts';
import { bundledBank } from './questionBanks.ts';
import { selectQuestions } from './index.ts';

// The banks this repository ships, not whatever the machine running the tests
// happens to have under 문제/. See questionBanks.test.ts.
const PROVERB_BANK = bundledBank('proverb');
const IDIOM_BANK = bundledBank('idiom');

// --- Test helpers -----------------------------------------------------------

const SONGS: SongConfig[] = buildSongCatalog([
  {
    id: 's1',
    artist: '방탄소년단',
    title: 'Dynamite',
    aliases: ['다이나마이트'],
    mediaUrl: 'https://media.invalid/a1',
    clipStart: 30,
    clipEnd: 40,
  },
  {
    id: 's2',
    artist: 'f(x)',
    title: '피노키오 (Danger)',
    aliases: [],
    mediaUrl: 'https://media.invalid/a2',
    clipStart: 10,
    clipEnd: 20,
  },
]).playable;

const CLIP_MS = 10_000;
const ROUND_MS = CLIP_MS + ANSWER_GRACE_MS;

function privateMessagesFor(effects: Effect[], playerId: PlayerId): ServerMessage[] {
  return effects
    .filter((e): e is Extract<Effect, { kind: 'send' }> => e.kind === 'send' && e.to === playerId)
    .map((e) => e.message);
}

function broadcasts(effects: Effect[]): ServerMessage[] {
  return effects
    .filter((e): e is Extract<Effect, { kind: 'broadcast' }> => e.kind === 'broadcast')
    .map((e) => e.message);
}

function firstOfType<T extends ServerMessage['type']>(
  messages: ServerMessage[],
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  return messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

function errorReasonOf(effects: Effect[]): string | undefined {
  for (const effect of effects) {
    if (effect.kind === 'send' && effect.message.type === 'ERROR') return effect.message.reason;
  }
  return undefined;
}

/** Joins a player and returns their id and token. */
function join(
  room: GameRoom,
  nickname: string,
  now: number,
  hostToken?: string,
): { id: PlayerId; token: string } {
  const effects = room.handleMessage(
    { type: 'JOIN_ROOM', roomId: room.roomId, nickname, ...(hostToken === undefined ? {} : { hostToken }) },
    null,
    now,
  );
  const state = firstOfType(
    effects.filter((e): e is Extract<Effect, { kind: 'send' }> => e.kind === 'send').map((e) => e.message),
    'ROOM_STATE',
  );
  assert.ok(state, `join failed for ${nickname}`);
  return { id: state.playerId, token: state.playerToken };
}

/**
 * Joins the player who holds the host token.
 *
 * Which player is the host is not a function of join order — see `claimHost` —
 * so a test that needs a seated host has to present the token, exactly as the
 * host's own browser does.
 */
function joinHost(room: GameRoom, nickname: string, now: number): { id: PlayerId; token: string } {
  return join(room, nickname, now, room.hostToken);
}

/** Starts the game and runs the countdown so the first round is live. */
function startFirstRound(room: GameRoom, now: number): Effect[] {
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, now);
  return room.tick(now + COUNTDOWN_MS);
}

/**
 * Closes an open round without waiting out its deadline.
 *
 * A round runs until three players have scored, so a test with fewer players
 * than that has to end it deliberately. Skip is the host's own way of doing
 * exactly that, and it keeps whatever was already scored.
 */
function closeRound(room: GameRoom, now: number): Effect[] {
  return room.handleMessage({ type: 'HOST_SKIP', hostToken: room.hostToken }, null, now);
}

function newRoom(now = 1_000): GameRoom {
  return new GameRoom({ questions: songQuestions(SONGS), now });
}

/**
 * A room playing a text mode.
 *
 * The draw is taken unshuffled so a test can name the question it expects. The
 * shuffle itself is `selectQuestions`' job and is tested in
 * `questionBanks.test.ts`; mixing it in here would make every assertion below
 * depend on a random number.
 */
function textGame(bank: readonly Question[]): Question[] {
  return selectQuestions(bank, QUESTIONS_PER_TEXT_GAME, false);
}

/**
 * A room holding one text bank and nothing else.
 *
 * `mode` is not passed to the engine — a room has no mode, and each question
 * carries its own — but it stays in the signature because the callers read as
 * "a proverb room" and the bank alone would not say which.
 */
function textRoom(mode: GameMode, bank: readonly Question[], now = 1_000): GameRoom {
  void mode;
  return new GameRoom({ questions: textGame(bank), now });
}

// --- Catalog sanity ---------------------------------------------------------

test('test fixture builds two playable songs', () => {
  assert.equal(SONGS.length, 2);
  const first = SONGS[0];
  assert.ok(first);
  assert.equal(first.clipEndMs - first.clipStartMs, CLIP_MS);
});

// --- Nickname handling ------------------------------------------------------

test('sanitizeNickname strips control and zero-width characters', () => {
  assert.equal(sanitizeNickname('병욱\u0000\u200B'), '병욱');
  assert.equal(sanitizeNickname('  두   칸  '), '두 칸');
  assert.equal(sanitizeNickname('\u202Eevil'), 'evil');
});

test('sanitizeNickname rejects empty and whitespace-only names', () => {
  assert.equal(sanitizeNickname(''), null);
  assert.equal(sanitizeNickname('   '), null);
  assert.equal(sanitizeNickname('\u0000\u200B'), null);
});

test('sanitizeNickname truncates overly long names', () => {
  assert.equal(sanitizeNickname('가'.repeat(50))?.length, 16);
});

test('joining with a taken nickname gets a suffix, not a rejection', () => {
  const room = newRoom();
  join(room, '동철', 1_000);
  const second = join(room, '동철', 1_001);
  assert.equal(room.getPlayer(second.id)?.nickname, '동철-2');
});

test('an unusable nickname is rejected with INVALID_NICKNAME', () => {
  const room = newRoom();
  const effects = room.handleMessage({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '  ' }, null, 1_000);
  assert.equal(firstOfType(broadcasts(effects), 'PLAYER_JOINED'), undefined);
  assert.equal(errorReasonOf(effects), 'INVALID_NICKNAME');
});

// --- Lobby and phase gating -------------------------------------------------

test('the host token decides who is host, not who arrived first', () => {
  const room = newRoom();
  // The invited friend opens the link before the host does. Join order used to
  // hand them the room, and with it the ROUND_CUE that names the video.
  const early = join(room, '먼저온사람', 1_000);
  const host = joinHost(room, '방장', 1_001);

  const earlyState = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: early.token }, null, 1_002);
  const hostState = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: host.token }, null, 1_003);
  assert.equal(firstOfType(privateMessagesFor(earlyState, early.id), 'ROOM_STATE')?.isHost, false);
  assert.equal(firstOfType(privateMessagesFor(hostState, host.id), 'ROOM_STATE')?.isHost, true);
});

test('a join carrying a wrong host token is seated as an ordinary player', () => {
  const room = newRoom();
  const impostor = join(room, '사칭', 1_000, 'not-the-host-token');
  const state = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: impostor.token },
    null,
    1_001,
  );
  assert.equal(firstOfType(privateMessagesFor(state, impostor.id), 'ROOM_STATE')?.isHost, false);
});

test('opening the host link on a second device moves the host seat', () => {
  const room = newRoom();
  const phone = joinHost(room, '방장폰', 1_000);
  const laptop = joinHost(room, '방장노트북', 1_001);

  const phoneState = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: phone.token }, null, 1_002);
  const laptopState = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: laptop.token },
    null,
    1_003,
  );
  assert.equal(firstOfType(privateMessagesFor(phoneState, phone.id), 'ROOM_STATE')?.isHost, false);
  assert.equal(firstOfType(privateMessagesFor(laptopState, laptop.id), 'ROOM_STATE')?.isHost, true);
});

test('a rejoin can claim the host seat for a session already at the table', () => {
  const room = newRoom();
  const player = join(room, '나중에방장', 1_000);
  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: player.token, hostToken: room.hostToken },
    null,
    1_001,
  );
  assert.equal(firstOfType(privateMessagesFor(effects, player.id), 'ROOM_STATE')?.isHost, true);
});

test('joining after the game has started is refused', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '지각' }, null, 3_000);
  assert.equal(errorReasonOf(effects), 'GAME_ALREADY_STARTED');
});

test('the room refuses a 21st player', () => {
  const room = newRoom();
  for (let i = 0; i < MAX_PLAYERS; i += 1) join(room, `p${i}`, 1_000 + i);
  const effects = room.handleMessage({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: 'overflow' }, null, 2_000);
  assert.equal(errorReasonOf(effects), 'ROOM_FULL');
});

test('the game cannot start with no playable songs', () => {
  const room = new GameRoom({ questions: [], now: 1_000 });
  joinHost(room, '방장', 1_000);
  const effects = room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 2_000);
  assert.equal(errorReasonOf(effects), 'NOT_ENOUGH_PLAYERS');
  assert.equal(room.getPhase(), 'LOBBY');
});

test('phase advances LOBBY -> COUNTDOWN -> IN_ROUND on the server timer', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  assert.equal(room.getPhase(), 'LOBBY');

  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 2_000);
  assert.equal(room.getPhase(), 'COUNTDOWN');
  assert.equal(room.getTimer()?.at, 2_000 + COUNTDOWN_MS);

  // A tick before the deadline must not advance anything.
  assert.deepEqual(room.tick(2_000 + COUNTDOWN_MS - 1), []);
  assert.equal(room.getPhase(), 'COUNTDOWN');

  room.tick(2_000 + COUNTDOWN_MS);
  assert.equal(room.getPhase(), 'IN_ROUND');
});

// --- Host authority ---------------------------------------------------------

test('host actions require the host token, not merely being connected', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  const effects = room.handleMessage({ type: 'HOST_START', hostToken: 'guessed-token' }, host.id, 2_000);
  assert.equal(errorReasonOf(effects), 'NOT_HOST');
  assert.equal(room.getPhase(), 'LOBBY');
});

test('host actions outside their valid phase return an explicit error', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  const effects = room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, 2_000);
  assert.equal(errorReasonOf(effects), 'WRONG_PHASE');
});

test('the room join code and the host token are different secrets', () => {
  const room = newRoom();
  assert.notEqual(room.roomId, room.hostToken);
  // The host token must be substantially harder to guess than the join code.
  assert.ok(room.hostToken.length > room.roomId.length * 3, 'host token should carry far more entropy');
});

// --- Round start payload ----------------------------------------------------

test('ROUND_START never carries the title, artist, or aliases', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  const effects = startFirstRound(room, 2_000);

  const start = firstOfType(broadcasts(effects), 'ROUND_START');
  assert.ok(start);
  const serialized = JSON.stringify(start);
  assert.equal(serialized.includes('Dynamite'), false);
  assert.equal(serialized.includes('다이나마이트'), false);
  assert.equal(serialized.includes('방탄소년단'), false);
  assert.equal(start.song.totalSongs, 2);
  assert.equal(start.deadline, 2_000 + COUNTDOWN_MS + ROUND_MS);
});

// --- Scoring ----------------------------------------------------------------

test('every scoring place is worth one point, and the modes differ only in how many there are', () => {
  // The rule the whole scoring model rests on. A song round is decided by the
  // first correct answer because the clip is the race; a text clue sits on
  // screen with nothing to wait for, so it holds three places open instead.
  assert.deepEqual(POINTS_BY_PLACE.song, [1]);
  assert.deepEqual(POINTS_BY_PLACE.proverb, [1, 1, 1]);
  assert.deepEqual(POINTS_BY_PLACE.idiom, [1, 1, 1]);
  assert.equal(POINTS_PER_WIN, 1);

  assert.equal(scorersPerRound('song'), 1);
  assert.equal(scorersPerRound('proverb'), 3);
  assert.equal(scorersPerRound('idiom'), 3);

  // "최대 3명까지" counts scoring places in one question. It is not a room
  // size, and MAX_PLAYERS is the constant that is.
  for (const mode of ['song', 'proverb', 'idiom'] as const) {
    assert.notEqual(scorersPerRound(mode), MAX_PLAYERS);
  }
  assert.equal(MAX_PLAYERS, 20);
});

/** Joins `count` players into a song room and starts the first round. */
function roomWithPlayers(count: number): { room: GameRoom; players: { id: PlayerId; token: string }[]; at: number } {
  const room = newRoom();
  const players = Array.from({ length: count }, (_, i) => join(room, `p${i}`, 1_000 + i));
  startFirstRound(room, 2_000);
  return { room, players, at: 2_000 + COUNTDOWN_MS + 100 };
}

/** The same, for a text room. Three scoring places rather than one. */
function textRoomWithPlayers(
  mode: GameMode,
  bank: readonly Question[],
  count: number,
): { room: GameRoom; players: { id: PlayerId; token: string }[]; at: number; question: Question } {
  const room = textRoom(mode, bank);
  const players = Array.from({ length: count }, (_, i) => join(room, `p${i}`, 1_000 + i));
  startFirstRound(room, 2_000);
  const question = textGame(bank)[0];
  assert.ok(question !== undefined);
  return { room, players, at: 2_000 + COUNTDOWN_MS + 100, question };
}

// --- Song rounds: one place --------------------------------------------------

test('a song round is won by the first correct answer and ends there and then', () => {
  const { room, players, at } = roomWithPlayers(4);

  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '다이나 마이트!' }, players[0]!.id, at);
  const accepted = firstOfType(privateMessagesFor(effects, players[0]!.id), 'ANSWER_ACCEPTED');
  assert.equal(accepted?.place, 1);
  assert.equal(accepted?.pointsAwarded, 1);
  assert.equal(room.getPlayer(players[0]!.id)?.score, 1);

  assert.equal(room.getPhase(), 'REVEAL', 'a song round has only one place');
  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.answer.answer, 'Dynamite');
  assert.equal(reveal.song.title, 'Dynamite');
  assert.equal(reveal.winner?.playerId, players[0]!.id);
  assert.deepEqual(
    reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
    [[1, 1]],
  );
});

test('a second correct answer in a song round arrives too late to score', () => {
  const { room, players, at } = roomWithPlayers(4);

  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[0]!.id, at);
  const late = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[1]!.id, at + 1);

  const messages = privateMessagesFor(late, players[1]!.id);
  assert.deepEqual(
    messages.map((message) => message.type),
    ['ANSWER_TOO_LATE'],
  );
  // Never a verdict: telling a late player they were right reveals the answer
  // to them before ROUND_REVEAL.
  assert.equal(JSON.stringify(messages[0]).includes('Dynamite'), false);
  assert.equal(room.getPlayer(players[1]!.id)?.score, 0);
});

test('a song round goes to one player only, even one microsecond apart', () => {
  const { room, players, at } = roomWithPlayers(4);

  // Same server timestamp: the tie must still be broken by processing order,
  // because the place is taken synchronously inside one handler.
  const first = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[0]!.id, at);
  const second = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[1]!.id, at);

  assert.equal(firstOfType(privateMessagesFor(first, players[0]!.id), 'ANSWER_ACCEPTED')?.place, 1);
  assert.equal(firstOfType(privateMessagesFor(second, players[1]!.id), 'ANSWER_ACCEPTED'), undefined);
  assert.equal(room.getPlayer(players[0]!.id)?.score, 1);
  assert.equal(room.getPlayer(players[1]!.id)?.score, 0);
});

// --- Text rounds: three places ----------------------------------------------

for (const [mode, bank] of [
  ['proverb', PROVERB_BANK],
  ['idiom', IDIOM_BANK],
] as const) {
  test(`${mode}: the first correct answer scores 1 and the round stays open`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);

    const effects = room.handleMessage(
      { type: 'SUBMIT_ANSWER', guess: question.aliases[0] as string },
      players[0]!.id,
      at,
    );
    const accepted = firstOfType(privateMessagesFor(effects, players[0]!.id), 'ANSWER_ACCEPTED');
    assert.equal(accepted?.place, 1);
    assert.equal(accepted?.pointsAwarded, 1);
    assert.equal(room.getPlayer(players[0]!.id)?.score, 1);

    assert.equal(room.getPhase(), 'IN_ROUND', 'second and third place are still open');
    assert.equal(firstOfType(broadcasts(effects), 'ROUND_REVEAL'), undefined, 'nothing is revealed yet');
    assert.equal(broadcasts(effects).length, 0, 'nobody else learns that a place was taken');
  });

  test(`${mode}: the second correct answer scores 1 and the round still stays open`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at + 1);

    const accepted = firstOfType(privateMessagesFor(effects, players[1]!.id), 'ANSWER_ACCEPTED');
    assert.equal(accepted?.place, 2);
    assert.equal(accepted?.pointsAwarded, 1);
    assert.equal(room.getPlayer(players[1]!.id)?.score, 1);
    assert.equal(room.getPhase(), 'IN_ROUND');
    assert.equal(firstOfType(broadcasts(effects), 'ROUND_REVEAL'), undefined);
  });

  test(`${mode}: the third correct answer scores 1 and triggers exactly one reveal`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at + 1);
    const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[2]!.id, at + 2);

    const accepted = firstOfType(privateMessagesFor(effects, players[2]!.id), 'ANSWER_ACCEPTED');
    assert.equal(accepted?.place, 3);
    assert.equal(accepted?.pointsAwarded, 1);
    assert.equal(room.getPhase(), 'REVEAL');

    const reveals = broadcasts(effects).filter((message) => message.type === 'ROUND_REVEAL');
    assert.equal(reveals.length, 1, 'the third scorer closes the round once, not twice');

    const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
    assert.ok(reveal);
    assert.equal(reveal.winner?.playerId, players[0]!.id);
    assert.deepEqual(
      reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
      [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
    );
    assert.deepEqual(
      reveal.scorers.map((entry) => entry.playerId),
      [players[0]!.id, players[1]!.id, players[2]!.id],
      'places follow server receipt order',
    );
  });

  test(`${mode}: a fourth correct answer earns nothing`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    for (const index of [0, 1, 2]) {
      room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[index]!.id, at + index);
    }
    const late = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[3]!.id, at + 3);

    const messages = privateMessagesFor(late, players[3]!.id);
    assert.deepEqual(
      messages.map((message) => message.type),
      ['ANSWER_TOO_LATE'],
    );
    assert.equal(JSON.stringify(messages[0]).includes(guess), false, 'no verdict, so no answer');
    assert.equal(room.getPlayer(players[3]!.id)?.score, 0);
  });

  test(`${mode}: a player who already scored cannot score again in the same round`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    const again = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at + 1);

    assert.ok(firstOfType(privateMessagesFor(again, players[0]!.id), 'ANSWER_TOO_LATE'));
    assert.equal(firstOfType(privateMessagesFor(again, players[0]!.id), 'ANSWER_ACCEPTED'), undefined);
    assert.equal(room.getPlayer(players[0]!.id)?.score, 1, 'no double scoring');
    assert.equal(room.getPhase(), 'IN_ROUND', 'a repeat submission does not take a place');

    // And the place it did not take is still there for somebody else.
    const other = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at + 2);
    assert.equal(firstOfType(privateMessagesFor(other, players[1]!.id), 'ANSWER_ACCEPTED')?.place, 2);
  });

  test(`${mode}: two correct answers at the same timestamp take different places`, () => {
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    // Same server timestamp: the tie must still be broken by processing order,
    // because places are taken synchronously inside one handler.
    const first = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    const second = room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at);

    assert.equal(firstOfType(privateMessagesFor(first, players[0]!.id), 'ANSWER_ACCEPTED')?.place, 1);
    assert.equal(firstOfType(privateMessagesFor(second, players[1]!.id), 'ANSWER_ACCEPTED')?.place, 2);
    assert.equal(room.getPlayer(players[0]!.id)?.score, 1);
    assert.equal(room.getPlayer(players[1]!.id)?.score, 1);
  });

  test(`${mode}: with fewer than three scorers the round runs to its deadline and keeps the points`, () => {
    // The case that matters at a real event: a room where only one or two
    // people get it must not hang, and must not lose what was already earned.
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 4);
    const guess = question.aliases[0] as string;

    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at + 1);
    assert.equal(room.getPhase(), 'IN_ROUND');

    const roundStart = 2_000 + COUNTDOWN_MS;
    // A tick before the deadline changes nothing: the round is genuinely open.
    assert.deepEqual(room.tick(roundStart + TEXT_ROUND_MS - 1), []);
    assert.equal(room.getPhase(), 'IN_ROUND');

    const effects = room.tick(roundStart + TEXT_ROUND_MS);
    const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
    assert.ok(reveal);
    assert.equal(room.getPhase(), 'REVEAL');
    assert.deepEqual(
      reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
      [
        [1, 1],
        [2, 1],
      ],
    );
    assert.equal(room.getPlayer(players[0]!.id)?.score, 1);
    assert.equal(room.getPlayer(players[1]!.id)?.score, 1);
  });

  test(`${mode}: the deadline rule holds when fewer than three people are connected`, () => {
    // Two players cannot fill three places however fast they answer, so the
    // deadline is the only thing that can end the round.
    const { room, players, at, question } = textRoomWithPlayers(mode, bank, 2);
    const guess = question.aliases[0] as string;
    const roundStart = 2_000 + COUNTDOWN_MS;

    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[0]!.id, at);
    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[1]!.id, at + 1);
    assert.equal(room.getPhase(), 'IN_ROUND', 'two players can never fill three places');
    assert.equal(room.getTimer()?.at, roundStart + TEXT_ROUND_MS, 'the deadline timer is still armed');

    room.tick(roundStart + TEXT_ROUND_MS);
    assert.equal(room.getPhase(), 'REVEAL');
    assert.equal(room.getPlayer(players[0]!.id)?.score, 1);
    assert.equal(room.getPlayer(players[1]!.id)?.score, 1);
  });
}

test('a wrong answer is private to the guesser', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  join(room, '남', 1_001);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage(
    { type: 'SUBMIT_ANSWER', guess: 'butter' },
    host.id,
    2_000 + COUNTDOWN_MS + 100,
  );
  assert.equal(broadcasts(effects).length, 0, 'a miss must never be broadcast');
  assert.equal(firstOfType(privateMessagesFor(effects, host.id), 'ANSWER_REJECTED')?.guess, 'butter');
  assert.equal(room.getPhase(), 'IN_ROUND');
});

test('guesses are rate-limited per player per round', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 10;

  for (let i = 0; i < MAX_GUESSES_PER_ROUND; i += 1) {
    const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: `miss-${i}` }, host.id, at + i);
    assert.equal(effects.length, 1, `guess ${i} should still be answered`);
  }
  const blocked = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'miss-extra' }, host.id, at + 100);
  assert.deepEqual(blocked, [], 'further guesses are ignored');

  // The limit must not become a way to win after being blocked.
  const winAttempt = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, at + 101);
  assert.deepEqual(winAttempt, []);
  assert.equal(room.getPlayer(host.id)?.score, 0);
});

test('a guess arriving during REVEAL is acknowledged as late, not scored', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.tick(roundStart + ROUND_MS); // timeout -> REVEAL
  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, roundStart + ROUND_MS + 1);
  assert.deepEqual(
    privateMessagesFor(effects, host.id).map((m) => m.type),
    ['ANSWER_TOO_LATE'],
  );
  assert.equal(room.getPlayer(host.id)?.score, 0);
});

test('a guess during COUNTDOWN is silently ignored', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 2_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, 2_100), []);
});

test('a timeout reveals the answer with no winner', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.tick(2_000 + COUNTDOWN_MS + ROUND_MS);
  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.equal(reveal?.winner, null);
  assert.deepEqual(reveal?.scorers, []);
  assert.equal(reveal?.answer.answer, 'Dynamite');
  assert.equal(reveal?.song.title, 'Dynamite');
  assert.equal(room.getPhase(), 'REVEAL');
});

// --- Pause and resume -------------------------------------------------------

test('pause and resume preserve the remaining answer time exactly', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  const startEffects = startFirstRound(room, 2_000);
  const originalDeadline = firstOfType(broadcasts(startEffects), 'ROUND_START')?.deadline;
  assert.ok(originalDeadline);

  const roundStart = 2_000 + COUNTDOWN_MS;
  room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 3_000);
  assert.equal(room.getTimer(), null, 'the deadline timer must stop while paused');

  const resumeEffects = room.handleMessage(
    { type: 'HOST_RESUME', hostToken: room.hostToken },
    null,
    roundStart + 8_000,
  );
  const resumed = firstOfType(broadcasts(resumeEffects), 'ROUND_RESUMED');
  assert.equal(resumed?.newDeadline, originalDeadline + 5_000, 'the 5s pause shifts the deadline by exactly 5s');
});

test('guesses are ignored while the round is paused', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 1_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, roundStart + 2_000), []);
  assert.equal(room.getPlayer(host.id)?.score, 0);
});

// --- An absent host ---------------------------------------------------------

test('the host disconnecting mid-round freezes the answer window', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleDisconnect(host.id, roundStart + 1_000);
  const paused = firstOfType(broadcasts(effects), 'ROUND_PAUSED');
  assert.ok(paused);
  assert.equal(paused.hostAway, true, 'players must be able to tell an outage from a break');
  assert.equal(paused.hostGraceEndsAt, roundStart + 1_000 + HOST_GRACE_MS);
  // The deadline is gone, but the room is not left with nothing pending: what
  // is armed now is the clock on the host's absence.
  assert.deepEqual(room.getTimer(), { at: roundStart + 1_000 + HOST_GRACE_MS, kind: 'HOST_GRACE' });
});

test('a player disconnecting mid-round does not pause anything', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleDisconnect(guest.id, roundStart + 1_000);
  assert.equal(firstOfType(broadcasts(effects), 'ROUND_PAUSED'), undefined);
  assert.deepEqual(room.getTimer(), { at: roundStart + ROUND_MS, kind: 'DEADLINE' });
});

test('the player who merely joined first leaving does not pause the round', () => {
  // The regression this whole change exists for: an invited friend arriving
  // before the host used to be the host, so their leaving froze a round the
  // real host was present for and could not un-freeze from the other side.
  const room = newRoom();
  const early = join(room, '먼저온사람', 1_000);
  joinHost(room, '방장', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleDisconnect(early.id, roundStart + 1_000);
  assert.equal(firstOfType(broadcasts(effects), 'ROUND_PAUSED'), undefined);
  assert.deepEqual(room.getTimer(), { at: roundStart + ROUND_MS, kind: 'DEADLINE' });
});

test('the host returning inside the grace period resumes the round automatically', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  const startEffects = startFirstRound(room, 2_000);
  const originalDeadline = firstOfType(broadcasts(startEffects), 'ROUND_START')?.deadline;
  assert.ok(originalDeadline);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleDisconnect(host.id, roundStart + 1_000);
  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    roundStart + 5_000,
  );

  const resumed = firstOfType(broadcasts(effects), 'ROUND_RESUMED');
  assert.ok(resumed, 'the host should not have to press resume after a refresh');
  assert.equal(resumed.newDeadline, originalDeadline + 4_000, 'the 4s outage shifts the deadline by exactly 4s');
  assert.deepEqual(room.getTimer(), { at: originalDeadline + 4_000, kind: 'DEADLINE' });
});

test('a pause the host chose survives their reconnect', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 1_000);
  room.handleDisconnect(host.id, roundStart + 2_000);
  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    roundStart + 3_000,
  );

  assert.equal(
    firstOfType(broadcasts(effects), 'ROUND_RESUMED'),
    undefined,
    'the host stopped the round deliberately; only they may start it again',
  );
  assert.equal(room.getTimer(), null, 'and the clock on their absence is off, because they are back');

  // Every screen was showing a countdown that has just stopped being true, and
  // no other message would ever correct it.
  const paused = firstOfType(broadcasts(effects), 'ROUND_PAUSED');
  assert.ok(paused, 'the outage countdown has to be called off explicitly');
  assert.equal(paused.hostAway, undefined);
  assert.equal(paused.hostGraceEndsAt, undefined);
});

test('the grace period running out resumes a round that can be played without the host', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  const startEffects = startFirstRound(room, 2_000);
  const originalDeadline = firstOfType(broadcasts(startEffects), 'ROUND_START')?.deadline;
  assert.ok(originalDeadline);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleDisconnect(host.id, roundStart + 1_000);
  const effects = room.tick(roundStart + 1_000 + HOST_GRACE_MS);

  const resumed = firstOfType(broadcasts(effects), 'ROUND_RESUMED');
  assert.ok(resumed, 'a room of twenty must not be held by one absent phone');
  assert.equal(resumed.newDeadline, originalDeadline + HOST_GRACE_MS);

  // And it is a real round again, not just an unfrozen screen.
  const guess = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, guest.id, resumed.newDeadline - 100);
  assert.equal(firstOfType(privateMessagesFor(guess, guest.id), 'ANSWER_ACCEPTED')?.place, 1);
});

test('a hostless game still runs to the end on server timers alone', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleDisconnect(host.id, roundStart + 1_000);
  let clock = roundStart + 1_000 + HOST_GRACE_MS;
  room.tick(clock);

  // Two songs, and nobody left who can skip or advance either of them.
  const seen: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    const timer = room.getTimer();
    if (timer === null) break;
    clock = timer.at;
    for (const message of broadcasts(room.tick(clock))) seen.push(message.type);
  }

  assert.ok(seen.includes('GAME_OVER'), `the game must finish unattended; saw ${seen.join(', ')}`);
  assert.equal(room.getPhase(), 'FINISHED');
  assert.equal(room.getPlayer(guest.id)?.connected, true);
});

test('an absent host gets three times as long when only their device has the music', () => {
  const room = youtubeRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleDisconnect(host.id, roundStart + 1_000);
  assert.equal(
    firstOfType(broadcasts(effects), 'ROUND_PAUSED')?.hostGraceEndsAt,
    roundStart + 1_000 + HOST_ABANDON_MS,
    'ending the game is not reversible, so this wait is the long one',
  );
});

test('a YouTube game whose host never returns ends on the scores already earned', () => {
  const room = youtubeRoom();
  const host = joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Hype boy' }, guest.id, roundStart + 100);
  // That answer closed round one. Run into round two, then lose the host.
  room.tick(roundStart + REVEAL_MS + 100);
  const secondRound = room.getTimer();
  assert.ok(secondRound);
  room.tick(secondRound.at);

  room.handleDisconnect(host.id, secondRound.at + 1_000);
  const effects = room.tick(secondRound.at + 1_000 + HOST_ABANDON_MS);

  const over = firstOfType(broadcasts(effects), 'GAME_OVER');
  assert.ok(over, 'a silent YouTube round is not a round anybody can play');
  assert.equal(room.getPhase(), 'FINISHED');
  assert.equal(over.finalRanks.find((entry) => entry.playerId === guest.id)?.score, POINTS_PER_WIN);
  assert.equal(room.getTimer(), null, 'a finished room must leave nothing armed');
});

test('a snapshot taken during an outage says the host is away and when the wait ends', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;
  room.handleDisconnect(host.id, roundStart + 1_000);

  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: guest.token },
    null,
    roundStart + 2_000,
  );
  const state = firstOfType(privateMessagesFor(effects, guest.id), 'ROOM_STATE');
  assert.equal(state?.round?.paused, true);
  assert.equal(state?.round?.hostAway, true);
  assert.equal(state?.round?.hostGraceEndsAt, roundStart + 1_000 + HOST_GRACE_MS);
});

test('a pause the host chose is not reported as an outage', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const paused = firstOfType(
    broadcasts(room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 1_000)),
    'ROUND_PAUSED',
  );
  assert.equal(paused?.hostAway, undefined);
  assert.equal(paused?.hostGraceEndsAt, undefined);
  assert.equal(room.getTimer(), null, 'a pause the host chose has no deadline of its own');

  const state = firstOfType(
    privateMessagesFor(
      room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: guest.token }, null, roundStart + 2_000),
      guest.id,
    ),
    'ROOM_STATE',
  );
  assert.equal(state?.round?.hostAway, false);
  assert.equal(state?.round?.hostGraceEndsAt, null);
});

test('skipping ends the round with no winner', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage(
    { type: 'HOST_SKIP', hostToken: room.hostToken },
    null,
    2_000 + COUNTDOWN_MS + 500,
  );
  assert.equal(firstOfType(broadcasts(effects), 'ROUND_REVEAL')?.winner, null);
});

test('skip ends a round nobody has answered', () => {
  const room = newRoom();
  joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const skip = closeRound(room, 2_000 + COUNTDOWN_MS + 200);
  const reveal = firstOfType(broadcasts(skip), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.winner, null);
  assert.deepEqual(reveal.scorers, []);
});

test('skip closes a partly-scored text round and keeps the points already earned', () => {
  const { room, players, at, question } = textRoomWithPlayers('proverb', PROVERB_BANK, 4);

  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: question.aliases[0] as string }, players[0]!.id, at);
  const skip = room.handleMessage({ type: 'HOST_SKIP', hostToken: room.hostToken }, null, at + 10);

  const reveal = firstOfType(broadcasts(skip), 'ROUND_REVEAL');
  assert.ok(reveal, 'skip is an immediate timeout, so it reveals');
  assert.deepEqual(
    reveal.scorers.map((entry) => entry.pointsAwarded),
    [1],
  );
  assert.equal(room.getPlayer(players[0]!.id)?.score, 1, 'skip does not take the points away');
});

test('skip cannot reveal a round a correct answer already closed', () => {
  const { room, players, at } = roomWithPlayers(4);

  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[0]!.id, at);
  const skip = room.handleMessage({ type: 'HOST_SKIP', hostToken: room.hostToken }, null, at + 10);
  assert.equal(
    skip.some((e) => e.kind === 'broadcast' && e.message.type === 'ROUND_REVEAL'),
    false,
    'a resolved round must not reveal twice',
  );
  assert.equal(room.getPlayer(players[0]!.id)?.score, 1, 'skip does not take the point away');
});

test('skip cannot reveal a text round the third scorer already closed', () => {
  const { room, players, at, question } = textRoomWithPlayers('idiom', IDIOM_BANK, 4);
  const guess = question.aliases[0] as string;

  for (const index of [0, 1, 2]) {
    room.handleMessage({ type: 'SUBMIT_ANSWER', guess }, players[index]!.id, at + index);
  }
  const skip = room.handleMessage({ type: 'HOST_SKIP', hostToken: room.hostToken }, null, at + 10);
  assert.equal(
    skip.some((e) => e.kind === 'broadcast' && e.message.type === 'ROUND_REVEAL'),
    false,
    'a resolved round must not reveal twice',
  );
});

// --- Round progression ------------------------------------------------------

test('the game runs every song and then finishes', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  // Round 1 times out.
  let clock = 2_000 + COUNTDOWN_MS + ROUND_MS;
  room.tick(clock);
  clock += REVEAL_MS;
  room.tick(clock); // REVEAL -> COUNTDOWN
  assert.equal(room.getPhase(), 'COUNTDOWN');
  clock += COUNTDOWN_MS;
  const secondStart = room.tick(clock);
  assert.equal(room.getPhase(), 'IN_ROUND');
  assert.equal(firstOfType(broadcasts(secondStart), 'ROUND_START')?.song.index, 1);

  // Round 2 is answered, which closes it: a song round has one place.
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '피노키오' }, host.id, clock + 100);
  assert.equal(room.getPhase(), 'REVEAL');
  clock += REVEAL_MS + 200;
  const over = room.tick(clock);
  assert.equal(room.getPhase(), 'FINISHED');
  const gameOver = firstOfType(broadcasts(over), 'GAME_OVER');
  assert.equal(gameOver?.finalRanks.length, 1);
  assert.equal(gameOver?.finalRanks[0].score, POINTS_PER_WIN);
});

test('the expanded alias from the catalog is accepted by the server', () => {
  // "피노키오" is not in the source aliases; it comes from title expansion.
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  room.tick(2_000 + COUNTDOWN_MS + ROUND_MS);
  room.tick(2_000 + COUNTDOWN_MS + ROUND_MS + REVEAL_MS);
  const clock = 2_000 + COUNTDOWN_MS + ROUND_MS + REVEAL_MS + COUNTDOWN_MS;
  room.tick(clock);

  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '  피노키오  ' }, host.id, clock + 10);
  assert.ok(firstOfType(privateMessagesFor(effects, host.id), 'ANSWER_ACCEPTED'));
});

// --- Leaderboard ------------------------------------------------------------

test('equal scores share a rank and the next distinct score skips ahead', () => {
  const room = newRoom();
  const a = join(room, 'a', 1_000);
  const b = join(room, 'b', 1_001);
  join(room, 'c', 1_002);
  join(room, 'd', 1_003);

  startFirstRound(room, 2_000);
  // Round 1 to `a`, which closes it; then walk the clock to round 2.
  let clock = 2_000 + COUNTDOWN_MS + 10;
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, a.id, clock);
  clock += REVEAL_MS;
  room.tick(clock);
  assert.equal(room.getPhase(), 'COUNTDOWN');
  clock += COUNTDOWN_MS;
  room.tick(clock);
  assert.equal(room.getPhase(), 'IN_ROUND');

  // Round 2 to `b`, so the two of them tie on one point each.
  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '피노키오' }, b.id, clock + 10);

  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.deepEqual(
    reveal.leaderboard.map((entry) => entry.rank),
    [1, 1, 3, 3],
    'two winners tie at rank 1, two scoreless players tie at rank 3',
  );
});

test('each player receives their own rank alongside the shared top five', () => {
  const room = newRoom();
  const players = Array.from({ length: 7 }, (_, i) => join(room, `p${i}`, 1_000 + i));
  startFirstRound(room, 2_000);
  // The boards are published at REVEAL, which a correct answer triggers.
  const at = 2_000 + COUNTDOWN_MS + 10;
  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, players[6]!.id, at);

  const updates = effects.filter((e) => e.kind === 'send' && e.message.type === 'LEADERBOARD_UPDATE');
  assert.equal(updates.length, 7, 'every player gets one update');

  for (const player of players) {
    const update = firstOfType(privateMessagesFor(effects, player.id), 'LEADERBOARD_UPDATE');
    assert.ok(update, `no update for ${player.id}`);
    assert.equal(update.topFive.length, 5);
    assert.equal(update.you.playerId, player.id);
  }
  const winnerUpdate = firstOfType(privateMessagesFor(effects, players[6]!.id), 'LEADERBOARD_UPDATE');
  assert.equal(winnerUpdate?.you.rank, 1);
  assert.equal(winnerUpdate?.you.score, POINTS_PER_WIN);
});

// --- Reconnect --------------------------------------------------------------

test('a disconnect keeps the score and roster slot', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  join(room, '남', 1_001);
  startFirstRound(room, 2_000);
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, 2_000 + COUNTDOWN_MS + 10);

  const effects = room.handleDisconnect(host.id, 2_000 + COUNTDOWN_MS + 20);
  assert.equal(firstOfType(broadcasts(effects), 'PLAYER_CONNECTION_CHANGED')?.connected, false);
  assert.equal(room.getPlayer(host.id)?.score, POINTS_PER_WIN);
  assert.equal(room.getPlayer(host.id)?.connected, false);
});

test('rejoining restores a full snapshot including the live deadline', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;
  room.handleDisconnect(host.id, roundStart + 100);
  // The host disconnect paused the round; resume so the snapshot is a live one.
  room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: host.token }, null, roundStart + 200);
  room.handleMessage({ type: 'HOST_RESUME', hostToken: room.hostToken }, host.id, roundStart + 200);

  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    roundStart + 300,
  );
  const state = firstOfType(privateMessagesFor(effects, host.id), 'ROOM_STATE');
  assert.ok(state);
  assert.equal(state.phase, 'IN_ROUND');
  assert.equal(state.isHost, true);
  assert.equal(state.round?.paused, false);
  assert.equal(state.round?.deadline, roundStart + ROUND_MS + 100);
  assert.equal(state.players.length, 1);
});

test('a rejoin snapshot never contains the answer', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    2_000 + COUNTDOWN_MS + 50,
  );
  const state = firstOfType(privateMessagesFor(effects, host.id), 'ROOM_STATE');
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('Dynamite'), false);
  assert.equal(serialized.includes('다이나마이트'), false);
  assert.equal(serialized.includes('방탄소년단'), false);
});

test('an unknown session token is refused', () => {
  const room = newRoom();
  const effects = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: 'nope' }, null, 1_000);
  assert.equal(errorReasonOf(effects), 'UNKNOWN_SESSION');
});

test('a player token identifies exactly one player', () => {
  const room = newRoom();
  const a = join(room, 'a', 1_000);
  const b = join(room, 'b', 1_001);
  assert.notEqual(a.token, b.token);
  assert.equal(room.resolveToken(a.token), a.id);
  assert.equal(room.resolveToken('unrelated'), null);
});

// --- Message parsing --------------------------------------------------------

test('parseClientMessage rejects malformed and unknown input', () => {
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('null'), null);
  assert.equal(parseClientMessage('[]'), null);
  assert.equal(parseClientMessage('{"type":"NOPE"}'), null);
  assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER"}'), null);
  assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER","guess":42}'), null);
  assert.equal(parseClientMessage('{"type":"SET_READY","ready":"yes"}'), null);
});

test('parseClientMessage accepts well-formed messages', () => {
  assert.deepEqual(parseClientMessage('{"type":"SUBMIT_ANSWER","guess":"a"}'), {
    type: 'SUBMIT_ANSWER',
    guess: 'a',
  });
  assert.deepEqual(parseClientMessage('{"type":"SET_READY","ready":true}'), { type: 'SET_READY', ready: true });
});

test('an oversized guess is dropped rather than judged', () => {
  const room = newRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const huge = 'x'.repeat(5_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: huge }, host.id, 2_000 + COUNTDOWN_MS + 5), []);
});

test('messages from a connection that never joined are refused', () => {
  const room = newRoom();
  const effects = room.handleMessage({ type: 'SET_READY', ready: true }, null, 1_000);
  assert.equal(errorReasonOf(effects), 'NOT_JOINED');
});

// --- YouTube rounds, played by the host in the room --------------------------

const YOUTUBE_SONGS: SongConfig[] = buildSongCatalog([
  { id: 'y1', artist: '뉴진스', title: 'Hype boy', youtubeId: 'dQw4w9WgXcQ', youtubeStart: 45 },
  { id: 'y2', artist: '아이유', title: '좋은 날', youtubeId: 'oHg5SJYRHA0' },
]).playable;

function youtubeRoom(now = 1_000): GameRoom {
  return new GameRoom({ questions: songQuestions(YOUTUBE_SONGS), now });
}

test('a YouTube round lasts exactly one minute', () => {
  // YOUTUBE_CLIP_MS and ANSWER_GRACE_MS live in different modules because
  // shared/ must not import server/. This is the assertion that keeps the two
  // in step; if it fails, one of them moved.
  assert.equal(YOUTUBE_CLIP_MS + ANSWER_GRACE_MS, 60_000);

  const room = youtubeRoom();
  joinHost(room, '방장', 1_000);
  const effects = startFirstRound(room, 2_000);
  const start = firstOfType(broadcasts(effects), 'ROUND_START');
  assert.ok(start);
  assert.equal(start.deadline - start.serverStartedAt, 60_000);
});

test('the YouTube id reaches the host and nobody else', () => {
  const room = youtubeRoom();
  const host = joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_100);
  const effects = startFirstRound(room, 2_000);

  // The broadcast every player sees must not name the video at all.
  const start = firstOfType(broadcasts(effects), 'ROUND_START');
  assert.ok(start);
  assert.equal(start.livePlayback, true);
  assert.equal(start.mediaUrl, '');
  assert.equal(JSON.stringify(broadcasts(effects)).includes('dQw4w9WgXcQ'), false);

  const toHost = firstOfType(privateMessagesFor(effects, host.id), 'ROUND_CUE');
  assert.ok(toHost, 'the host needs to know what to play');
  assert.equal(toHost.youtubeId, 'dQw4w9WgXcQ');
  assert.equal(toHost.startMs, 45_000);
  assert.equal(toHost.playMs, YOUTUBE_CLIP_MS);

  assert.equal(
    firstOfType(privateMessagesFor(effects, guest.id), 'ROUND_CUE'),
    undefined,
    'a player who learns the video id has been handed the answer',
  );
});

test('a host who refreshes mid-round gets the cue back', () => {
  const room = youtubeRoom();
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    3_000,
  );
  const cue = firstOfType(privateMessagesFor(effects, host.id), 'ROUND_CUE');
  assert.ok(cue, 'otherwise the host has a running timer and no video');
  assert.equal(cue.youtubeId, 'dQw4w9WgXcQ');
});

test('a player who refreshes mid-round still gets no cue', () => {
  const room = youtubeRoom();
  joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_100);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: guest.token },
    null,
    3_000,
  );
  assert.equal(firstOfType(privateMessagesFor(effects, guest.id), 'ROUND_CUE'), undefined);
  assert.equal(JSON.stringify(effects).includes('dQw4w9WgXcQ'), false);
});

test('a hundred-song game finishes, and scores exactly one point per answered round', () => {
  // The size this is actually used at. Nothing here is subtle on its own; the
  // point is that a hundred consecutive rounds of phase changes and timers
  // still add up, and that a round nobody answers awards nothing.
  const records: RawSongRecord[] = [];
  for (let i = 0; i < 100; i += 1) {
    records.push({
      id: `s${i}`,
      artist: `가수${i}`,
      title: `곡${i}`,
      youtubeId: String(i).padStart(11, 'a'),
    });
  }
  const room = new GameRoom({ questions: songQuestions(buildSongCatalog(records).playable), now: 1_000 });
  const players = [join(room, '하나', 1_000), join(room, '둘', 1_001), join(room, '셋', 1_002)];

  let clock = 2_000;
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, clock);
  clock += COUNTDOWN_MS;
  room.tick(clock);

  let answered = 0;
  for (let i = 0; i < 100; i += 1) {
    assert.equal(room.getPhase(), 'IN_ROUND', `round ${i} should be live`);
    if (i % 7 === 0) {
      // Every seventh round goes unanswered and must be worth nothing.
      clock += YOUTUBE_CLIP_MS + ANSWER_GRACE_MS;
      room.tick(clock);
    } else {
      // One place, so the first correct answer closes the round.
      clock += 5_000;
      room.handleMessage({ type: 'SUBMIT_ANSWER', guess: `곡${i}` }, players[i % players.length]!.id, clock);
      assert.equal(room.getPhase(), 'REVEAL', `round ${i} should close on the first correct answer`);
      answered += 1;
    }
    clock += REVEAL_MS;
    room.tick(clock);
    if (room.getPhase() === 'COUNTDOWN') {
      clock += COUNTDOWN_MS;
      room.tick(clock);
    }
  }

  assert.equal(room.getPhase(), 'FINISHED');
  const total = players.reduce((sum, player) => sum + (room.getPlayer(player.id)?.score ?? 0), 0);
  assert.equal(total, answered, 'one point per answered round, and nothing for the rest');
  // 0..99 holds fifteen multiples of seven, so fifteen rounds go unanswered.
  assert.equal(answered, 85);
});

test('a YouTube round is judged and revealed like any other', () => {
  const room = youtubeRoom();
  joinHost(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_100);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'hype boy' }, guest.id, 5_000);
  assert.ok(firstOfType(privateMessagesFor(effects, guest.id), 'ANSWER_ACCEPTED'));

  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.answer.mode, 'song');
  assert.equal(reveal.answer.answer, 'Hype boy');
  assert.equal(reveal.song.title, 'Hype boy');
  assert.equal(reveal.winner?.playerId, guest.id);
});

// --- Proverb and idiom rounds ------------------------------------------------

test('a proverb round shows the prefix and nothing that answers it', () => {
  const room = textRoom('proverb', PROVERB_BANK);
  joinHost(room, '방장', 1_000);
  const effects = startFirstRound(room, 2_000);

  const start = firstOfType(broadcasts(effects), 'ROUND_START');
  assert.ok(start);
  const first = PROVERB_BANK[0];
  assert.ok(first !== undefined && first.mode === 'proverb');

  assert.equal(start.question.mode, 'proverb');
  assert.equal(start.question.index, 0);
  assert.equal(start.question.totalQuestions, QUESTIONS_PER_TEXT_GAME);
  assert.equal(start.question.clue, first.prefix);
  assert.equal(start.question.durationMs, TEXT_ROUND_MS);
  assert.equal(start.deadline - start.serverStartedAt, TEXT_ROUND_MS);

  // A text round has no media, and nothing on the wire answers the question.
  assert.equal(start.mediaUrl, '');
  assert.equal(start.livePlayback, false);
  const serialized = JSON.stringify(start);
  assert.equal(serialized.includes(first.suffix), false, 'the missing half must not ship');
  assert.equal(serialized.includes(first.full), false, 'the whole proverb must not ship');
  for (const alias of first.aliases) assert.equal(serialized.includes(alias), false);
});

test('an idiom round shows the meaning and nothing that answers it', () => {
  const room = textRoom('idiom', IDIOM_BANK);
  joinHost(room, '방장', 1_000);
  const effects = startFirstRound(room, 2_000);

  const start = firstOfType(broadcasts(effects), 'ROUND_START');
  assert.ok(start);
  const first = IDIOM_BANK[0];
  assert.ok(first !== undefined && first.mode === 'idiom');

  assert.equal(start.question.mode, 'idiom');
  assert.equal(start.question.clue, first.meaning);

  const serialized = JSON.stringify(start);
  assert.equal(serialized.includes(first.answer), false, 'the four syllables must not ship');
  assert.equal(serialized.includes(first.hanja ?? ' '), false, 'the Hanja must not ship either');
  for (const alias of first.aliases) assert.equal(serialized.includes(alias), false);
});

test('a reconnect mid-text-round restores the clue and the clock, not the answer', () => {
  const room = textRoom('proverb', PROVERB_BANK);
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    roundStart + 4_000,
  );
  const state = firstOfType(privateMessagesFor(effects, host.id), 'ROOM_STATE');
  assert.ok(state);

  const first = PROVERB_BANK[0];
  assert.ok(first !== undefined && first.mode === 'proverb');
  assert.equal(state.mode, 'proverb');
  assert.equal(state.totalQuestions, QUESTIONS_PER_TEXT_GAME);
  assert.equal(state.round?.question.clue, first.prefix);
  assert.equal(state.round?.deadline, roundStart + TEXT_ROUND_MS, 'the remaining time is the server’s');

  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes(first.suffix), false);
  assert.equal(serialized.includes(first.full), false);
});

test('a proverb accepts the whole saying and the missing half, and nothing else', () => {
  const room = textRoom('proverb', PROVERB_BANK);
  const a = join(room, '하나', 1_000);
  const b = join(room, '둘', 1_001);
  const c = join(room, '셋', 1_002);
  const d = join(room, '넷', 1_003);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 100;

  const first = PROVERB_BANK[0];
  assert.ok(first !== undefined && first.mode === 'proverb');

  // A near-miss is still a miss: matching is exact after normalization.
  const wrong = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: `${first.suffix}요` }, d.id, at);
  assert.ok(firstOfType(privateMessagesFor(wrong, d.id), 'ANSWER_REJECTED'));

  // Suffix only, whole proverb, and whole proverb with the spacing removed.
  const one = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: first.suffix }, a.id, at + 1);
  const two = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: first.full }, b.id, at + 2);
  const three = room.handleMessage(
    { type: 'SUBMIT_ANSWER', guess: first.full.replace(/\s+/gu, '') },
    c.id,
    at + 3,
  );

  assert.equal(firstOfType(privateMessagesFor(one, a.id), 'ANSWER_ACCEPTED')?.place, 1);
  assert.equal(firstOfType(privateMessagesFor(two, b.id), 'ANSWER_ACCEPTED')?.place, 2);
  assert.equal(firstOfType(privateMessagesFor(three, c.id), 'ANSWER_ACCEPTED')?.place, 3);

  const reveal = firstOfType(broadcasts(three), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.answer.mode, 'proverb');
  assert.equal(reveal.answer.answer, first.full);
  assert.equal(reveal.answer.detail, first.suffix, 'the reveal names the half players had to supply');
  assert.equal(reveal.answer.clue, first.prefix);
  assert.deepEqual(
    reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
    [
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  );
});

test('an idiom accepts the Hangul and the Hanja, but never its own clue', () => {
  const room = textRoom('idiom', IDIOM_BANK);
  const a = join(room, '하나', 1_000);
  const b = join(room, '둘', 1_001);
  const c = join(room, '셋', 1_002);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 100;

  const first = IDIOM_BANK[0];
  assert.ok(first !== undefined && first.mode === 'idiom' && first.hanja !== null);

  // Typing the meaning back is not an answer.
  const echo = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: first.meaning.slice(0, 40) }, c.id, at);
  assert.ok(firstOfType(privateMessagesFor(echo, c.id), 'ANSWER_REJECTED'));

  const hangul = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: ` ${first.answer} ` }, a.id, at + 1);
  const hanja = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: first.hanja }, b.id, at + 2);

  assert.equal(firstOfType(privateMessagesFor(hangul, a.id), 'ANSWER_ACCEPTED')?.place, 1);
  assert.equal(firstOfType(privateMessagesFor(hanja, b.id), 'ANSWER_ACCEPTED')?.place, 2);

  const reveal = firstOfType(broadcasts(closeRound(room, at + 3)), 'ROUND_REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.answer.mode, 'idiom');
  assert.equal(reveal.answer.answer, first.answer);
  assert.equal(reveal.answer.hanja, first.hanja);
  assert.equal(reveal.answer.detail, first.meaning);
});

test('a text round has no cue, even for the host', () => {
  const room = textRoom('idiom', IDIOM_BANK);
  const host = joinHost(room, '방장', 1_000);
  const effects = startFirstRound(room, 2_000);
  assert.equal(firstOfType(privateMessagesFor(effects, host.id), 'ROUND_CUE'), undefined);

  const rejoin = room.handleMessage(
    { type: 'REJOIN', roomId: room.roomId, playerToken: host.token },
    null,
    3_000,
  );
  assert.equal(firstOfType(privateMessagesFor(rejoin, host.id), 'ROUND_CUE'), undefined);
});

test('pause, resume and skip work the same in a text round', () => {
  const room = textRoom('proverb', PROVERB_BANK);
  const host = joinHost(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 3_000);
  assert.equal(room.getTimer(), null, 'the deadline timer stops while paused');
  assert.deepEqual(
    room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'anything' }, host.id, roundStart + 4_000),
    [],
    'guesses are ignored while paused',
  );

  const resumed = firstOfType(
    broadcasts(room.handleMessage({ type: 'HOST_RESUME', hostToken: room.hostToken }, null, roundStart + 8_000)),
    'ROUND_RESUMED',
  );
  assert.equal(resumed?.newDeadline, roundStart + TEXT_ROUND_MS + 5_000, 'the 5s pause shifts the deadline by 5s');

  const reveal = firstOfType(broadcasts(closeRound(room, roundStart + 9_000)), 'ROUND_REVEAL');
  assert.ok(reveal, 'skip reveals a text round too');
  assert.equal(reveal.winner, null);
});

/** Plays a whole text game, answering the rounds `answer` says to. */
function playTextGame(
  room: GameRoom,
  players: { id: PlayerId }[],
  bank: readonly Question[],
  answerRound: (index: number) => boolean,
): { clock: number; answered: number; lastReveal: number } {
  let clock = 2_000;
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, clock);
  clock += COUNTDOWN_MS;
  room.tick(clock);

  let answered = 0;
  let lastReveal = 0;
  for (let i = 0; i < bank.length; i += 1) {
    assert.equal(room.getPhase(), 'IN_ROUND', `question ${i} should be live`);
    const question = bank[i];
    assert.ok(question !== undefined && question.mode !== 'song');

    if (answerRound(i)) {
      // Three scorers, which closes the round without waiting for the clock.
      for (const [offset, player] of players.slice(0, 3).entries()) {
        clock += 500;
        room.handleMessage(
          { type: 'SUBMIT_ANSWER', guess: question.aliases[0] as string },
          player.id,
          clock,
        );
        void offset;
      }
      answered += 1;
    } else {
      clock += TEXT_ROUND_MS;
      room.tick(clock);
    }
    assert.equal(room.getPhase(), 'REVEAL', `question ${i} should have revealed`);
    lastReveal = i;

    clock += REVEAL_MS;
    room.tick(clock);
    if (room.getPhase() === 'COUNTDOWN') {
      clock += COUNTDOWN_MS;
      room.tick(clock);
    }
  }
  return { clock, answered, lastReveal };
}

for (const [mode, bank] of [
  ['proverb', PROVERB_BANK],
  ['idiom', IDIOM_BANK],
] as const) {
  test(`a ${mode} game plays all ${QUESTIONS_PER_TEXT_GAME} questions once and then finishes`, () => {
    const questions = textGame(bank);
    const room = new GameRoom({ questions, now: 1_000 });
    const players = [join(room, '하나', 1_000), join(room, '둘', 1_001), join(room, '셋', 1_002)];

    // Every fifth question goes unanswered, so both the three-scorer path and
    // the deadline path are exercised inside one game.
    const { answered } = playTextGame(room, players, questions, (index) => index % 5 !== 0);

    assert.equal(room.getPhase(), 'FINISHED');
    assert.equal(answered, QUESTIONS_PER_TEXT_GAME - 6, '30 questions, six of them unanswered');

    // Three scorers a round, one point each.
    const total = players.reduce((sum, player) => sum + (room.getPlayer(player.id)?.score ?? 0), 0);
    assert.equal(total, answered * scorersPerRound(mode));

    // Every player is ranked at the end, whatever they scored.
    const ranks = players.map((player) => room.getPlayer(player.id));
    assert.equal(ranks.every((player) => player !== null), true);
  });
}

for (const [mode, bank] of [
  ['proverb', PROVERB_BANK],
  ['idiom', IDIOM_BANK],
] as const) {
  test(`${mode}: across a whole game, no answer is ever sent before its own reveal`, () => {
    // The broadest form of the rule, and the one that would catch a field
    // added to a payload years from now: play every round of a real game and
    // check every effect the engine produced during it against that question's
    // own accepted answers.
    //
    // Scoped to the round on purpose. A one-syllable answer like 그림의 "떡"
    // does occur inside another question's clue (남의 "떡"이 커 보인다), and
    // that is not a leak — nobody is being asked 그림의 떡 at the time, and
    // the clue tells them nothing about it. Only the answer to the question in
    // front of the player matters.
    const questions = textGame(bank);
    const room = new GameRoom({ questions, now: 1_000 });
    const players = [join(room, '하나', 1_000), join(room, '둘', 1_001), join(room, '셋', 1_002)];

    /** Everything this question's answer must not appear in. */
    let openRound: string[] = [];
    let revealed: string[] = [];
    const collect = (effects: Effect[]): void => {
      for (const effect of effects) {
        if (effect.kind === 'disconnect') continue;
        const json = JSON.stringify(effect.message);
        if (effect.message.type === 'ROUND_REVEAL') revealed.push(json);
        else openRound.push(json);
      }
    };

    /** Everything a guess is judged against, plus the raw fields behind them. */
    const secretsOf = (question: Question): string[] => {
      const secrets = [...question.aliases];
      if (question.mode === 'proverb') secrets.push(question.full, question.suffix);
      if (question.mode === 'idiom') {
        secrets.push(question.answer);
        if (question.hanja !== null) secrets.push(question.hanja);
      }
      return secrets;
    };

    let clock = 2_000;
    collect(room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, clock));
    clock += COUNTDOWN_MS;
    collect(room.tick(clock));

    let sweptMessages = 0;
    for (const [index, question] of questions.entries()) {
      assert.equal(room.getPhase(), 'IN_ROUND');
      assert.notEqual(question.mode, 'song');

      // A rejoin mid-round is the other path a snapshot can leak through.
      collect(
        room.handleMessage(
          { type: 'REJOIN', roomId: room.roomId, playerToken: players[0]!.token },
          null,
          clock + 10,
        ),
      );
      // A wrong guess, and a right one, both before the round resolves.
      collect(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '틀린답' }, players[1]!.id, clock + 20));
      if (index % 3 !== 0) {
        collect(
          room.handleMessage(
            { type: 'SUBMIT_ANSWER', guess: question.aliases[0] as string },
            players[2]!.id,
            clock + 30,
          ),
        );
      }

      clock += TEXT_ROUND_MS;
      collect(room.tick(clock));

      // Everything sent while this question was on screen, checked against
      // this question's answers.
      const secrets = secretsOf(question);
      assert.ok(openRound.length >= 3, `round ${index} produced no traffic to sweep`);
      for (const message of openRound) {
        for (const secret of secrets) {
          assert.equal(message.includes(secret), false, `round ${index}: "${secret}" was sent before the reveal`);
        }
      }
      // And the reveal does carry it, or the game would never show an answer.
      assert.equal(revealed.length, 1, `round ${index} should reveal exactly once`);
      assert.ok(
        secrets.some((secret) => (revealed[0] as string).includes(secret)),
        `round ${index}: the reveal is supposed to name the answer`,
      );

      sweptMessages += openRound.length;
      openRound = [];
      revealed = [];

      clock += REVEAL_MS;
      collect(room.tick(clock));
      if (room.getPhase() === 'COUNTDOWN') {
        clock += COUNTDOWN_MS;
        collect(room.tick(clock));
      }
      // COUNTDOWN_STARTED and the next ROUND_START land in the next round's
      // bucket, which is where they belong.
    }

    assert.equal(room.getPhase(), 'FINISHED');
    assert.ok(sweptMessages > questions.length * 3, 'the sweep has to have covered real traffic');
  });
}

test('every question in a text game is a different one', () => {
  // The shuffle must reorder the bank, never resample it: thirty questions and
  // thirty distinct clues, or somebody gets the same proverb twice.
  const room = textRoom('proverb', PROVERB_BANK);
  joinHost(room, '방장', 1_000);

  const clues: string[] = [];
  let gameOvers = 0;
  let clock = 2_000;
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, clock);
  clock += COUNTDOWN_MS;

  for (let i = 0; i < QUESTIONS_PER_TEXT_GAME; i += 1) {
    const start = firstOfType(broadcasts(room.tick(clock)), 'ROUND_START');
    assert.ok(start, `question ${i} should have started`);
    assert.equal(start.question.index, i);
    clues.push(start.question.clue ?? '');

    clock += TEXT_ROUND_MS;
    room.tick(clock);
    clock += REVEAL_MS;
    // The reveal timer after the last question ends the game rather than
    // starting another countdown, so GAME_OVER is counted here.
    gameOvers += broadcasts(room.tick(clock)).filter((m) => m.type === 'GAME_OVER').length;
    clock += COUNTDOWN_MS;
  }

  assert.equal(new Set(clues).size, QUESTIONS_PER_TEXT_GAME, 'thirty distinct questions, none repeated');
  assert.equal(gameOvers, 1);
  assert.equal(room.getPhase(), 'FINISHED');
  assert.deepEqual(room.tick(clock + 60_000), [], 'FINISHED is terminal');
});
