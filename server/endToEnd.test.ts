/**
 * End-to-end tests over a real TCP socket.
 *
 * These use Node's built-in `WebSocket` client against the hand-written server
 * from `websocket.ts`. The unit tests in `gameRoom.test.ts` prove the rules;
 * these prove the handshake, framing, routing, and timers actually work — the
 * parts a pure state-machine test cannot reach.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startServer } from './index.ts';
import { acceptKey, decodeFrame, encodeFrame } from './websocket.ts';
import { PROVERB_BANK } from './questionBanks.ts';
import type { ServerMessage } from './protocol.ts';
import { QUESTIONS_PER_TEXT_GAME } from '../shared/questions.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';

/**
 * How many questions a proverb room actually draws on this machine.
 *
 * `QUESTIONS_PER_TEXT_GAME` on a clean checkout. Read from the live bank
 * because a host running the suite may have a shorter `문제/속담.json` of their
 * own, and the server playing all of it is correct.
 */
const TEXT_GAME_SIZE = Math.min(PROVERB_BANK.length, QUESTIONS_PER_TEXT_GAME);

/**
 * Set when the machine cannot play proverbs at all, which happens only when
 * someone's own `문제/속담.json` will not load.
 *
 * The proverb test below is about sockets and timers, not about the bank, so
 * it is skipped with a reason rather than left to fail six seconds later
 * waiting for a round that was never going to start. The server says the same
 * thing far more loudly at startup.
 */
const NO_PROVERBS = PROVERB_BANK.length === 0 ? '문제/속담.json 을 읽지 못했습니다' : false;

const SONGS: RawSongRecord[] = [
  {
    id: 's1',
    artist: '방탄소년단',
    title: 'Dynamite',
    aliases: ['다이나마이트'],
    mediaUrl: 'https://media.invalid/a1',
    clipStart: 0,
    clipEnd: 5,
  },
];

/** A tiny client that records every message it receives. */
class TestClient {
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new TestClient(socket);
    socket.addEventListener('message', (event) => {
      client.received.push(JSON.parse(String(event.data)) as ServerMessage);
    });
    await once(socket, 'open');
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }

  /** Waits for a message of the given type, or fails after `timeoutMs`. */
  async waitFor<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 3_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${type}; got ${this.received.map((m) => m.type).join(', ')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  countOf(type: ServerMessage['type']): number {
    return this.received.filter((m) => m.type === type).length;
  }
}

async function withServer(
  run: (context: { port: number; game: ReturnType<typeof startServer>['game'] }) => Promise<void>,
  options: { allowedOrigins?: readonly string[] } = {},
): Promise<void> {
  const running = startServer({ port: 0, songs: SONGS, allowedOrigins: options.allowedOrigins });
  await once(running.server, 'listening');
  const port = (running.server.address() as AddressInfo).port;
  try {
    await run({ port, game: running.game });
  } finally {
    await running.stop();
  }
}

// --- Framing primitives -----------------------------------------------------

test('acceptKey follows the RFC 6455 example', () => {
  // The example key/response pair given in RFC 6455 §1.3.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame and decodeFrame round-trip across length boundaries', () => {
  for (const size of [0, 1, 125, 126, 127, 65_535, 65_536]) {
    const payload = Buffer.alloc(size, 0x61);
    const decoded = decodeFrame(encodeFrame(0x1, payload));
    assert.ok(decoded, `no frame decoded at size ${size}`);
    assert.equal(decoded.payload.length, size);
    assert.equal(decoded.fin, true);
  }
});

test('decodeFrame returns null for an incomplete frame', () => {
  const frame = encodeFrame(0x1, Buffer.from('hello'));
  assert.equal(decodeFrame(frame.subarray(0, 3)), null);
  assert.equal(decodeFrame(Buffer.alloc(0)), null);
});

test('decodeFrame unmasks a client frame', () => {
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const payload = Buffer.from('hi!');
  const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)));
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);

  const decoded = decodeFrame(frame);
  assert.equal(decoded?.payload.toString('utf8'), 'hi!');
});

// --- HTTP surface -----------------------------------------------------------

test('the health endpoint reports how many songs are playable', async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', playableSongs: 1, rooms: 0 });
  });
});

test('an unplayable catalog yields zero playable songs rather than crashing', async () => {
  const running = startServer({
    songs: [{ id: 'x', artist: 'a', title: 't', mediaUrl: null, clipStart: null, clipEnd: null }],
  });
  assert.equal(running.catalog.playable.length, 0);
  assert.equal(running.catalog.issues[0]?.code, 'MISSING_MEDIA_URL');
  await running.stop();
});

