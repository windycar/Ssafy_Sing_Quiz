/**
 * Tests for the browser-side protocol.
 *
 * Three layers, cheapest first:
 *
 * 1. `applyServerMessage` is a pure function, so every transition is tested by
 *    calling it — no socket, no timers, no DOM.
 * 2. Connection behaviour (join vs. rejoin, backoff, giving up) runs against a
 *    fake socket with an injected clock and scheduler, so retries are asserted
 *    rather than waited for.
 * 3. One full game runs against the real server over real WebSockets, through
 *    the same module the browser loads. That is the test that would catch the
 *    client and server drifting apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ProtocolClient, applyServerMessage, initialState, remainingInSection } from './protocolClient.ts';
import type { ClientState, ProtocolSocket, SocketMessageEvent } from './protocolClient.ts';
import { startServer } from '../server/index.ts';
import type { ClientMessage, PlayerSummary, ServerMessage } from '../server/protocol.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';

const roundStart: ServerMessage = {
  type: 'ROUND_START',
  question: { mode: 'song', index: 0, totalQuestions: 3, durationMs: 20_000, clue: null },
  song: { index: 0, totalSongs: 3, clipDurationMs: 10_000 },
  mediaUrl: 'https://media.invalid/clip',
  clipStartMs: 30_000,
  clipEndMs: 40_000,
  livePlayback: false,
  serverStartedAt: 1_000,
  deadline: 21_000,
};

/** A proverb round: the prefix is on the wire, the rest of the saying is not. */
const proverbStart: ServerMessage = {
  type: 'ROUND_START',
  question: {
    mode: 'proverb',
    index: 4,
    totalQuestions: 30,
    durationMs: 60_000,
    clue: '가는 말이 고와야',
  },
  song: { index: 4, totalSongs: 30, clipDurationMs: 60_000 },
  mediaUrl: '',
  clipStartMs: 0,
  clipEndMs: 0,
  livePlayback: false,
  serverStartedAt: 1_000,
  deadline: 61_000,
};

function player(id: string, overrides: Partial<PlayerSummary> = {}): PlayerSummary {
  return { id, nickname: id, connected: true, ready: false, score: 0, ...overrides };
}

function reduce(messages: readonly ServerMessage[], receivedAt = 1_000): ClientState {
  return messages.reduce((state, message) => applyServerMessage(state, message, receivedAt), initialState('ROOM'));
}

// --- Pure reducer -----------------------------------------------------------

test('ROUND_START carries a clip but never an answer', () => {
  const state = reduce([roundStart]);

  assert.equal(state.phase, 'IN_ROUND');
  assert.equal(state.mode, 'song');
  assert.equal(state.round?.question.clue, null, 'a song round has no text clue');
  assert.equal(state.round?.mediaUrl, 'https://media.invalid/clip');
  assert.equal(state.reveal, null, 'nothing about the song is known before REVEAL');
  assert.equal(state.answeredThisRound, false);
  // The message type itself has no field that could hold one.
  assert.equal(Object.keys(roundStart).includes('title'), false);
});

test('a text ROUND_START carries the clue, the progress, and nothing else', () => {
  const state = reduce([proverbStart]);

  assert.equal(state.phase, 'IN_ROUND');
  assert.equal(state.mode, 'proverb', 'the mode is taken from the round, not guessed');
  assert.equal(state.totalQuestions, 30);
  assert.equal(state.round?.question.clue, '가는 말이 고와야');
  assert.equal(state.round?.question.index, 4, 'the client renders 5 / 30 from this');
  assert.equal(state.round?.deadline, 61_000, 'a text round is a minute');

  // No media to play, in either of the two ways a client might try.
  assert.equal(state.round?.mediaUrl, '');
  assert.equal(state.round?.livePlayback, false);
  assert.equal(state.round?.cue, null);
  assert.equal(state.reveal, null);

  // And nothing that answers it. There is no field on the message that could
  // hold the missing half.
  assert.equal(JSON.stringify(state).includes('오는 말이 곱다'), false);
});

test('the clock offset keeps the fastest sample rather than the latest', () => {
  // Received 200 ms after the server sent it: offset measures 800.
  let state = applyServerMessage(initialState('ROOM'), roundStart, 200);
  assert.equal(state.clockOffsetMs, 800);

  // A later, slower sample must not drag the estimate down.
  state = applyServerMessage(state, { type: 'ROUND_PAUSED', pausedAt: 5_000 }, 4_500);
  assert.equal(state.clockOffsetMs, 800);

  // A faster one replaces it.
  state = applyServerMessage(state, { type: 'ROUND_PAUSED', pausedAt: 9_000 }, 8_100);
  assert.equal(state.clockOffsetMs, 900);
});

