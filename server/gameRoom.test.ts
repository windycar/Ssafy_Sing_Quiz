import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameRoom,
  sanitizeNickname,
  ANSWER_GRACE_MS,
  COUNTDOWN_MS,
  REVEAL_MS,
  POINTS_PER_WIN,
  MAX_GUESSES_PER_ROUND,
  MAX_PLAYERS,
} from './gameRoom.ts';
import type { Effect, ServerMessage, PlayerId } from './protocol.ts';
import { parseClientMessage } from './protocol.ts';
import { buildSongCatalog } from '../shared/songCatalog.ts';
import type { SongConfig } from '../shared/songCatalog.ts';

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
function join(room: GameRoom, nickname: string, now: number): { id: PlayerId; token: string } {
  const effects = room.handleMessage({ type: 'JOIN_ROOM', roomId: room.roomId, nickname }, null, now);
  const state = firstOfType(
    effects.filter((e): e is Extract<Effect, { kind: 'send' }> => e.kind === 'send').map((e) => e.message),
    'ROOM_STATE',
  );
  assert.ok(state, `join failed for ${nickname}`);
  return { id: state.playerId, token: state.playerToken };
}

/** Starts the game and runs the countdown so the first round is live. */
function startFirstRound(room: GameRoom, now: number): Effect[] {
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, now);
  return room.tick(now + COUNTDOWN_MS);
}

function newRoom(now = 1_000): GameRoom {
  return new GameRoom({ songs: SONGS, now });
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

test('the first player to join becomes the host', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
  const guest = join(room, '참가자', 1_001);
  const hostState = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: host.token }, null, 1_002);
  const guestState = room.handleMessage({ type: 'REJOIN', roomId: room.roomId, playerToken: guest.token }, null, 1_003);
  assert.equal(firstOfType(privateMessagesFor(hostState, host.id), 'ROOM_STATE')?.isHost, true);
  assert.equal(firstOfType(privateMessagesFor(guestState, guest.id), 'ROOM_STATE')?.isHost, false);
});

test('joining after the game has started is refused', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
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
  const room = new GameRoom({ songs: [], now: 1_000 });
  join(room, '방장', 1_000);
  const effects = room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 2_000);
  assert.equal(errorReasonOf(effects), 'NOT_ENOUGH_PLAYERS');
  assert.equal(room.getPhase(), 'LOBBY');
});

test('phase advances LOBBY -> COUNTDOWN -> IN_ROUND on the server timer', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
  const effects = room.handleMessage({ type: 'HOST_START', hostToken: 'guessed-token' }, host.id, 2_000);
  assert.equal(errorReasonOf(effects), 'NOT_HOST');
  assert.equal(room.getPhase(), 'LOBBY');
});

test('host actions outside their valid phase return an explicit error', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
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
  join(room, '방장', 1_000);
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

// --- First correct answer ---------------------------------------------------

test('a correct answer wins the round and awards points', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 500;

  const effects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '다이나 마이트!' }, host.id, at);
  assert.equal(firstOfType(privateMessagesFor(effects, host.id), 'ANSWER_ACCEPTED')?.pointsAwarded, POINTS_PER_WIN);

  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.equal(reveal?.song.title, 'Dynamite');
  assert.equal(reveal?.winner?.playerId, host.id);
  assert.equal(room.getPhase(), 'REVEAL');
  assert.equal(room.getPlayer(host.id)?.score, POINTS_PER_WIN);
});

test('only the first correct answer wins, even one microsecond later', () => {
  const room = newRoom();
  const fast = join(room, '빠름', 1_000);
  const slow = join(room, '느림', 1_001);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 100;

  const firstEffects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, fast.id, at);
  // Same server timestamp: the tie must still be broken by processing order.
  const secondEffects = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, slow.id, at);

  assert.ok(firstOfType(privateMessagesFor(firstEffects, fast.id), 'ANSWER_ACCEPTED'));
  assert.equal(firstOfType(privateMessagesFor(secondEffects, slow.id), 'ANSWER_ACCEPTED'), undefined);
  assert.equal(room.getPlayer(fast.id)?.score, POINTS_PER_WIN);
  assert.equal(room.getPlayer(slow.id)?.score, 0);
  // Exactly one reveal was emitted.
  assert.equal(broadcasts(secondEffects).filter((m) => m.type === 'ROUND_REVEAL').length, 0);
});

test('a late correct answer is told only that it was late, never that it was right', () => {
  const room = newRoom();
  const fast = join(room, '빠름', 1_000);
  const slow = join(room, '느림', 1_001);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 100;

  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, fast.id, at);
  const late = room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, slow.id, at + 1);

  const messages = privateMessagesFor(late, slow.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'ANSWER_TOO_LATE');
  assert.equal(JSON.stringify(messages[0]).includes('Dynamite'), false);
});

test('a wrong answer is private to the guesser', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
  room.handleMessage({ type: 'HOST_START', hostToken: room.hostToken }, null, 2_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, 2_100), []);
});