// --- Live gameplay ----------------------------------------------------------

test('two clients play a full round over real sockets', async () => {
  await withServer(async ({ port, game }) => {
    const { room } = game.createRoom();

    const host = await TestClient.connect(port);
    host.send({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '방장', hostToken: room.hostToken });
    const hostState = await host.waitFor('ROOM_STATE');
    assert.equal(hostState.isHost, true);

    const guest = await TestClient.connect(port);
    guest.send({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '참가자' });
    await guest.waitFor('ROOM_STATE');

    // The roster update reached the other client, so broadcast routing works.
    await host.waitFor('PLAYER_JOINED');

    host.send({ type: 'HOST_START', hostToken: room.hostToken });
    await guest.waitFor('COUNTDOWN_STARTED');

    // The countdown is a real server timer; both clients must see the round.
    const start = await guest.waitFor('ROUND_START', 6_000);
    assert.equal(start.question.mode, 'song');
    assert.equal(start.mediaUrl, 'https://media.invalid/a1');
    assert.equal(JSON.stringify(start).includes('Dynamite'), false);

    guest.send({ type: 'SUBMIT_ANSWER', guess: '틀린답' });
    await guest.waitFor('ANSWER_REJECTED');
    // A miss must not reach anyone else.
    assert.equal(host.countOf('ANSWER_REJECTED'), 0);

    guest.send({ type: 'SUBMIT_ANSWER', guess: '다이나 마이트' });
    const accepted = await guest.waitFor('ANSWER_ACCEPTED');
    assert.equal(accepted.place, 1);
    assert.equal(accepted.pointsAwarded, 1);

    // A song round has one scoring place, so that answer ends it.
    const reveal = await host.waitFor('ROUND_REVEAL');
    assert.equal(reveal.answer.answer, 'Dynamite');
    assert.equal(reveal.song.title, 'Dynamite');
    assert.equal(reveal.winner?.nickname, '참가자');
    assert.deepEqual(
      reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
      [[1, 1]],
    );

    // Per-recipient leaderboard payloads.
    const hostUpdate = await host.waitFor('LEADERBOARD_UPDATE');
    const guestUpdate = await guest.waitFor('LEADERBOARD_UPDATE');
    assert.equal(hostUpdate.you.score, 0);
    assert.equal(guestUpdate.you.score, 1);
    assert.equal(guestUpdate.you.rank, 1);

    // One song only, so the reveal timer ends the game.
    const over = await host.waitFor('GAME_OVER', 8_000);
    assert.equal(over.finalRanks.length, 2);

    host.close();
    guest.close();
  });
});

test('a proverb room plays over real sockets without the answer ever crossing the wire', { skip: NO_PROVERBS }, async () => {
  await withServer(async ({ port, game }) => {
    const { room, mode, questionCount } = game.createRoom({ mode: 'proverb' });
    assert.equal(mode, 'proverb');
    assert.equal(questionCount, TEXT_GAME_SIZE);

    const host = await TestClient.connect(port);
    host.send({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '방장', hostToken: room.hostToken });
    const hostState = await host.waitFor('ROOM_STATE');
    assert.equal(hostState.mode, 'proverb');
    assert.equal(hostState.totalQuestions, TEXT_GAME_SIZE);

    const guest = await TestClient.connect(port);
    guest.send({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '참가자' });
    await guest.waitFor('ROOM_STATE');
    await host.waitFor('PLAYER_JOINED');

    host.send({ type: 'HOST_START', hostToken: room.hostToken });
    const start = await guest.waitFor('ROUND_START', 6_000);

    assert.equal(start.question.mode, 'proverb');
    assert.equal(start.question.index, 0);
    assert.equal(start.question.totalQuestions, TEXT_GAME_SIZE);
    assert.ok((start.question.clue ?? '').length > 0, 'the prefix has to be on screen');
    assert.equal(start.mediaUrl, '', 'a text round needs no media URL');
    assert.equal(start.livePlayback, false);
    assert.equal(guest.countOf('ROUND_CUE'), 0);
    assert.equal(host.countOf('ROUND_CUE'), 0, 'a text round has nothing to cue');

    // Which question was drawn is random, so the answer is looked up by clue.
    const question = PROVERB_BANK.find(
      (candidate) => candidate.mode === 'proverb' && candidate.prefix === start.question.clue,
    );
    assert.ok(question !== undefined && question.mode === 'proverb');

    // Nothing sent so far names any answer in the bank.
    const seen = JSON.stringify([...host.received, ...guest.received]);
    for (const alias of question.aliases) {
      assert.equal(seen.includes(alias), false, `"${alias}" reached a client before the reveal`);
    }

    guest.send({ type: 'SUBMIT_ANSWER', guess: '전혀 다른 말' });
    await guest.waitFor('ANSWER_REJECTED');

    // The missing half alone is a correct answer.
    guest.send({ type: 'SUBMIT_ANSWER', guess: question.suffix });
    const accepted = await guest.waitFor('ANSWER_ACCEPTED');
    assert.equal(accepted.place, 1);
    assert.equal(accepted.pointsAwarded, 1);

    // The whole proverb is a correct answer too, from a different player.
    host.send({ type: 'SUBMIT_ANSWER', guess: question.full });
    const second = await host.waitFor('ANSWER_ACCEPTED');
    assert.equal(second.place, 2);
    assert.equal(second.pointsAwarded, 1);

    // Two of three places taken, so the deadline is what ends this round.
    const reveal = await guest.waitFor('ROUND_REVEAL', 40_000);
    assert.equal(reveal.answer.mode, 'proverb');
    assert.equal(reveal.answer.answer, question.full);
    assert.equal(reveal.answer.detail, question.suffix);
    assert.deepEqual(
      reveal.scorers.map((entry) => [entry.place, entry.pointsAwarded]),
      [
        [1, 1],
        [2, 1],
      ],
    );

    host.close();
    guest.close();
  });
});