test('a pause says whether it is the host taking a break or the host dropping out', () => {
  const chosen = reduce([roundStart, { type: 'ROUND_PAUSED', pausedAt: 5_000 }]);
  assert.equal(chosen.round?.paused, true);
  assert.equal(chosen.round?.hostAway, false, 'an older server sends neither field; that is a plain pause');
  assert.equal(chosen.round?.hostGraceEndsAt, null);

  const outage = reduce([
    roundStart,
    { type: 'ROUND_PAUSED', pausedAt: 5_000, hostAway: true, hostGraceEndsAt: 65_000 },
  ]);
  assert.equal(outage.round?.hostAway, true);
  assert.equal(outage.round?.hostGraceEndsAt, 65_000, 'so a screen can count the wait down instead of just freezing');

  // Whatever stopped the round, resuming clears the outage with it.
  const resumed = applyServerMessage(outage, { type: 'ROUND_RESUMED', newDeadline: 90_000 }, 65_000);
  assert.equal(resumed.round?.hostAway, false);
  assert.equal(resumed.round?.hostGraceEndsAt, null);
});

test('answer feedback is private and a late guess carries no verdict', () => {
  assert.deepEqual(reduce([roundStart, { type: 'ANSWER_REJECTED', guess: '틀린답' }]).answerFeedback, {
    kind: 'rejected',
    guess: '틀린답',
  });

  assert.deepEqual(
    reduce([roundStart, { type: 'ANSWER_ACCEPTED', pointsAwarded: 1, place: 1 }]).answerFeedback,
    { kind: 'accepted', pointsAwarded: 1, place: 1 },
  );

  // The reducer reports whatever the server awarded rather than assuming the
  // current one-point rule, so a scoring change needs no client release.
  assert.deepEqual(
    reduce([roundStart, { type: 'ANSWER_ACCEPTED', pointsAwarded: 50, place: 2 }]).answerFeedback,
    { kind: 'accepted', pointsAwarded: 50, place: 2 },
  );

  // Crucially there is no "you were right but slow" state to render.
  assert.deepEqual(reduce([roundStart, { type: 'ANSWER_TOO_LATE' }]).answerFeedback, { kind: 'tooLate' });
  assert.equal(reduce([roundStart, { type: 'ANSWER_TOO_LATE' }]).answeredThisRound, true);
});

test('ROUND_REVEAL is the first message that names the song, and it syncs scores', () => {
  const state = reduce([
    { type: 'PLAYER_JOINED', player: player('p1') },
    { type: 'PLAYER_JOINED', player: player('p2') },
    roundStart,
    {
      type: 'ROUND_REVEAL',
      answer: {
        mode: 'song',
        answer: '좋은 날',
        artist: '아이유',
        detail: null,
        clue: null,
        hanja: null,
        explanation: null,
      },
      song: { title: '좋은 날', artist: '아이유' },
      winner: { playerId: 'p1', nickname: 'p1' },
      scorers: [{ playerId: 'p1', nickname: 'p1', place: 1, pointsAwarded: 100 }],
      leaderboard: [
        { playerId: 'p1', nickname: 'p1', score: 100, rank: 1 },
        { playerId: 'p2', nickname: 'p2', score: 0, rank: 2 },
      ],
    },
  ]);

  assert.equal(state.phase, 'REVEAL');
  assert.equal(state.reveal?.answer.answer, '좋은 날');
  assert.equal(state.reveal?.answer.artist, '아이유');
  assert.equal(state.reveal?.winner?.playerId, 'p1');
  // The roster and the leaderboard must not disagree about a score.
  assert.equal(state.players.find((entry) => entry.id === 'p1')?.score, 100);
});

