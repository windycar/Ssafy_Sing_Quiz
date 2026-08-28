# 개발 가이드

이 저장소에서 개발 환경을 준비하고, 완성형 게임을 실행·검증하고, 두 에이전트
브랜치(`agent/claude`, `agent/codex`)를 오가며 작업을 주고받는 방법을
정리합니다. 대상 독자는 이 프로젝트를 로컬에서 실행하거나, Claude/Codex의
작업을 이어받아 통합하는 사람입니다.

## 1. Windows 필수 도구

| 도구 | 요구 버전 | 확인 명령 |
| --- | --- | --- |
| Node.js | `>=22.13.0` (`music-quiz`, `shared` 공통 요구사항) | `node --version` |
| npm | Node.js에 포함 | `npm --version` |
| Python | 3.x (`tools/extract-scx-song-text.py` 실행용) | `python --version` |
| Git | 최신 안정 버전 | `git --version` |

버전이 요구치보다 낮으면 `npm.cmd install` 단계에서 `engines` 경고 또는
설치 실패가 발생할 수 있습니다. Node.js는 공식 Windows 인스톨러 또는
`nvm-windows`로 설치하세요.

## 2. 실행 및 검증 명령

`music-quiz/`는 `main`에 통합된 **권위 서버 연결 React 클라이언트**입니다. 아래
명령은 실제 `music-quiz/package.json`에
정의된 스크립트만 사용합니다 — 이 목록에 없는 명령은 존재하지 않습니다.

```powershell
npm.cmd install          # 의존성 설치
npm.cmd run dev          # 로컬 개발 서버 (vinext dev, Cloudflare Workers 런타임 에뮬레이션)
npm.cmd test             # 빌드 후 tests/rendered-html.test.mjs 실행
npm.cmd run lint         # eslint . (dist, .next 제외)
npm.cmd run build        # 프로덕션 빌드 (vinext build)
npm.cmd run start        # 빌드 산출물 로컬 구동 (vinext start)
npm.cmd run db:generate  # drizzle-kit generate — db/schema.ts 기반 마이그레이션 생성
```

`db:generate`는 `db/schema.ts`가 비어 있는 현재 상태에서는 생성할 테이블이
없습니다. D1/R2 바인딩도 아직 연결되어 있지 않습니다
(`music-quiz/.openai/hosting.json` 기준 `d1: null`, `r2: null`) — 이 앱은
데이터베이스를 실제로 쓰지 않습니다. 방 상태는 전부 게임 서버의 메모리에
있습니다.

#### `music-quiz`를 게임 서버에 붙여 실행하기

`music-quiz`는 화면만 담당하고 판정·타이머·순위는 전부 게임 서버가 합니다.
따라서 **두 프로세스를 같이 띄워야** 합니다. Cloudflare Workers는 소켓을 열고
대기하는 프로세스를 돌릴 수 없으므로, 게임 서버는 항상 별도로 존재합니다
([`OPERATIONS.md`](./OPERATIONS.md) §1).

```powershell
# 터미널 1 — 게임 서버 (워크트리 루트에서)
node server\main.ts --songs data\songs.recovered.json --demo-clips --origin http://localhost:3000

# 터미널 2 — UI (music-quiz/ 에서)
$env:VITE_GAME_SERVER = "http://localhost:8787"
npm.cmd run dev
```

