# Drop the Beat — 온라인 노래 맞히기 게임

방장이 곡의 하이라이트를 재생하면 참가자가 먼저 정답을 맞히는 PC 전용 K-POP
노래 퀴즈 게임입니다. 최대 20명, 방장 1명이 진행하는 단일 방 구조를 목표로
합니다.

## 현재 상태

이 저장소는 Claude Code(`agent/claude`)와 Codex(`agent/codex`) 두 브랜치로
나뉘어 동시에 개발되고 있습니다. **지금 이 브랜치(`agent/claude`)에는 실행
가능한 게임 앱이 없습니다.** 여기에는 실시간 서버 설계 문서와, 서버·클라이언트가
공유할 정답 판정 로직(`shared/`)만 있습니다.

| 구성 요소 | 위치 | 상태 |
| --- | --- | --- |
| 실시간 프로토콜 설계 (WebSocket 메시지, 상태 전이) | [`docs/realtime-protocol.md`](docs/realtime-protocol.md) | 설계 완료 |
| 아키텍처 분석 (권위 서버, 재접속, 보안) | [`docs/claude-analysis.md`](docs/claude-analysis.md) | 설계 완료 |
| **권위 게임 서버 (WebSocket)** | [`server/`](server) | **구현 및 테스트 완료(54개). UI에는 아직 연결 안 됨** |
| 정답 정규화 · 별칭 매칭 · 곡 카탈로그 검증 | [`shared/answerMatching.ts`](shared/answerMatching.ts), [`shared/songCatalog.ts`](shared/songCatalog.ts) | 구현 및 테스트 완료. 서버가 사용 중 |
| 두 브랜치를 합치는 순서와 충돌 목록 | [`docs/integration-plan.md`](docs/integration-plan.md) | 문서 완료, 실행은 대기 중 |
| UI/게임 루프 프로토타입 (`music-quiz/`) | `agent/codex` 브랜치 (`.worktrees/codex/music-quiz`) | 단일 브라우저 데모, 서버 없음 |

즉 "게임을 실제로 플레이할 수 있는 화면"과 "서버가 판정하는 실시간 멀티플레이
설계"가 아직 하나로 연결되지 않은 상태입니다. 연결 순서는
[`docs/integration-plan.md`](docs/integration-plan.md)에 정리되어 있습니다.

## 배포된 프로토타입

<https://drop-the-beat-quiz.jyc686397.chatgpt.site>

비공개 배포이며 접근 권한이 있는 계정으로 로그인해야 열립니다. **이 배포는
`agent/codex`의 UI 프로토타입만 보여줍니다.** 서버가 없으므로 여러 사람이
같은 방에서 함께 플레이할 수 없고, 모든 상태는 접속한 브라우저 안에서만
동작합니다. 자세한 사용법과 "지금 되는 것 / 안 되는 것"은
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)를 참고하세요.

## 문서

| 문서 | 내용 |
| --- | --- |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | 배포된 프로토타입 접속·조작 방법, 방장/참가자 사용 흐름, 문제 해결 |
| [`docs/SONG_DATA_GUIDE.md`](docs/SONG_DATA_GUIDE.md) | 곡 데이터 스키마, SCX 복구 결과와 한계, 별칭·검증 규칙 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 개발 환경, 실행 명령, 에이전트(Claude/Codex) 워크플로, 서버 확장 순서 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 배포·보안·장애 대응 원칙, 출시 전 미완료 항목 |

설계 원본 문서: [`docs/claude-analysis.md`](docs/claude-analysis.md)
(아키텍처 분석) · [`docs/realtime-protocol.md`](docs/realtime-protocol.md)
(프로토콜 규격) · [`docs/integration-plan.md`](docs/integration-plan.md)
(두 브랜치 통합 계획).

## 가장 짧은 로컬 실행 절차

프로토타입 앱(`music-quiz/`)은 이 브랜치가 아니라 `agent/codex` 브랜치에
있습니다. 해당 워크트리에서 실행합니다.

```powershell
cd ..\codex\music-quiz   # 예: .worktrees 아래에 두 브랜치가 나란히 체크아웃된 구성
npm.cmd install
npm.cmd run dev
```

명령이 안내하는 로컬 주소를 브라우저로 열면 대기실 화면부터 시작됩니다.
설치 도구 확인, 나머지 명령(`test`/`lint`/`build`/`db:generate`), 디렉터리
구조는 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)에 있습니다.

## 지금 구현된 것 / 아직 구현되지 않은 것

| 구분 | 내용 |
| --- | --- |
| **구현됨** | 대기실·게임·결과 화면 이동, 출제 곡 수 설정, 0.1초 단위 로컬 타이머, 일시정지/스킵(내 화면 한정), 첫 번째 곡에 한정된 정답 입력·정규화 판정, 예시 데이터 기반 순위표·시상대 |
| **구현됨 (재사용 가능 모듈)** | 정답 정규화/별칭 매칭(`shared/answerMatching.ts`), 곡 카탈로그 검증·별칭 자동 확장(`shared/songCatalog.ts`) |
| **구현됨 (서버, UI 미연결)** | 권위 WebSocket 서버(`server/`): 방 상태 기계와 페이즈 전이, 서버 수신 시각 기준 선착순 판정, 방장 토큰 권한 검사, 오답 비공개, 정답 미노출, 일시정지 시간 보존, 세션 토큰 재접속, 순위 계산, Origin 검증, 라운드당 제출 제한 |
| **미구현** | 방을 만드는 HTTP API(현재는 서버 코드에서 `createRoom()` 호출로만 생성), UI와 서버 연결, 새로고침 후 이어하기의 클라이언트 쪽 처리 |
| **완전 미구현** | 실제 음원 재생(라이선스 확보 포함), 방 상태 영속화, 방 생성·참여 요청 빈도 제한 |

기능별 상세 표는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) §5,
서버로 확장하는 구체적 순서는 [`docs/integration-plan.md`](docs/integration-plan.md)
§3과 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)에 있습니다.