test('a text ROUND_REVEAL carries every part a client has to draw', () => {
  const state = reduce([
    { type: 'PLAYER_JOINED', player: player('p1') },
    { type: 'PLAYER_JOINED', player: player('p2') },
    { type: 'PLAYER_JOINED', player: player('p3') },
    proverbStart,
    {
      type: 'ROUND_REVEAL',
      answer: {
        mode: 'proverb',
        answer: '가는 말이 고와야 오는 말이 곱다',
        artist: null,
        detail: '오는 말이 곱다',
        clue: '가는 말이 고와야',
        hanja: null,
        explanation: '내가 좋게 말해야 상대도 좋게 대한다.',
      },
      song: { title: '가는 말이 고와야 오는 말이 곱다', artist: '' },
      winner: { playerId: 'p1', nickname: 'p1' },
      // Three scorers, in the order the server received them. The point values
      // here are deliberately *not* the ones the server currently awards: the
      // client has to render whatever it is told, so a fixture that matched
      // `POINTS_BY_PLACE` would pass even if this file hardcoded them.
      scorers: [
        { playerId: 'p1', nickname: 'p1', place: 1, pointsAwarded: 100 },
        { playerId: 'p2', nickname: 'p2', place: 2, pointsAwarded: 50 },
        { playerId: 'p3', nickname: 'p3', place: 3, pointsAwarded: 30 },
      ],
      leaderboard: [
        { playerId: 'p1', nickname: 'p1', score: 100, rank: 1 },
        { playerId: 'p2', nickname: 'p2', score: 50, rank: 2 },
        { playerId: 'p3', nickname: 'p3', score: 30, rank: 3 },
      ],
    },
  ]);

  assert.equal(state.phase, 'REVEAL');
  // The prefix and the suffix arrive separately, which is what lets a UI show
  // which half players actually had to supply.
  assert.equal(state.reveal?.answer.clue, '가는 말이 고와야');
  assert.equal(state.reveal?.answer.detail, '오는 말이 곱다');
  assert.equal(state.reveal?.answer.answer, '가는 말이 고와야 오는 말이 곱다');
  assert.equal(state.reveal?.answer.explanation, '내가 좋게 말해야 상대도 좋게 대한다.');

  assert.deepEqual(
    state.reveal?.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
    [
      [1, 100],
      [2, 50],
      [3, 30],
    ],
  );
  assert.deepEqual(
    state.players.map((entry) => entry.score),
    [100, 50, 30],
  );
});

test('an idiom reveal carries the Hanja and the meaning', () => {
  const state = reduce([
    {
      type: 'ROUND_REVEAL',
      answer: {
        mode: 'idiom',
        answer: '고진감래',
        artist: null,
        detail: '힘든 시기가 지나면 좋은 날이 옴',
        clue: null,
        hanja: '苦盡甘來',
        explanation: null,
      },
      song: { title: '고진감래', artist: '' },
      winner: null,
      scorers: [],
      leaderboard: [],
    },
  ]);

  assert.equal(state.reveal?.answer.hanja, '苦盡甘來');
  assert.equal(state.reveal?.answer.detail, '힘든 시기가 지나면 좋은 날이 옴');
  assert.deepEqual(state.reveal?.scorers, [], 'a round nobody got has no scorers to draw');
});

test('LEADERBOARD_UPDATE sets this player standing without replacing the board', () => {
  const state = reduce([
    {
      type: 'ROUND_REVEAL',
      answer: { mode: 'song', answer: 't', artist: 'a', detail: null, clue: null, hanja: null, explanation: null },
      song: { title: 't', artist: 'a' },
      winner: null,
      scorers: [],
      leaderboard: [{ playerId: 'p1', nickname: 'p1', score: 100, rank: 1 }],
    },
    {
      type: 'LEADERBOARD_UPDATE',
      topFive: [{ playerId: 'p1', nickname: 'p1', score: 100, rank: 1 }],
      you: { playerId: 'p9', nickname: 'me', score: 0, rank: 7 },
    },
  ]);

  assert.equal(state.you?.rank, 7, 'a player outside the top five still sees their own rank');
  assert.equal(state.leaderboard.length, 1);
});

test('roster messages add, remove, and patch players', () => {
  let state = reduce([
    { type: 'PLAYER_JOINED', player: player('p1') },
    { type: 'PLAYER_JOINED', player: player('p2') },
    { type: 'PLAYER_JOINED', player: player('p1') },
  ]);
  assert.equal(state.players.length, 2, 'a duplicate join is ignored');

  state = applyServerMessage(state, { type: 'PLAYER_READY_CHANGED', playerId: 'p2', ready: true }, 0);
  state = applyServerMessage(state, { type: 'PLAYER_CONNECTION_CHANGED', playerId: 'p1', connected: false }, 0);
  assert.equal(state.players.find((entry) => entry.id === 'p2')?.ready, true);
  assert.equal(state.players.find((entry) => entry.id === 'p1')?.connected, false);

  state = applyServerMessage(state, { type: 'PLAYER_LEFT', playerId: 'p1' }, 0);
  assert.deepEqual(state.players.map((entry) => entry.id), ['p2']);
});

