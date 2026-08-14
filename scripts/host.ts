/**
 * 게임 서버를 공개 주소로 띄웁니다.
 *
 * 참가자가 방장과 같은 Wi-Fi 에 있다는 보장이 없을 때 씁니다. 학교나 회사
 * 네트워크는 기기끼리 통신을 막아 두는 경우(AP isolation)가 흔하고, 그러면
 * `http://192.168...` 링크는 옆자리에서도 열리지 않습니다. Cloudflare 의
 * 임시 터널은 그 문제를 통째로 우회합니다 — 계정도 설정도 필요 없습니다.
 *
 *   node scripts/host.ts --playlist 내플레이리스트.txt
 *
 * 터널을 먼저 띄우고 주소를 받은 다음 그 주소를 `--origin` 으로 넘겨 서버를
 * 켭니다. 순서가 중요합니다: 주소를 모르는 채로 서버를 켜면 Origin 검사를
 * 끌 수밖에 없고, 그러면 아무 사이트나 이 서버를 호출할 수 있습니다.
 *
 * 알아 둘 것:
 * - 임시 주소는 이 프로세스가 살아 있는 동안만 유효합니다. 껐다 켜면 주소가
 *   바뀌므로, 행사 중에는 끄지 마세요.
 * - 주소를 아는 사람은 누구나 들어올 수 있습니다. 참여 코드가 방을 지킵니다.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(HERE, '../server/main.ts');

/** winget 으로 설치하면 PATH 반영 전까지 여기에만 있습니다. */
const CLOUDFLARED_FALLBACKS = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
];

function findCloudflared(): string {
  for (const candidate of CLOUDFLARED_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }
  // PATH 에 있으면 이름만으로 실행됩니다. 없으면 spawn 이 실패하고,
  // 그때 설치 방법을 안내합니다.
  return 'cloudflared';
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;
/** 터널이 주소를 뱉기까지 기다리는 시간. 보통 5초 안쪽입니다. */
const TUNNEL_TIMEOUT_MS = 60_000;

function startTunnel(port: number): { child: ChildProcess; url: Promise<string> } {
  const child = spawn(findCloudflared(), ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('터널 주소를 받지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    }, TUNNEL_TIMEOUT_MS);

    const scan = (chunk: Buffer): void => {
      const found = TUNNEL_URL.exec(chunk.toString('utf8'));
      if (found === null) return;
      clearTimeout(timer);
      resolvePromise(found[0]);
    };

    // cloudflared 는 주소를 stderr 로 내보냅니다. 둘 다 봅니다.
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'cloudflared 를 찾지 못했습니다.\n' +
                '  winget install --id Cloudflare.cloudflared\n' +
                '설치 후 터미널을 새로 열고 다시 실행하세요.',
            )
          : error,
      );
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared 가 종료되었습니다 (코드 ${code}).`));
    });
  });

  return { child, url };
}

/**
 * Kills a child and everything it started.
 *
 * `child.kill()` on Windows terminates only the process named, so a tunnel or
 * a server that spawned anything of its own leaks. A leaked tunnel keeps a
 * public address alive for a game that has stopped, and a leaked server holds
 * the port the next run needs — both surface as a confusing failure at the
 * worst possible moment, when someone is trying to start an event.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill();
}

function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf('--port');
  if (index === -1) return 8787;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : 8787;
}

async function main(): Promise<void> {
  // `--port` 만 읽고 나머지는 그대로 넘깁니다. 이 스크립트는 실행 방식만
  // 바꾸는 것이고, 곡을 고르는 규칙은 server/main.ts 하나에만 둡니다.
  const passthrough = process.argv.slice(2);
  const port = parsePort(passthrough);

  if (!passthrough.includes('--playlist') && !passthrough.includes('--songs')) {
    console.error(
      '사용법: node scripts/host.ts --playlist <링크 목록 txt> [--songs <곡 JSON>] [--port 8787]\n' +
        '옵션은 server/main.ts 와 같습니다.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('공개 주소를 만드는 중…');
  const tunnel = startTunnel(port);

  let publicUrl: string;
  try {
    publicUrl = await tunnel.url;
  } catch (error) {
    tunnel.child.kill();
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const server = spawn(
    process.execPath,
    [MAIN, ...passthrough, '--port', String(port), '--origin', publicUrl],
    { stdio: 'inherit' },
  );

  const line = '─'.repeat(publicUrl.length + 4);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${publicUrl}  │`);
  console.log(`└${line}┘`);
  console.log('\n참가자에게 위 주소를 알려 주고, 화면에 뜨는 참여 코드를 불러 주세요.');
  console.log('방장은 같은 주소에서 "방 만들기" 를 누릅니다.');
  console.log('\n이 창을 닫으면 주소가 사라집니다. 행사가 끝날 때까지 켜 두세요.');

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    killTree(server);
    killTree(tunnel.child);
  };

  // 한쪽이 죽으면 다른 쪽도 정리합니다. 서버 없는 주소나 주소 없는 서버는
  // 둘 다 쓸모가 없고, 남아 있으면 다음 실행에서 포트를 물고 늘어집니다.
  server.on('exit', (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
  tunnel.child.on('exit', () => {
    if (!stopping) console.error('\n터널이 끊어졌습니다. 서버를 정리합니다.');
    stop();
  });

  // 창의 X 버튼으로 닫는 경우까지 포함해 나갈 수 있는 모든 문에 같은 정리를
  // 겁니다. `exit` 는 동기 작업만 허용하므로 killTree 도 동기입니다.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('SIGBREAK', stop);
  process.on('exit', stop);
  process.on('uncaughtException', (error) => {
    stop();
    console.error(error);
    process.exitCode = 1;
  });
}

void main();
