/**
 * Command-line runner.
 *
 * Serves the API, the WebSocket endpoint, and the reference client from one
 * origin, so a host opens one URL and everything else — room creation, join
 * codes, media registration — happens in the browser.
 *
 * Usage:
 *   node main.ts --playlist songs.txt              # YouTube links, host plays them
 *   node main.ts --songs ../../codex/data/songs.recovered.json
 *   node main.ts --songs songs.json --port 8787 --origin http://localhost:5173
 *   node main.ts --songs songs.json --demo-clips   # round loop, no real audio
 *
 * `--playlist` is the setup for a room with a computer at the front: the file
 * lists YouTube links, one per line, and the host's browser plays them. See
 * docs/USER_GUIDE.md. It can be combined with `--songs`, which then supplies
 * the catalog that link-only lines are identified against.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.ts';
import { resolvePlaylist } from './playlistLoader.ts';
import { parsePlaylist } from '../shared/playlist.ts';
import type { RawSongRecord } from '../shared/songCatalog.ts';

interface Options {
  songsPath: string | null;
  playlistPath: string | null;
  port: number;
  origins: string[];
  demoClips: boolean;
  headless: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    songsPath: null,
    playlistPath: null,
    port: 8787,
    origins: [],
    demoClips: false,
    headless: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--songs':
        options.songsPath = value ?? null;
        i += 1;
        break;
      case '--playlist':
        options.playlistPath = value ?? null;
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
      case '--headless':
        options.headless = true;
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
 * server and the client's round flow, never for a real game.
 */
function applyDemoClips(songs: readonly RawSongRecord[]): RawSongRecord[] {
  return songs.map((song) => {
    // A YouTube song is already playable and has no audio to stand in for.
    if (typeof song.youtubeId === 'string' && song.youtubeId !== '') return song;
    return {
      ...song,
      mediaUrl: song.mediaUrl ?? `https://media.invalid/${song.id}`,
      clipStart: song.clipStart ?? 30,
      clipEnd: song.clipEnd ?? 40,
    };
  });
}

/**
 * Reads the playlist file and works out what each line is.
 *
 * Returns null when the file cannot be used at all, having already explained
 * why. Lines that fail individually are reported and skipped: losing one link
 * an hour before an event should not cost the host the other nineteen.
 */
async function loadPlaylist(path: string, catalog: readonly RawSongRecord[]): Promise<RawSongRecord[] | null> {
  const { entries, problems } = parsePlaylist(readFileSync(path, 'utf8'));

  for (const problem of problems) {
    console.error(`  ${path}:${problem.line}  ${problem.message}`);
    console.error(`    ${problem.text}`);
  }

  if (entries.length === 0) {
    console.error(`\n${path} 에서 사용할 수 있는 링크를 찾지 못했습니다.`);
    return null;
  }

  const needsLookup = entries.filter((entry) => entry.answers.length === 0).length;
  if (needsLookup > 0) {
    console.log(`유튜브에서 ${needsLookup}곡의 제목을 확인하는 중…`);
  }

  const { songs, failures } = await resolvePlaylist(entries, catalog);
  for (const failure of failures) {
    console.error(`  ${path}:${failure.line}  ${failure.message}`);
  }

  for (const song of songs) {
    const how = song.source === 'file' ? '직접 지정' : `자동 인식 · ${song.videoTitle ?? ''}`;
    console.log(`  ${song.record.title}  (${how})`);
  }

  if (songs.length === 0) {
    console.error('\n재생할 수 있는 곡이 하나도 없습니다.');
    return null;
  }
  return songs.map((song) => song.record);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.songsPath === null && options.playlistPath === null) {
    console.error(
      '사용법: node main.ts --playlist <링크 목록 txt>\n' +
        '        node main.ts --songs <곡 JSON 경로> [--port 8787] [--demo-clips] [--origin <주소>] [--headless]',
    );
    process.exitCode = 1;
    return;
  }

  // With both flags, the JSON is the catalog a link-only playlist line is
  // identified against; the playlist is what actually gets played.
  const catalog = options.songsPath === null ? [] : loadSongs(options.songsPath);

  let raw: RawSongRecord[];
  if (options.playlistPath === null) {
    raw = catalog;
  } else {
    const loaded = await loadPlaylist(options.playlistPath, catalog);
    if (loaded === null) {
      process.exitCode = 1;
      return;
    }
    raw = loaded;
  }

  const songs = options.demoClips ? applyDemoClips(raw) : raw;

  const here = dirname(fileURLToPath(import.meta.url));
  const running = startServer({
    port: options.port,
    songs,
    allowedOrigins: options.origins,
    // `--headless` runs the API alone, for a deployment that serves the client
    // from somewhere else (a CDN, or the codex Next.js app).
    clientDir: options.headless ? undefined : resolve(here, '../client'),
    sharedDir: options.headless ? undefined : resolve(here, '../shared'),
  });

  const { playable, issues } = running.catalog;
  console.log(`재생 가능한 곡: ${playable.length} / ${raw.length}`);

  // Group the issues so a 171-song catalog does not print 171 lines.
  const byCode = new Map<string, number>();
  for (const issue of issues) byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
  for (const [code, count] of byCode) console.log(`  제외 ${count}곡: ${code}`);

  const base = `http://localhost:${options.port}`;
  console.log(`\n서버: ${base}  (상태 확인: ${base}/health)`);
  if (!options.headless) console.log(`브라우저에서 ${base} 를 열고 "방 만들기" 를 누르세요.`);
  if (playable.length === 0) {
    console.log(
      '\n재생 가능한 곡이 없습니다. 방장 화면의 "음원 등록"에서 곡별 음원 URL과 재생 구간(5~15초)을\n' +
        '입력하거나, 곡 JSON 의 mediaUrl/clipStart/clipEnd 를 채우세요. 서버 동작만 확인하려면 --demo-clips 를 쓰세요.',
    );
  }
  if (options.origins.length === 0) {
    console.log('\n경고: --origin 을 지정하지 않아 Origin 검사가 꺼져 있습니다. 로컬 개발에서만 쓰세요.');
  }

  const shutdown = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