test('a ROOM_STATE snapshot restores a round already in progress', () => {
  const state = reduce([
    {
      type: 'ROOM_STATE',
      phase: 'IN_ROUND',
      mode: 'song',
      sections: [{ mode: 'song', count: 3 }],
      totalQuestions: 3,
      players: [player('p1')],
      isHost: true,
      playerToken: 'token',
      playerId: 'p1',
      leaderboard: [{ playerId: 'p1', nickname: 'p1', score: 100, rank: 1 }],
      answeredThisRound: true,
      round: {
        question: { mode: 'song', index: 1, totalQuestions: 3, durationMs: 20_000, clue: null },
        song: { index: 1, totalSongs: 3, clipDurationMs: 10_000 },
        mediaUrl: 'https://media.invalid/clip',
        clipStartMs: 0,
        clipEndMs: 10_000,
        serverStartedAt: 1_000,
        deadline: 21_000,
        paused: false,
        pausedAt: null,
        hostAway: false,
        hostGraceEndsAt: null,
        livePlayback: false,
        hint: null,
        scorers: [],
      },
    },
  ]);

  assert.equal(state.status, 'joined');
  assert.equal(state.isHost, true);
  assert.equal(state.round?.deadline, 21_000);
  assert.equal(state.answeredThisRound, true, 'the client must not re-prompt for a settled guess');
  assert.equal(state.you?.score, 100);
});

test('GAME_OVER ends the round and publishes the final ranks', () => {
  const state = reduce([
    roundStart,
    { type: 'GAME_OVER', finalRanks: [{ playerId: 'p1', nickname: 'p1', score: 300, rank: 1 }] },
  ]);
  assert.equal(state.phase, 'FINISHED');
  assert.equal(state.round, null);
  assert.equal(state.finalRanks?.[0]?.score, 300);
});

// --- Connection behaviour ---------------------------------------------------

class FakeSocket {
  readonly sent: ClientMessage[] = [];
  closed = false;
  private opened = false;
  private strict = false;
  private readonly handlers = new Map<string, ((event?: unknown) => void)[]>();

  /** Mimics a real WebSocket, which throws from send() while CONNECTING. */
  throwUntilOpen(): void {
    this.strict = true;
  }

  send(data: string): void {
    if (this.strict && !this.opened) {
      const error = new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
      error.name = 'InvalidStateError';
      throw error;
    }
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
  }

  addEventListener(type: string, listener: (event?: never) => void): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(listener as (event?: unknown) => void);
    this.handlers.set(type, existing);
  }

  open(): void {
    this.opened = true;
    this.fire('open');
  }

  deliver(message: ServerMessage): void {
    this.fire('message', { data: JSON.stringify(message) } satisfies SocketMessageEvent);
  }

  /** Forgets what has been sent, so an assertion can start from a clean slate. */
  reset(): void {
    this.sent.length = 0;
  }

  private fire(type: string, event?: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

/** A client wired to one socket the test controls directly. */
function clientOn(socket: FakeSocket, overrides: { now?: () => number; hostToken?: string | null } = {}): ProtocolClient {
  return new ProtocolClient({
    url: 'ws://test.invalid/ws',
    roomId: 'ROOM',
    nickname: '테스터',
    hostToken: overrides.hostToken ?? null,
    now: overrides.now,
    socketFactory: () => socket as unknown as ProtocolSocket,
    reconnect: false,
  });
}

test('a pause freezes the answer window and a resume adopts the server deadline', () => {
  let clock = 1_000;
  const socket = new FakeSocket();
  const client = clientOn(socket, { now: () => clock });

  client.connect();
  socket.open();
  socket.deliver(roundStart);
  assert.equal(client.remainingMs(), 20_000);

  clock = 6_000;
  assert.equal(client.remainingMs(), 15_000);

  socket.deliver({ type: 'ROUND_PAUSED', pausedAt: 6_000 });
  clock = 60_000; // A long pause must not drain a timer the server has stopped.
  assert.equal(client.remainingMs(), 15_000);

  // The server extended the deadline by the paused duration; the client adopts
  // that number and never computes its own.
  socket.deliver({ type: 'ROUND_RESUMED', newDeadline: 75_000 });
  assert.equal(client.getState().round?.paused, false);
  assert.equal(client.remainingMs(), 15_000);
});

function harness(options: { playerToken?: string | null; hostToken?: string | null } = {}): {
  client: ProtocolClient;
  sockets: FakeSocket[];
  pending: { run(): void; delays: number[] };
  tokens: string[];
} {
  const sockets: FakeSocket[] = [];
  const queued: (() => void)[] = [];
  const delays: number[] = [];
  const tokens: string[] = [];

  const client = new ProtocolClient({
    url: 'ws://test.invalid/ws',
    roomId: 'ROOM',
    nickname: '테스터',
    playerToken: options.playerToken ?? null,
    hostToken: options.hostToken === undefined ? 'HOSTSECRET' : options.hostToken,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as ProtocolSocket;
    },
    schedule: (callback, delay) => {
      delays.push(delay);
      queued.push(callback);
    },
    onToken: (token) => tokens.push(token),
  });

  return {
    client,
    sockets,
    tokens,
    pending: {
      run: () => {
        const next = queued.shift();
        next?.();
      },
      delays,
    },
  };
}