test('a timeout reveals the answer with no winner', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.tick(2_000 + COUNTDOWN_MS + ROUND_MS);
  const reveal = firstOfType(broadcasts(effects), 'ROUND_REVEAL');
  assert.equal(reveal?.winner, null);
  assert.equal(reveal?.song.title, 'Dynamite');
  assert.equal(room.getPhase(), 'REVEAL');
});

// --- Pause and resume -------------------------------------------------------

test('pause and resume preserve the remaining answer time exactly', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  room.handleMessage({ type: 'HOST_PAUSE', hostToken: room.hostToken }, null, roundStart + 1_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, roundStart + 2_000), []);
  assert.equal(room.getPlayer(host.id)?.score, 0);
});

test('the host disconnecting mid-round freezes the timer', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const roundStart = 2_000 + COUNTDOWN_MS;

  const effects = room.handleDisconnect(host.id, roundStart + 1_000);
  assert.ok(firstOfType(broadcasts(effects), 'ROUND_PAUSED'));
  assert.equal(room.getTimer(), null);
});

test('skipping ends the round with no winner', () => {
  const room = newRoom();
  join(room, '방장', 1_000);
  startFirstRound(room, 2_000);

  const effects = room.handleMessage(
    { type: 'HOST_SKIP', hostToken: room.hostToken },
    null,
    2_000 + COUNTDOWN_MS + 500,
  );
  assert.equal(firstOfType(broadcasts(effects), 'ROUND_REVEAL')?.winner, null);
});

test('skip cannot steal a round that was already won', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const at = 2_000 + COUNTDOWN_MS + 200;

  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, at);
  const skip = room.handleMessage({ type: 'HOST_SKIP', hostToken: room.hostToken }, null, at + 1);
  assert.equal(
    skip.some((e) => e.kind === 'broadcast' && e.message.type === 'ROUND_REVEAL'),
    false,
    'a resolved round must not reveal twice',
  );
  assert.equal(room.getPlayer(host.id)?.score, POINTS_PER_WIN);
});

// --- Round progression ------------------------------------------------------

test('the game runs every song and then finishes', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
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

  // Round 2 is won.
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: '피노키오' }, host.id, clock + 100);
  clock += REVEAL_MS + 100;
  const over = room.tick(clock);
  assert.equal(room.getPhase(), 'FINISHED');
  const gameOver = firstOfType(broadcasts(over), 'GAME_OVER');
  assert.equal(gameOver?.finalRanks.length, 1);
  assert.equal(gameOver?.finalRanks[0].score, POINTS_PER_WIN);
});

test('the expanded alias from the catalog is accepted by the server', () => {
  // "피노키오" is not in the source aliases; it comes from title expansion.
  const room = newRoom();
  const host = join(room, '방장', 1_000);
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
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, a.id, 2_000 + COUNTDOWN_MS + 10);
  let clock = 2_000 + COUNTDOWN_MS + 10 + REVEAL_MS;
  room.tick(clock);
  clock += COUNTDOWN_MS;
  room.tick(clock);
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
  const effects = room.handleMessage(
    { type: 'SUBMIT_ANSWER', guess: 'Dynamite' },
    players[6].id,
    2_000 + COUNTDOWN_MS + 10,
  );

  const updates = effects.filter((e) => e.kind === 'send' && e.message.type === 'LEADERBOARD_UPDATE');
  assert.equal(updates.length, 7, 'every player gets one update');

  for (const player of players) {
    const update = firstOfType(privateMessagesFor(effects, player.id), 'LEADERBOARD_UPDATE');
    assert.ok(update, `no update for ${player.id}`);
    assert.equal(update.topFive.length, 5);
    assert.equal(update.you.playerId, player.id);
  }
  const winnerUpdate = firstOfType(privateMessagesFor(effects, players[6].id), 'LEADERBOARD_UPDATE');
  assert.equal(winnerUpdate?.you.rank, 1);
});

// --- Reconnect --------------------------------------------------------------

test('a disconnect keeps the score and roster slot', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  room.handleMessage({ type: 'SUBMIT_ANSWER', guess: 'Dynamite' }, host.id, 2_000 + COUNTDOWN_MS + 10);

  const effects = room.handleDisconnect(host.id, 2_000 + COUNTDOWN_MS + 20);
  assert.equal(firstOfType(broadcasts(effects), 'PLAYER_CONNECTION_CHANGED')?.connected, false);
  assert.equal(room.getPlayer(host.id)?.score, POINTS_PER_WIN);
  assert.equal(room.getPlayer(host.id)?.connected, false);
});

test('rejoining restores a full snapshot including the live deadline', () => {
  const room = newRoom();
  const host = join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
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
  const host = join(room, '방장', 1_000);
  startFirstRound(room, 2_000);
  const huge = 'x'.repeat(5_000);
  assert.deepEqual(room.handleMessage({ type: 'SUBMIT_ANSWER', guess: huge }, host.id, 2_000 + COUNTDOWN_MS + 5), []);
});

test('messages from a connection that never joined are refused', () => {
  const room = newRoom();
  const effects = room.handleMessage({ type: 'SET_READY', ready: true }, null, 1_000);
  assert.equal(errorReasonOf(effects), 'NOT_JOINED');
});
