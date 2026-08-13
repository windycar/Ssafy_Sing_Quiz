# 개발 가이드

이 저장소에서 개발 환경을 준비하고, 프로토타입을 실행·검증하고, 두 에이전트
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

## 2. 프로토타입 실행 명령

프로토타입 앱(`music-quiz/`)은 `agent/codex` 브랜치의
`.worktrees/codex/music-quiz`에 있습니다. 아래 명령은 실제
`music-quiz/package.json`에 정의된 스크립트만 사용합니다 — 이 목록에 없는
명령은 존재하지 않습니다.

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
(`music-quiz/.openai/hosting.json` 기준 `d1: null`, `r2: null`) — 지금
프로토타입은 데이터베이스를 실제로 쓰지 않습니다.

공용 로직(`shared/`)은 이 브랜치(`agent/claude`)에 있고 별도 테스트 스크립트를
가집니다.

```powershell
cd shared
npm.cmd test   # node --test *.test.ts — answerMatching, songCatalog 테스트
```

권위 게임 서버(`server/`)도 같은 방식으로 의존성 없이 돌아갑니다.

```powershell
cd server
npm.cmd test    # node --test *.test.ts — 엔진 단위 테스트 + 실제 소켓 종단 테스트
npm.cmd start -- --songs ..\..\codex\data\songs.recovered.json --demo-clips
```

`npm start`는 방 하나를 만들고 참여 코드와 방장 토큰을 출력합니다. 방을 만드는
HTTP 라우트가 아직 없기 때문이며, 이 공백은
[`integration-plan.md`](./integration-plan.md)에 기록되어 있습니다.
`--demo-clips`는 음원이 비어 있는 곡에 자리표시자를 채우는 개발 전용 옵션입니다
(소리는 나지 않습니다).

`server/`는 `node:http` 위에 RFC 6455 핸드셰이크와 프레이밍을 직접 구현합니다.
WebSocket 라이브러리를 받지 않는 이유는 `shared/`와 같습니다 — 설치 단계 없이
`node --test`만으로 검증할 수 있게 하기 위해서입니다. 서버를 코드에서 띄울 때는
다음과 같이 씁니다.

```ts
const running = startServer({ port: 8080, songs, allowedOrigins: ['https://…'] });
const room = running.game.createRoom(); // roomId(참여 코드)와 hostToken을 돌려줍니다
await running.stop();                   // 타이머 정리 + 소켓 드레이닝
```

타입 검사는 워크트리 루트의 `tsconfig.json`으로 `shared/`와 `server/`를 함께
확인합니다.

```powershell
npx tsc --noEmit -p .
```

의존성이 없으므로 `shared`에서는 `npm.cmd install`이 필요하지 않습니다. 현재
테스트는 27개(`answerMatching` 11개, `songCatalog` 16개)이며 모두 통과해야 합니다.
Node의 TypeScript 타입 제거 기능을 그대로 쓰기 때문에 **22.13 미만에서는 문법
오류로 실패합니다.**

> **알려진 빌드 문제.** `music-quiz/vite.config.ts`는 `./build/sites-vite-plugin`을
> 가져오는데, 저장소 루트 `.gitignore`의 `build/` 규칙 때문에 이 디렉터리가
> 커밋되어 있지 않습니다. 현재 `.worktrees/codex`에는 파일이 로컬에 남아 있어
> 동작하지만, 저장소를 새로 복제한 환경에서는 `npm.cmd run dev`와
> `npm.cmd run build`가 모듈을 찾지 못하고 실패합니다. 통합 전에 `.gitignore`
> 예외를 추가하거나 플러그인 의존을 제거해야 합니다.

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
| `shared/songCatalog.ts` | 원본 곡 레코드를 `SongConfig`로 검증·변환, 괄호 별칭 자동 확장 |
| `shared/*.test.ts` | 위 두 모듈의 단위 테스트 |

### `music-quiz/` (`agent/codex` 브랜치)

| 경로 | 역할 |
| --- | --- |
| `app/page.tsx` | 대기실/게임/결과 화면 전체를 담은 단일 클라이언트 컴포넌트. 로컬 상태로 타이머·정답 판정·순위를 계산하는 프로토타입 |
| `app/layout.tsx`, `app/globals.css` | 공통 레이아웃과 스타일 |
| `worker/index.ts` | Cloudflare Workers 진입점. 현재는 vinext 템플릿 그대로이며, 게임 전용 서버 로직은 없음 |
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

## 7. 프로토타입 → WebSocket 서버 확장 순서

`music-quiz/app/page.tsx`는 브라우저 로컬 상태만으로 동작하는 프로토타입이고,
`shared/`는 서버가 써야 할 판정 로직입니다. 이 둘을 실제 권위 서버로
연결하는 순서는 [`integration-plan.md`](./integration-plan.md) §3의 요약입니다.

1. `agent/claude`를 `main`에 먼저 병합합니다 (문서 + `shared/`, 실행 표면 없음).
2. `agent/codex`를 `main`에 병합합니다 (텍스트 충돌 없음, `.gitignore`는
   codex 버전을 채택).
3. npm 워크스페이스로 `shared/`를 `music-quiz`에 연결하고,
   `page.tsx`에 있는 자체 `normalizeAnswer`/`isCorrectAnswer`를 지우고
   `shared/answerMatching.ts`를 가져다 씁니다. 이 단계는 건너뛰거나 미루면
   안 됩니다 — 이후 서버가 별도 판정 규칙을 갖게 되는 것을 막는 단계입니다.
4. `realtime-protocol.md` §4의 상태 전이표와 `claude-analysis.md` §2의
   "방 하나 = 프로세스 하나의 인메모리 상태" 모델대로 권위 서버를 만듭니다.
   방 생성 시 `buildSongCatalog`, 라운드 시작 시 `createSongMatcher`를 씁니다.
5. 클라이언트를 프로토콜 클라이언트로 바꿉니다 — 로컬 타이머·로컬 정답
   판정·하드코딩된 정답 공개를 제거하고 서버 메시지로 상태를 그립니다.
   정답 입력과 채팅을 분리합니다.
6. 방장이 `mediaUrl`과 재생 구간을 등록하는 화면을 추가합니다. 이 화면이
   없으면 `buildSongCatalog`가 복구된 171곡을 전부 `MISSING_MEDIA_URL`로
   보고하므로 실제 데이터로는 게임을 진행할 수 없습니다.

1~3단계는 기계적인 작업이고, 4단계가 가장 큰 작업입니다. 4단계는 반드시
3단계 이후에 시작해야 합니다 — 그렇지 않으면 서버가 두 번째 판정 로직
사본을 기준으로 작성됩니다. 각 단계의 diff와 테스트 결과는 통합 전에
Codex가 검토합니다(`AGENTS.md` 기본 정책).

## 관련 문서

- [`../AGENTS.md`](../AGENTS.md) — 에이전트 공통 작업 정책 (이 문서의 §4, §5, §6의 원문)
- [`claude-analysis.md`](./claude-analysis.md) — 서버 아키텍처 근거
- [`realtime-protocol.md`](./realtime-protocol.md) — 메시지/상태 전이 규격
- [`integration-plan.md`](./integration-plan.md) — 병합 순서와 충돌 상세
- [`SONG_DATA_GUIDE.md`](./SONG_DATA_GUIDE.md) — 곡 데이터 스키마와 추출기 사용법
- [`OPERATIONS.md`](./OPERATIONS.md) — 배포·운영·보안 원칙