const snapshot = (token: string): ServerMessage => ({
  type: 'ROOM_STATE',
  phase: 'LOBBY',
  mode: 'song',
  sections: [],
  totalQuestions: 0,
  players: [],
  isHost: true,
  playerToken: token,
  playerId: 'p1',
  leaderboard: [],
});

test('a first connection joins by nickname and a reconnection rejoins by token', () => {
  const { client, sockets, pending, tokens } = harness();

  client.connect();
  sockets[0]?.open();
  // The host token rides along: the server seats the host from it rather than
  // from join order, so holding it back would leave the room hostless.
  assert.deepEqual(sockets[0]?.sent[0], {
    type: 'JOIN_ROOM',
    roomId: 'ROOM',
    nickname: '테스터',
    hostToken: 'HOSTSECRET',
  });

  sockets[0]?.deliver(snapshot('session-token'));
  assert.deepEqual(tokens, ['session-token'], 'the caller is handed the token to persist');

  sockets[0]?.close();
  assert.equal(client.getState().status, 'reconnecting');

  pending.run();
  sockets[1]?.open();
  // Rejoining by token is what preserves the score and the roster slot; a
  // second JOIN_ROOM would create a duplicate player (analysis §5).
  assert.deepEqual(sockets[1]?.sent[0], {
    type: 'REJOIN',
    roomId: 'ROOM',
    playerToken: 'session-token',
    hostToken: 'HOSTSECRET',
  });
});

test('a client with no host token sends a join with no host claim at all', () => {
  const { client, sockets } = harness({ hostToken: null });

  client.connect();
  sockets[0]?.open();
  // Not `hostToken: ''` or `hostToken: null`: a player's frame is the same
  // frame it was before the field existed.
  assert.deepEqual(sockets[0]?.sent[0], { type: 'JOIN_ROOM', roomId: 'ROOM', nickname: '테스터' });
  assert.equal(Object.hasOwn(sockets[0]?.sent[0] ?? {}, 'hostToken'), false);
});

test('reconnect delays back off and then give up', () => {
  const { client, sockets, pending } = harness({ playerToken: 'session-token' });

  client.connect();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    sockets[attempt]?.open();
    sockets[attempt]?.close();
    pending.run();
  }
  assert.deepEqual(pending.delays.slice(0, 4), [500, 1_000, 2_000, 4_000]);
  assert.equal(client.getState().status, 'reconnecting');
});

test('a session the server has forgotten is not retried', () => {
  const { client, sockets, pending } = harness({ playerToken: 'stale' });

  client.connect();
  sockets[0]?.open();
  sockets[0]?.deliver({ type: 'ERROR', reason: 'UNKNOWN_SESSION', message: '세션을 찾을 수 없습니다.' });
  sockets[0]?.close();

  assert.equal(client.getState().status, 'closed');
  assert.deepEqual(pending.delays, [], 'retrying a refused session is a spin loop, not resilience');
});

test('a deliberate disconnect does not reconnect', () => {
  const { client, sockets, pending } = harness({ playerToken: 'session-token' });

  client.connect();
  sockets[0]?.open();
  client.disconnect();

  assert.equal(client.getState().status, 'closed');
  assert.deepEqual(pending.delays, []);
});

