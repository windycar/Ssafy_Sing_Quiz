/**
 * Command-line runner for local development.
 *
 * Creates one room at startup and prints its join code and host token, because
 * there is no HTTP route for creating rooms yet. That gap is deliberate and
 * tracked in docs/integration-plan.md — this file exists so the server can be
 * exercised end to end before that route lands.
 *
 * Usage:
 *   node main.ts --songs ../../codex/data/songs.recovered.json --port 8787
 *   node main.ts --songs songs.json --demo-clips --origin http://localhost:5173
 */

import { readFileSync } from 'node:fs';
import { startServer } from './index.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';

interface Options {
  songsPath: string | null;
  port: number;
  origins: string[];
  demoClips: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { songsPath: null, port: 8787, origins: [], demoClips: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--songs':
        options.songsPath = value ?? null;
        i += 1;
        break;
      case '--port':
        options.port = Number(value ?? options.port);
        i += 1;
        break;
      case '--origin':
        if (value !== undefined) options.origins.push(value);
        i += 1;
        break;
      case '--demo-clips':
        options.demoClips = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function loadSongs(path: string): RawSongRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed as RawSongRecord[];
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { songs?: unknown }).songs)) {
    return (parsed as { songs: RawSongRecord[] }).songs;
  }
  throw new Error(`${path} 에서 곡 배열을 찾지 못했습니다. {"songs": [...]} 형식이어야 합니다.`);
}

/**
 * Fills in placeholder media so the round loop can be exercised without a
 * licensed source. The URLs do not play audio — this is for verifying the
 * server, never for a real game.
 */
function applyDemoClips(songs: readonly RawSongRecord[]): RawSongRecord[] {
  return songs.map((song) => ({
    ...song,
    mediaUrl: song.mediaUrl ?? `https://media.invalid/${song.id}`,
    clipStart: song.clipStart ?? 30,
    clipEnd: song.clipEnd ?? 40,
  }));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.songsPath === null) {
    console.error('사용법: node main.ts --songs <곡 JSON 경로> [--port 8787] [--demo-clips] [--origin <주소>]');
    process.exitCode = 1;
    return;
  }

  const raw = loadSongs(options.songsPath);
  const songs = options.demoClips ? applyDemoClips(raw) : raw;
  const running = startServer({ port: options.port, songs, allowedOrigins: options.origins });
  const room = running.game.createRoom();

  const { playable, issues } = running.catalog;
  console.log(`재생 가능한 곡: ${playable.length} / ${raw.length}`);
  if (playable.length === 0) {
    console.log('재생 가능한 곡이 없어 게임을 시작할 수 없습니다. 음원 URL과 재생 구간을 채우거나 --demo-clips 를 쓰세요.');
  }

  // Group the issues so a 171-song catalog does not print 171 lines.
  const byCode = new Map<string, number>();
  for (const issue of issues) byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
  for (const [code, count] of byCode) console.log(`  제외 ${count}곡: ${code}`);

  console.log(`\n서버: http://localhost:${options.port}  (상태 확인: /health)`);
  console.log(`WebSocket: ws://localhost:${options.port}/ws`);
  console.log(`방 참여 코드: ${room.roomId}`);
  console.log(`방장 토큰: ${room.hostToken}`);
  console.log('방장 토큰은 공유하지 마세요. 참여 코드만 참가자에게 알려 주면 됩니다.\n');
  if (options.origins.length === 0) {
    console.log('경고: --origin 을 지정하지 않아 Origin 검사가 꺼져 있습니다. 로컬 개발에서만 쓰세요.');
  }

  const shutdown = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