`npm.cmd run dev`가 출력하는 주소(<http://localhost:3000>)를 엽니다.

| 환경변수 | 뜻 |
| --- | --- |
| `VITE_GAME_SERVER` | 게임 서버의 주소. HTTP API의 기준 주소가 되고, WebSocket 주소는 여기서 `ws`/`wss`로 바꿔 `/ws`를 붙여 만듭니다. **비워 두면 같은 출처**로 간주하므로, UI와 게임 서버가 서로 다른 포트에 있으면 반드시 지정해야 합니다 |

값은 빌드 시점에 번들에 박히는 Vite 환경변수입니다. 비밀값이 아니며(브라우저가
어차피 접속할 주소입니다) 방장 토큰과는 무관합니다. 게임 서버를 다른 출처에서
띄웠다면 그 서버에 `--origin`으로 UI 주소를 허용해 주어야 합니다.

공용 로직(`shared/`)은 저장소 루트에 있고 별도 테스트 스크립트를
가집니다.

```powershell
cd shared
npm.cmd test   # node --test *.test.ts — answerMatching, songCatalog, questions, youtube, playlist 테스트
```

권위 게임 서버(`server/`)와 웹 클라이언트(`client/`)도 같은 방식으로 의존성
없이 돌아갑니다. 서버 하나가 API·WebSocket·클라이언트를 모두 제공합니다.

```powershell
cd server
npm.cmd test    # node --test *.test.ts — 엔진 단위 테스트 + 실제 소켓 종단 테스트 + HTTP API 테스트
npm.cmd start -- --songs ..\data\songs.recovered.json
```

출력된 주소(<http://localhost:8787>)를 브라우저로 열면 방 만들기부터 진행할 수
있습니다. 주요 옵션은 다음과 같습니다.

| 옵션 | 뜻 |
| --- | --- |
| `--playlist <경로>` | 유튜브 링크 목록 txt. 이걸 주면 여기 적힌 곡만 출제합니다 |
| `--songs <경로>` | 곡 JSON. 배열이거나 `{"songs": [...]}` 형식. `--playlist`와 함께 쓰면 링크만 적힌 줄을 대조할 카탈로그가 됩니다 |
| `--port <번호>` | 기본 8787 |
| `--origin <주소>` | 허용할 출처. **여러 번 지정 가능.** 생략하면 Origin 검사와 CORS 검사가 모두 꺼집니다 — 로컬 전용 |
| `--demo-clips` | 음원이 비어 있는 곡에 자리표시자를 채우는 개발 전용 옵션 (소리는 나지 않습니다) |
| `--headless` | 클라이언트를 서빙하지 않고 API/WebSocket만 제공 |

클라이언트 테스트는 순수 리듀서 테스트, 가짜 소켓을 쓴 재접속 테스트, 그리고
실제 서버를 띄워 실제 WebSocket으로 한 판을 끝까지 진행하는 종단 테스트로
나뉩니다.

```powershell
cd client
npm.cmd test   # node --test *.test.ts
```

`server/`는 `node:http` 위에 RFC 6455 핸드셰이크와 프레이밍을 직접 구현합니다.
WebSocket 라이브러리를 받지 않는 이유는 `shared/`와 같습니다 — 설치 단계 없이
`node --test`만으로 검증할 수 있게 하기 위해서입니다. 서버를 코드에서 띄울 때는
다음과 같이 씁니다.

```ts
const running = startServer({
  port: 8080,
  songs,
  allowedOrigins: ['https://…'],
  clientDir: '…/client',   // 생략하면 API/WebSocket만 제공
  sharedDir: '…/shared',
});
const { room } = running.game.createRoom({ counts: { song: 10, proverb: 5, idiom: 5 } });
await running.stop();      // 타이머 정리 + 소켓 드레이닝
```

### 빌드 단계가 없는 이유

`client/`는 TypeScript로 작성되어 있지만 번들러가 없습니다. 서버가 `.ts`
파일을 요청받으면 Node에 내장된 `stripTypeScriptTypes`로 타입만 지워
JavaScript로 내려보냅니다(`server/staticFiles.ts`). 덕분에

- 저장소 tsconfig가 클라이언트 코드까지 그대로 타입 검사하고,
- `node --test`가 클라이언트 모듈을 그대로 불러 테스트하며,
- 브라우저는 **서버와 같은 소스 파일**을 받습니다.

타입 제거는 문법을 공백으로 치환할 뿐이라 브라우저 스택 트레이스의 줄·열
번호가 원본과 일치합니다. 이 방식은 개발용입니다 — 공개 배포에서 무엇을 대신
써야 하는지는 [`OPERATIONS.md`](./OPERATIONS.md)에 있습니다.

### 타입 검사

워크트리 루트의 `tsconfig.json` 하나로 `shared/`, `server/`, `client/`를 함께
확인합니다.

```powershell
npx tsc --noEmit -p .
```

의존성이 없으므로 실행과 테스트에는 `npm.cmd install`이 필요하지 않습니다
(`tsc` 실행에만 TypeScript와 `@types/node`가 필요합니다). 현재 테스트는
**321개**(`shared` 84개, `server` 192개, `client` 45개)이며 모두 통과해야
합니다. `music-quiz/`는 빌드가 필요하므로 별도이며 **7개**입니다
(`cd music-quiz && npm.cmd test`).
Node의 TypeScript 타입 제거 기능을 그대로 쓰기 때문에 **22.13 미만에서는 문법
오류로 실패합니다.**

> **해결된 빌드 문제.** `music-quiz/vite.config.ts`는
> `./build/sites-vite-plugin`을 가져오는데, 저장소 루트 `.gitignore`의
> `build/` 규칙이 이 디렉터리까지 무시해 새로 복제한 환경에서는 빌드가
> 실패했습니다. `.gitignore`에 `!music-quiz/build/` 예외를 추가해
> 해결했습니다 — 이름만 `build`일 뿐 산출물이 아니라 소스입니다.

타입 검사 설정은 워크트리 루트 `tsconfig.json` 하나로 통일되어 있습니다
(`strict`, `noUnusedLocals`, `noImplicitOverride` 등). 산출물을 만들지 않고
검사만 수행합니다.

## 3. 디렉터리 구조

### 저장소 루트 (이 브랜치)

| 경로 | 역할 |
| --- | --- |
| `AGENTS.md` | Claude/Codex 공통 작업 정책 (역할 분담, 워크스페이스 소유권, 핸드오프 규칙) — 이 저장소의 최상위 규칙 |
| `CLAUDE.md` | Claude Code 전용 지시사항 |
| `README.md` | 프로젝트 개요, 배포 링크, 구현 현황 |
| `docs/claude-analysis.md` | 실시간 아키텍처 분석 (전송 방식, 동시성, 재접속, 보안) |
| `docs/realtime-protocol.md` | WebSocket 메시지 규격과 상태 전이표 |
| `docs/integration-plan.md` | 두 브랜치를 병합하는 순서와 충돌 목록 |
| `docs/USER_GUIDE.md` / `docs/SONG_DATA_GUIDE.md` / `docs/DEVELOPMENT.md` / `docs/OPERATIONS.md` | 사용자·데이터·개발·운영 가이드 (이 문서) |
| `shared/answerMatching.ts` | 정답 정규화(NFKC, 소문자화, 문자/숫자만 남기기) 및 별칭 매칭 |
| `shared/songCatalog.ts` | 원본 곡 레코드를 `SongConfig`로 검증·변환, 괄호 별칭 자동 확장, 방장 음원 등록 병합 |
| `shared/questions.ts` | 세 종류 공용 `Question` 모델과 진행 순서(`SECTION_ORDER`). 문제 은행 검증과, 정답 공개 전에 무엇이 나갈 수 있는지 정하는 유일한 함수(`toQuestionPublic`). 브라우저에서도 불러가므로 `node:` 모듈을 쓰지 않습니다 |
| `data/proverbs.json`, `data/idioms.json` | 속담·사자성어 문제 은행 각 50문항. **서버에서만 읽습니다** — `shared/`와 달리 정적 서빙 대상이 아닙니다 |
| `server/questionBanks.ts` | 문제 은행을 시작할 때 한 번 읽어 검증. `data/` 기본 파일이 잘못됐으면 서버가 뜨지 않고, 방장이 `문제/`에 둔 파일이 잘못됐으면 그 챕터만 비우고 경고합니다 |
| `server/localFiles.ts` | 방장이 고치는 세 파일이 `문제/`(`곡목록.txt`·`속담.json`·`사자성어.json`)에 있으면 그쪽을, 없으면 `data/` 기본 파일을 쓰도록 결정하는 유일한 지점 |
| `shared/youtube.ts` | 유튜브 링크 파싱, 영상 제목으로 곡 식별(짧은 제목은 가수까지 일치해야 인정), oEmbed 주소 생성 |
| `shared/playlist.ts` | 플레이리스트 txt 파서. 잘못된 줄은 줄 번호와 함께 보고하고 나머지는 살립니다 |
| `server/youtubeLookup.ts` | oEmbed로 영상 제목 조회. HTTP 라우트와 시작 시 로더가 같이 씁니다 |
| `server/playlistLoader.ts` | 파싱된 플레이리스트를 실제 곡 레코드로 해석. 조회 함수를 주입받아 네트워크 없이 테스트합니다 |
| `scripts/host.ts` | Cloudflare 임시 터널을 띄워 공개 주소를 얻고, 그 주소를 `--origin`으로 넘겨 서버 실행 |
| `scripts/prepare-files.ts` | 루트의 세 파일이 없으면 `data/` 기본값에서 복사해 만듭니다. 이미 있으면 손대지 않습니다 |
| `게임시작.bat` | 프로젝트 루트의 런처. 위 두 스크립트를 차례로 실행합니다. **내용은 전부 ASCII** — cmd가 콘솔 코드 페이지로 배치 파일을 읽어 한글 바이트가 주변 줄까지 깨뜨립니다. 한글 파일 이름은 `server/localFiles.ts`에만 두고, 한글 출력은 전부 Node가 냅니다 |
| `server/gameRoom.ts` | 방 상태 기계. 소켓·시계·타이머를 모르는 순수 로직 |
| `server/protocol.ts` | 와이어 프로토콜 타입과 수신 메시지 검증 |
| `server/websocket.ts` | `node:http` 위에 직접 구현한 RFC 6455 전송 계층 |
| `server/http.ts` | 방 생성·조회·곡 카탈로그 API, 요청 빈도 제한, CORS |
| `server/staticFiles.ts` | 클라이언트 정적 서빙. `.ts`를 타입 제거해 JS로 내려보냄 |
| `server/index.ts` | 방 레지스트리와 전송 계층 연결, 타이머 소유, 방치된 방 회수 |
| `server/main.ts` | 명령줄 실행 진입점 |
| `client/protocolClient.ts` | 프레임워크 비의존 프로토콜 클라이언트 (재접속, 서버 시계 보정, 메시지→상태 변환) |
| `client/api.ts` | HTTP API 타입 래퍼 (방 생성·조회·카탈로그·세트리스트) |
| `client/ui.ts`, `client/index.html`, `client/styles.css` | 참조 웹 클라이언트 (방장·참가자 전 화면) |
| `*/**.test.ts` | 각 모듈의 테스트 |

### `music-quiz/`

| 경로 | 역할 |
| --- | --- |
| `app/page.tsx` | 홈/방장 설정/대기실/게임/결과 화면 전체를 담은 단일 클라이언트 컴포넌트. 판정·타이머·순위는 서버가 하고, 이 파일은 그리기만 합니다 |
| `app/gameServer.ts` | 게임 서버 주소 해석(`VITE_GAME_SERVER`)과 세션 토큰 보관(`sessionStorage`) |
| `app/layout.tsx`, `app/globals.css` | 공통 레이아웃과 스타일 |
| `build/sites-vite-plugin.ts` | `vite.config.ts`가 가져오는 빌드 플러그인. 이름이 `build/`라 무시될 뻔했으나 `.gitignore`에 예외가 걸려 있습니다 |
| `worker/index.ts` | Cloudflare Workers 진입점. vinext 템플릿 그대로이며, 게임 서버는 여기가 아니라 별도 호스트에 있습니다 |
| `db/schema.ts`, `db/index.ts`, `drizzle.config.ts` | Drizzle ORM 스캐폴드. 스키마는 비어 있고 D1 바인딩도 연결 전 |
| `tests/rendered-html.test.mjs` | 빌드 산출물 HTML을 검사하는 테스트 |
| `vite.config.ts`, `next.config.ts` | 빌드 설정 (vinext/Vite 기반) |
| `data/songs.recovered.json`, `tools/extract-scx-song-text.py`, `docs/scx-recovery.md` | SCX에서 복구한 곡 텍스트와 복구 스크립트 — 저장소 루트 기준 경로, 자세한 내용은 [`SONG_DATA_GUIDE.md`](./SONG_DATA_GUIDE.md) |

## 4. 에이전트 역할 분담과 워크트리

`AGENTS.md`에 정의된 기본 정책입니다.

| 역할 | 담당 | 비중 |
| --- | --- | --- |
| 요구사항 분석, 아키텍처, 백엔드/핵심 기능 구현, 테스트, 1차 리뷰 | Claude Code | 약 70–80% |
| 오케스트레이션, 비공개/로컬 파일 검토, 통합 리뷰, 독립 검증, 배포, 최종 보고 | Codex | 약 20–30% |

| 에이전트 | 워크트리 | 브랜치 |
| --- | --- | --- |
| Claude Code | `.worktrees/claude` | `agent/claude` |
| Codex | `.worktrees/codex` | `agent/codex` |
| 통합 | 저장소 루트 | `main` |

각 에이전트는 자신의 워크트리/브랜치만 수정합니다. 다른 에이전트의 워크트리
파일을 직접 편집하지 않습니다(참고용으로만 읽습니다).

## 5. 브랜치, 커밋, 인수인계, 통합 절차

1. 작업 시작 전 `git status --short --branch`로 현재 브랜치가 자신의 담당
   브랜치인지 확인합니다.
2. 커밋 메시지는 `type(scope): summary` 형식을 씁니다.
3. 작업을 마치면 다음을 보고합니다: 브랜치와 커밋 해시, 변경된 파일, 실행한
   검증과 결과, 남은 위험 요소나 후속 작업.
4. `main`으로의 병합은 사용자가 명시적으로 요청했을 때만 수행합니다. 병합
   순서는 [`integration-plan.md`](./integration-plan.md) §3을 따릅니다
   (먼저 `agent/claude`, 그다음 `agent/codex`, 이후 `shared`를 `music-quiz`에
   연결).

```powershell
git switch main
git merge --no-ff agent/claude
git merge --no-ff agent/codex
```

두 브랜치가 같은 줄을 바꿨다면 하나를 먼저 병합하고 두 번째 병합에서
충돌을 해결합니다.

각 에이전트 브랜치를 `main`의 최신 상태로 맞추려면 해당 워크트리가 깨끗한
상태일 때 다음을 실행합니다.

```powershell
git merge main
```

## 6. 민감정보 금지, 환경변수 원칙

- `.env`, 자격 증명, API 키, 토큰, 개인정보를 커밋하지 않습니다.
- 설정이 필요하면 로컬 `.env`를 쓰고, 저장소에는 값이 비어 있거나 예시로
  채워진 `.env.example`만 커밋합니다.
- 프롬프트, 커밋 메시지, 문서에도 비밀값을 적지 않습니다.
- 배포 관련 자격 증명·플랫폼 설정은 Codex가 로컬에서 다루고, Claude에게는
  필요한 경우 정제된 요약만 전달합니다(`AGENTS.md` 기준).

## 7. 통합 상태

서버, 참조 클라이언트, React 클라이언트와 두 에이전트 브랜치는 모두 `main`에
통합됐습니다. 당시 순서와 근거는 이력 문서인
[`integration-plan.md`](./integration-plan.md) §3에 남겨 두었습니다.

| 단계 | 상태 |
| --- | --- |
| 1. `agent/claude`를 `main`에 병합 | **완료** |
| 2. `agent/codex`를 `main`에 병합 (`.gitignore`는 codex 버전 채택) | **완료** |
| 3. `shared/`를 `music-quiz`에 연결하고 `page.tsx`의 자체 정규화 함수 제거 | **완료** (Vite alias + tsconfig paths) |
| 4. 권위 서버 구현 | **완료** (`server/`) |
| 5. 클라이언트를 프로토콜 클라이언트로 전환 | **완료** — 참조 클라이언트(`client/`)와 `music-quiz` 양쪽 |
| 6. 방장 음원 등록 화면 | **완료** (`client/ui.ts`, `music-quiz`의 setup 화면, `POST /api/rooms`의 `media`) |
| 7. 60초 텍스트 라운드, 중간 힌트, 실시간 득점자 피드 | **완료** (`2784fc9`, `80e5918`) |

`music-quiz`는 살리기로 결정되었고, 포팅이 끝났습니다.
`client/protocolClient.ts`는 DOM도 프레임워크도 쓰지 않으므로 React
컴포넌트에서 그대로 `import`합니다. 연결 방식은 npm 워크스페이스가 아니라
`music-quiz/vite.config.ts`의 alias와 `tsconfig.json`의 `paths`입니다 —
의존성 방향을 한쪽으로만 두고, 의존성 없는 두 패키지를 위해 publish/build
단계를 만들지 않기 위해서입니다.

후속 기능도 같은 브랜치·검토·테스트 절차를 거쳐 `main`에 통합합니다
(`AGENTS.md` 기본 정책).

## 관련 문서

- [`../AGENTS.md`](../AGENTS.md) — 에이전트 공통 작업 정책 (이 문서의 §4, §5, §6의 원문)
- [`claude-analysis.md`](./claude-analysis.md) — 서버 아키텍처 근거
- [`realtime-protocol.md`](./realtime-protocol.md) — 메시지/상태 전이 규격
- [`integration-plan.md`](./integration-plan.md) — 병합 순서와 충돌 상세
- [`SONG_DATA_GUIDE.md`](./SONG_DATA_GUIDE.md) — 곡 데이터 스키마와 추출기 사용법
- [`OPERATIONS.md`](./OPERATIONS.md) — 배포·운영·보안 원칙