test('an action before the socket opens is refused, not thrown', () => {
  const socket = new FakeSocket();
  // A real WebSocket throws InvalidStateError from send() while CONNECTING.
  // Reproduced here so the guard is tested against the behaviour it exists for.
  socket.throwUntilOpen();
  const client = clientOn(socket, { hostToken: 'HOSTSECRET' });

  client.connect();
  assert.equal(client.submitAnswer('너무 이른 정답'), false);
  assert.equal(client.hostStart(), false);
  assert.equal(client.setReady(true), false);
  assert.deepEqual(socket.sent, [], 'nothing was written to a socket that was still connecting');

  socket.open();
  assert.equal(client.setReady(true), true);
});

test('an action after the socket drops is refused rather than lost silently', () => {
  const { client, sockets } = harness({ playerToken: 'session-token' });
  client.connect();
  sockets[0]?.open();
  sockets[0]?.close();

  // Now in backoff, with no live socket. The caller learns the answer did not
  // go anywhere instead of a button appearing to work.
  assert.equal(client.submitAnswer('연결 끊긴 동안의 정답'), false);
});

test('host actions carry the host token, and are silent without one', () => {
  const { client, sockets } = harness();
  client.connect();
  sockets[0]?.open();
  sockets[0]?.reset();

  client.hostStart();
  client.hostPause();
  client.hostSkipSection();
  client.hostEnd();
  assert.deepEqual(sockets[0]?.sent, [
    { type: 'HOST_START', hostToken: 'HOSTSECRET' },
    { type: 'HOST_PAUSE', hostToken: 'HOSTSECRET' },
    { type: 'HOST_SKIP_SECTION', hostToken: 'HOSTSECRET' },
    { type: 'HOST_END', hostToken: 'HOSTSECRET' },
  ]);

  const socket = new FakeSocket();
  const guest = clientOn(socket);
  guest.connect();
  socket.open();
  socket.reset();
  // Every one of them, not just the first: a player holds no token, so there
  // is nothing for any host action to be stamped with.
  guest.hostSkip();
  guest.hostSkipSection();
  guest.hostEnd();
  assert.deepEqual(socket.sent, [], 'a player with no host token sends nothing at all');
});

test('remainingInSection counts what is left of the section on screen', () => {
  const sections = [
    { mode: 'song' as const, count: 3 },
    { mode: 'proverb' as const, count: 2 },
    { mode: 'idiom' as const, count: 2 },
  ];
  const at = (index: number): ClientState => ({
    ...initialState('ROOM'),
    sections,
    totalQuestions: 7,
    round: { ...(reduce([roundStart]).round as NonNullable<ClientState['round']>), question: { mode: 'song', index, totalQuestions: 7, durationMs: 20_000, clue: null } },
  });

  // Songs occupy 0,1,2 — so on the first there are two left, on the last none.
  assert.equal(remainingInSection(at(0)), 2);
  assert.equal(remainingInSection(at(2)), 0);
  // Proverbs occupy 3,4 and idioms 5,6, counted from their own boundaries.
  assert.equal(remainingInSection(at(3)), 1);
  assert.equal(remainingInSection(at(6)), 0);

  // No round means no section to be inside of.
  assert.equal(remainingInSection(initialState('ROOM')), 0);
});

// --- Real server, real sockets ----------------------------------------------

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
];

