# Drop the Beat — 온라인 노래 맞히기 게임

방장이 곡의 하이라이트를 재생하면 참가자가 먼저 정답을 맞히는 PC 전용 K-POP
노래 퀴즈 게임입니다. 최대 20명, 방장 1명이 진행하는 단일 방 구조입니다.

## 현재 상태

**이 브랜치(`agent/claude`)만으로 게임을 끝까지 플레이할 수 있습니다.** 서버를
띄우고 브라우저를 열면 방 만들기 → 참여 → 카운트다운 → 라운드 → 정답 공개 →
최종 순위까지 여러 명이 함께 진행됩니다. 정답 판정은 전부 서버가 합니다.

| 구성 요소 | 위치 | 상태 |
| --- | --- | --- |
| 실시간 프로토콜 설계 (WebSocket 메시지, 상태 전이) | [`docs/realtime-protocol.md`](docs/realtime-protocol.md) | 설계 완료 |
| 아키텍처 분석 (권위 서버, 재접속, 보안) | [`docs/claude-analysis.md`](docs/claude-analysis.md) | 설계 완료 |
| 권위 게임 서버 (WebSocket) | [`server/`](server) | 구현·테스트 완료 |
| 방 생성·조회·곡 카탈로그 HTTP API | [`server/http.ts`](server/http.ts) | 구현·테스트 완료 |
| 정답 정규화 · 별칭 매칭 · 곡 카탈로그 검증 | [`shared/`](shared) | 구현·테스트 완료. 서버와 클라이언트가 같은 모듈을 씁니다 |
| 프로토콜 클라이언트 (재접속, 서버 시계 보정) | [`client/protocolClient.ts`](client/protocolClient.ts) | 구현·테스트 완료. 프레임워크 비의존 |
| 웹 클라이언트 (방장/참가자 전 화면) | [`client/`](client) | 구현 완료. 브라우저에서 종단 확인 |
| 두 브랜치를 합치는 순서와 충돌 목록 | [`docs/integration-plan.md`](docs/integration-plan.md) | 문서 완료, 실행은 대기 중 |
| UI 프로토타입 (`music-quiz/`) | `agent/codex` 브랜치 | 단일 브라우저 데모, 서버 없음 |

남은 가장 큰 공백은 코드가 아니라 **음원**입니다. 아래 [실행](#실행)을 참고하세요.

## 실행

Node.js 22.13 이상이 필요합니다. 설치할 의존성은 없습니다.

```bash
cd server
node main.ts --songs ../../codex/data/songs.recovered.json
```

명령이 출력하는 주소(<http://localhost:8787>)를 브라우저로 열고 **방 만들기**를
누릅니다. 참가자에게는 화면에 표시되는 **참여 코드**나 참여 링크만 알려 주세요.
방장 링크에는 방장 권한 토큰이 들어 있으므로 공유하면 안 됩니다.

복구된 171곡에는 음원 URL이 없어 그대로는 재생 가능한 곡이 0곡입니다. 두 가지
방법이 있습니다.

- **실제로 플레이하려면**: 방장 화면의 **음원 등록**에서 곡별 음원 URL과 재생
  구간(5~15초)을 입력합니다. 라이선스가 확보된 음원만 사용하세요.
- **서버·화면 흐름만 확인하려면**: `--demo-clips`를 붙입니다. 자리표시자 URL을
  채워 라운드 루프가 돌아가지만 **소리는 나지 않습니다.**

자세한 조작법은 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md), 나머지 명령과
디렉터리 구조는 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)에 있습니다.

## 배포된 프로토타입 (별개)

<https://drop-the-beat-quiz.jyc686397.chatgpt.site>

비공개 배포이며 **`agent/codex`의 UI 프로토타입만** 보여줍니다. 이 배포에는
서버가 없어 여러 사람이 같은 방에서 함께 플레이할 수 없습니다. 위 [실행](#실행)
절차로 띄우는 것과 다른 물건입니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | 방장·참가자 조작 방법, 정답 표기 규칙, 문제 해결 |
| [`docs/SONG_DATA_GUIDE.md`](docs/SONG_DATA_GUIDE.md) | 곡 데이터 스키마, SCX 복구 결과와 한계, 별칭·검증 규칙 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 개발 환경, 실행·테스트 명령, 에이전트 워크플로 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 배포·보안·장애 대응 원칙, 출시 전 미완료 항목 |

설계 원본 문서: [`docs/claude-analysis.md`](docs/claude-analysis.md)
(아키텍처 분석) · [`docs/realtime-protocol.md`](docs/realtime-protocol.md)
(프로토콜 규격) · [`docs/integration-plan.md`](docs/integration-plan.md)
(두 브랜치 통합 계획).

## 지금 구현된 것 / 아직 구현되지 않은 것

| 구분 | 내용 |
| --- | --- |
| **구현됨 (서버)** | 방 상태 기계와 페이즈 전이, 서버 수신 시각 기준 선착순 판정, 방장 토큰 권한 검사, 오답 비공개, 정답 미노출, 일시정지 시간 보존, 세션 토큰 재접속, 순위 계산, Origin 검증, 라운드당 제출 제한, 방 생성 요청 빈도 제한, 방치된 방 회수 |
| **구현됨 (HTTP API)** | 방 생성(`POST /api/rooms`, 참여 코드와 방장 토큰 발급), 방 조회, 곡 카탈로그 조회, 방장 음원 등록, 헬스 체크 |
| **구현됨 (클라이언트)** | 방 만들기·참여·닉네임, 대기실과 준비 상태, 서버 기준 카운트다운·타이머, 클립 재생, 정답 입력과 본인 전용 판정 결과, 방장 일시정지/재개/스킵, 정답 공개, 실시간 순위와 최종 시상대, 새로고침 후 이어하기 |
| **구현됨 (공용)** | 정답 정규화/별칭 매칭, 곡 카탈로그 검증·별칭 자동 확장 — 서버와 클라이언트가 같은 파일을 가져다 씁니다 |
| **미구현** | 라이선스가 확보된 실제 음원(방장이 직접 등록해야 합니다), 방 상태 영속화(프로세스 재시작 시 소멸), `agent/codex`의 Next.js UI를 이 서버에 연결하는 작업 |

기능별 상세는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) §5,
두 브랜치를 합치는 순서는 [`docs/integration-plan.md`](docs/integration-plan.md) §3에
있습니다.