test('a reconnecting client keeps its score and gets a fresh snapshot', async () => {
  await withServer(async ({ port, game }) => {
    const { room } = game.createRoom();

    const host = await TestClient.connect(port);
    host.send({ type: 'JOIN_ROOM', roomId: room.roomId, nickname: '방장', hostToken: room.hostToken });
    const first = await host.waitFor('ROOM_STATE');
    const token = first.playerToken;

    host.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reconnected = await TestClient.connect(port);
    reconnected.send({ type: 'REJOIN', roomId: room.roomId, playerToken: token });
    const snapshot = await reconnected.waitFor('ROOM_STATE');

    assert.equal(snapshot.playerId, first.playerId);
    assert.equal(snapshot.isHost, true);
    assert.equal(snapshot.players.length, 1, 'the roster slot survived the disconnect');
    reconnected.close();
  });
});

test('a malformed frame is answered with an error, not a dropped connection', async () => {
  await withServer(async ({ port }) => {
    const client = await TestClient.connect(port);
    client.send('this is not json');
    const error = await client.waitFor('ERROR');
    assert.equal(error.reason, 'MALFORMED_MESSAGE');
    client.close();
  });
});

test('joining an unknown room is refused', async () => {
  await withServer(async ({ port }) => {
    const client = await TestClient.connect(port);
    client.send({ type: 'JOIN_ROOM', roomId: 'no-such-room', nickname: '아무개' });
    const error = await client.waitFor('ERROR');
    assert.equal(error.reason, 'ROOM_NOT_FOUND');
    client.close();
  });
});

/**
 * Performs a raw upgrade handshake and reports what the server did.
 *
 * Driven at the HTTP layer rather than through a WebSocket client because a
 * refused upgrade is exactly the case where client libraries differ in which
 * events they emit.
 */
async function attemptUpgrade(port: number, origin?: string): Promise<{ status: number; upgraded: boolean }> {
  const headers: Record<string, string> = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': randomBytes(16).toString('base64'),
    'sec-websocket-version': '13',
  };
  if (origin !== undefined) headers['origin'] = origin;

  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/ws', headers });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, upgraded: true });
    });
    request.on('response', (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, upgraded: false });
    });
    request.on('error', reject);
    request.end();
  });
}

test('an upgrade from a disallowed origin is refused with 403', async () => {
  await withServer(
    async ({ port }) => {
      const rejected = await attemptUpgrade(port, 'https://evil.invalid');
      assert.equal(rejected.upgraded, false);
      assert.equal(rejected.status, 403);

      // A request with no Origin header at all is refused too.
      const anonymous = await attemptUpgrade(port);
      assert.equal(anonymous.status, 403);
    },
    { allowedOrigins: ['https://drop-the-beat-quiz.example'] },
  );
});

test('an upgrade from an allowed origin completes with 101', async () => {
  await withServer(
    async ({ port }) => {
      const accepted = await attemptUpgrade(port, 'https://drop-the-beat-quiz.example');
      assert.equal(accepted.upgraded, true);
      assert.equal(accepted.status, 101);
    },
    { allowedOrigins: ['https://drop-the-beat-quiz.example'] },
  );
});

test('an upgrade to an unknown path is refused', async () => {
  await withServer(async ({ port }) => {
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/not-ws',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
        },
      });
      request.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response, 404);
  });
});