/** Polls the client's state until `predicate` holds, or fails. */
async function waitUntil(
  client: ProtocolClient,
  predicate: (state: ClientState) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<ClientState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = client.getState();
    if (predicate(state)) return state;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (phase=${state.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a host and a player play a full game through the real client', async () => {
  const running = startServer({ port: 0, songs: SONGS });
  await once(running.server, 'listening');
  const port = (running.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const created = (await (
    await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // One song and nothing else: this test plays a round and then waits for
      // the end of the game, and a default room would run sixty more questions.
      body: JSON.stringify({ counts: { song: 1, proverb: 0, idiom: 0 } }),
    })
  ).json()) as { roomId: string; hostToken: string };

  const connect = (nickname: string, hostToken?: string): ProtocolClient => {
    const client = new ProtocolClient({
      url: `ws://127.0.0.1:${port}/ws`,
      roomId: created.roomId,
      nickname,
      hostToken: hostToken ?? null,
      reconnect: false,
    });
    client.connect();
    return client;
  };

  const host = connect('방장', created.hostToken);
  const guest = connect('참가자');

  try {
    await waitUntil(host, (state) => state.players.length === 2, 'both players in the roster');

    host.hostStart();
    await waitUntil(guest, (state) => state.phase === 'IN_ROUND', 'the round to start');

    const round = guest.getState().round;
    assert.ok(round);
    assert.equal(round.mediaUrl, 'https://media.invalid/a');
    assert.equal(JSON.stringify(round).includes('좋은'), false, 'no answer reached the client');
    // The deadline came from the server; the client only ever reads it.
    assert.ok((guest.remainingMs() ?? 0) > 0);

    guest.submitAnswer('아무 말');
    await waitUntil(guest, (state) => state.answerFeedback.kind === 'rejected', 'a private rejection');
    assert.equal(host.getState().answerFeedback.kind, 'none', 'a miss never reaches another player');

    // The alias expansion in shared/songCatalog.ts is what makes the spaced
    // form win here, and the server is the only thing that judged it.
    guest.submitAnswer('좋은 날');
    const scored = await waitUntil(guest, (state) => state.answerFeedback.kind === 'accepted', 'the win');
    assert.deepEqual(scored.answerFeedback, { kind: 'accepted', place: 1, pointsAwarded: 1 });

    // A song round has one scoring place, so that answer ends it.
    const revealed = await waitUntil(host, (state) => state.reveal !== null, 'the reveal');
    assert.equal(revealed.reveal?.answer.answer, '좋은 날');
    assert.equal(revealed.reveal?.answer.artist, '아이유');
    assert.equal(revealed.reveal?.winner?.nickname, '참가자');
    assert.deepEqual(
      revealed.reveal?.scorers.map((entry) => [entry.place, entry.nickname, entry.pointsAwarded]),
      [[1, '참가자', 1]],
    );

    const final = await waitUntil(host, (state) => state.phase === 'FINISHED', 'the game to end');
    assert.equal(final.finalRanks?.length, 2);
    assert.equal(final.finalRanks?.[0]?.nickname, '참가자');
    assert.equal(final.finalRanks?.[0]?.score, 1);
  } finally {
    host.disconnect();
    guest.disconnect();
    await running.stop();
  }
});

test('a refreshed player keeps their score', async () => {
  const running = startServer({ port: 0, songs: SONGS });
  await once(running.server, 'listening');
  const port = (running.server.address() as AddressInfo).port;

  const { room } = running.game.createRoom({ counts: { song: 1, proverb: 0, idiom: 0 } });
  let stored: string | null = null;

  const first = new ProtocolClient({
    url: `ws://127.0.0.1:${port}/ws`,
    roomId: room.roomId,
    nickname: '참가자',
    reconnect: false,
    onToken: (token) => {
      stored = token;
    },
  });
  first.connect();

  try {
    await waitUntil(first, (state) => state.playerId !== null, 'the first join');
    const playerId = first.getState().playerId;
    first.disconnect();

    // A fresh client with the stored token — exactly what a page refresh does.
    const resumed = new ProtocolClient({
      url: `ws://127.0.0.1:${port}/ws`,
      roomId: room.roomId,
      playerToken: stored,
      reconnect: false,
    });
    resumed.connect();

    const state = await waitUntil(resumed, (candidate) => candidate.playerId !== null, 'the rejoin');
    assert.equal(state.playerId, playerId, 'same identity, not a second roster slot');
    assert.equal(state.players.length, 1);
    resumed.disconnect();
  } finally {
    await running.stop();
  }
});

// --- The halfway hint and the live scorer feed -------------------------------

test('a round starts with no hint and nobody on the board', () => {
  const state = reduce([proverbStart]);
  assert.equal(state.round?.hint, null);
  assert.deepEqual(state.round?.scorers, []);
});

test('ROUND_HINT is stored as sent, and never derived from anything', () => {
  const state = reduce([proverbStart, { type: 'ROUND_HINT', hint: 'ㅇㅅㅇㅈ' }]);
  assert.equal(state.round?.hint, 'ㅇㅅㅇㅈ');
  // It changes nothing else: the deadline, the phase and this player's own
  // feedback are all where they were.
  assert.equal(state.phase, 'IN_ROUND');
  assert.deepEqual(state.answerFeedback, { kind: 'none' });
});

test('a hint with no round to belong to is dropped', () => {
  // It would otherwise be shown against whichever round started next.
  const state = reduce([{ type: 'ROUND_HINT', hint: 'ㄱㄴㄷㄹ' }]);
  assert.equal(state.round, null);
});

test('scorers accumulate in the order the server announced them', () => {
  const state = reduce([
    proverbStart,
    { type: 'ROUND_SCORER', playerId: 'p1', nickname: '가', place: 1, pointsAwarded: 1 },
    { type: 'ROUND_SCORER', playerId: 'p2', nickname: '나', place: 2, pointsAwarded: 1 },
    { type: 'ROUND_SCORER', playerId: 'p3', nickname: '다', place: 3, pointsAwarded: 1 },
  ]);

  assert.deepEqual(
    state.round?.scorers.map((scorer) => `${scorer.place}등 - ${scorer.nickname}`),
    ['1등 - 가', '2등 - 나', '3등 - 다'],
  );
});

test('the same place announced twice is only counted once', () => {
  // A snapshot landing beside the live message must not print somebody twice.
  const state = reduce([
    proverbStart,
    { type: 'ROUND_SCORER', playerId: 'p1', nickname: '가', place: 1, pointsAwarded: 1 },
    { type: 'ROUND_SCORER', playerId: 'p1', nickname: '가', place: 1, pointsAwarded: 1 },
  ]);
  assert.equal(state.round?.scorers.length, 1);
});

test('the next round clears the hint and the scorers', () => {
  const state = reduce([
    proverbStart,
    { type: 'ROUND_HINT', hint: 'ㅇㅅㅇㅈ' },
    { type: 'ROUND_SCORER', playerId: 'p1', nickname: '가', place: 1, pointsAwarded: 1 },
    { type: 'COUNTDOWN_STARTED', startsAt: 90_000 },
    proverbStart,
  ]);
  assert.equal(state.round?.hint, null, 'last round’s hint must not sit over this one');
  assert.deepEqual(state.round?.scorers, []);
});

test('a snapshot restores the hint and scorers that were already public', () => {
  const restored = reduce([
    {
      type: 'ROOM_STATE',
      phase: 'IN_ROUND',
      mode: 'proverb',
      sections: [{ mode: 'proverb', count: 3 }],
      totalQuestions: 3,
      players: [player('p1')],
      isHost: false,
      playerToken: 'token',
      playerId: 'p1',
      leaderboard: [],
      answeredThisRound: false,
      round: {
        question: { mode: 'proverb', index: 0, totalQuestions: 3, durationMs: 60_000, clue: '티끌 모아' },
        song: { index: 0, totalSongs: 3, clipDurationMs: 60_000 },
        mediaUrl: '',
        clipStartMs: 0,
        clipEndMs: 0,
        serverStartedAt: 1_000,
        deadline: 61_000,
        paused: false,
        pausedAt: null,
        hostAway: false,
        hostGraceEndsAt: null,
        livePlayback: false,
        hint: '아주 큰 산',
        scorers: [{ playerId: 'p2', nickname: '나', place: 1, pointsAwarded: 1 }],
      },
    },
  ]);

  assert.equal(restored.round?.hint, '아주 큰 산');
  assert.deepEqual(
    restored.round?.scorers.map((scorer) => `${scorer.place}등 - ${scorer.nickname}`),
    ['1등 - 나'],
  );
});

test('a snapshot taken before the hint restores no hint', () => {
  const early = reduce([
    {
      type: 'ROOM_STATE',
      phase: 'IN_ROUND',
      mode: 'idiom',
      sections: [{ mode: 'idiom', count: 1 }],
      totalQuestions: 1,
      players: [player('p1')],
      isHost: false,
      playerToken: 'token',
      playerId: 'p1',
      leaderboard: [],
      answeredThisRound: false,
      round: {
        question: { mode: 'idiom', index: 0, totalQuestions: 1, durationMs: 60_000, clue: '한 번에 둘' },
        song: { index: 0, totalSongs: 1, clipDurationMs: 60_000 },
        mediaUrl: '',
        clipStartMs: 0,
        clipEndMs: 0,
        serverStartedAt: 1_000,
        deadline: 61_000,
        paused: false,
        pausedAt: null,
        hostAway: false,
        hostGraceEndsAt: null,
        livePlayback: false,
        hint: null,
        scorers: [],
      },
    },
  ]);

  assert.equal(early.round?.hint, null, 'a reconnect must not buy an early hint');
  assert.deepEqual(early.round?.scorers, []);
});
