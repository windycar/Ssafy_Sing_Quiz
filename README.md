# Drop the Beat — 노래 맞히기 게임

한 공간에 모여서 하는 노래 맞히기입니다. 방장이 앞 컴퓨터에서 곡을 틀면
스피커로 다 같이 듣고, 참가자는 각자 폰으로 정답을 입력합니다. 최대 20명,
방장 1명이 진행하는 단일 방 구조입니다.

먼저 맞힌 **1·2·3등이 100·50·30점**을 받습니다. 한 곡은 1분이고, 세 명이
맞히거나 1분이 지나면 다음 곡으로 넘어갑니다. 정답 판정은 전부 서버가 합니다.

## 바로 실행하기

`scripts/start-event.cmd`를 **더블클릭**하면 됩니다. 공개 주소가 하나 뜨는데,
참가자에게 그 주소와 화면에 표시되는 **참여 코드**를 알려 주면 끝입니다.
자세한 절차는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)에 있습니다.

> **주소는 실행할 때마다 새로 생깁니다.** 창을 닫으면 사라지므로 행사가
> 끝날 때까지 켜 두세요.

## 현재 상태

| 구성 요소 | 위치 | 상태 |
| --- | --- | --- |
| 실시간 프로토콜 설계 (WebSocket 메시지, 상태 전이) | [`docs/realtime-protocol.md`](docs/realtime-protocol.md) | 설계 완료 |
| 아키텍처 분석 (권위 서버, 재접속, 보안) | [`docs/claude-analysis.md`](docs/claude-analysis.md) | 설계 완료 |
| 권위 게임 서버 (WebSocket) | [`server/`](server) | 구현·테스트 완료 |
| 방 생성·조회·곡 카탈로그 HTTP API | [`server/http.ts`](server/http.ts) | 구현·테스트 완료 |
| 정답 정규화 · 별칭 매칭 · 곡 카탈로그 검증 | [`shared/`](shared) | 구현·테스트 완료. 서버와 클라이언트가 같은 모듈을 씁니다 |
| 프로토콜 클라이언트 (재접속, 서버 시계 보정) | [`client/protocolClient.ts`](client/protocolClient.ts) | 구현·테스트 완료. 프레임워크 비의존 |
| 웹 클라이언트 (방장/참가자 전 화면) | [`client/`](client) | 구현 완료. 브라우저에서 종단 확인 |
| 두 브랜치를 합치는 순서와 충돌 목록 | [`docs/integration-plan.md`](docs/integration-plan.md) | 문서 완료, 병합은 사용자 승인 대기 |
| React 클라이언트 (`music-quiz/`) | [`music-quiz/app/page.tsx`](music-quiz/app/page.tsx) | 프로토타입에서 프로토콜 클라이언트로 포팅 완료. 브라우저 조작 확인은 미완 |
| 유튜브 재생 · 곡 자동 인식 | [`shared/youtube.ts`](shared/youtube.ts) | 구현·테스트 완료 |
| txt 플레이리스트 | [`shared/playlist.ts`](shared/playlist.ts), [`data/playlist.example.txt`](data/playlist.example.txt) | 구현·테스트 완료 |
| 공개 주소 실행 (Cloudflare 터널) | [`scripts/host.ts`](scripts/host.ts) | 실제 터널로 종단 확인 |

## 실행

Node.js 22.13 이상이 필요합니다. 설치할 의존성은 없습니다.

### 유튜브로 진행 (권장)

곡 목록을 텍스트 파일에 적어 두고 서버에 넘깁니다. 형식과 예시는
[`data/playlist.example.txt`](data/playlist.example.txt)에 있습니다.

```bash
# 같은 네트워크에서만 (로컬)
node server/main.ts --playlist playlist.txt --songs data/songs.recovered.json

# 어디서나 접속 가능한 공개 주소로 (Cloudflare 임시 터널)
node scripts/host.ts --playlist playlist.txt --songs data/songs.recovered.json
```

한 줄에 한 곡을 적습니다. 링크만 적으면 영상 제목을 읽어 곡을 자동으로
찾아내고, `| 정답`을 덧붙이면 그대로 씁니다 — 후자는 곡 목록에 없는 노래도
가능합니다.

```
https://www.youtube.com/watch?v=9bZkp7q19f0
https://youtu.be/kJQP7kiw5Fk?t=60 | Despacito, 데스파시토
```

**노래는 방장 컴퓨터에서만 재생됩니다.** 참가자 기기에는 소리도 영상도 가지
않습니다 — 유튜브 플레이어가 영상 제목, 즉 정답을 그대로 보여주기 때문입니다.
그래서 이 방식은 스피커가 있는 한 공간에 모여 있을 때만 성립합니다.

서버는 켤 때 각 줄을 검사해서 잘못된 링크와 재생 불가한 영상을 **몇 번째
줄인지 찍어** 알려 줍니다. 행사 당일이 아니라 미리 한 번 켜 보세요.

### 음원 파일로 진행

각자 기기에서 소리가 나야 한다면 유튜브 대신 음원 파일을 씁니다. 복구된
171곡에는 음원 URL이 없으므로 방장 화면의 **음원 등록**에서 곡별 URL과 재생
구간(5~15초)을 채워야 합니다. 라이선스가 확보된 음원만 사용하세요.

```bash
node server/main.ts --songs data/songs.recovered.json

# 서버·화면 흐름만 확인 (자리표시자 URL, 소리는 나지 않습니다)
node server/main.ts --songs data/songs.recovered.json --demo-clips
```

명령이 출력하는 주소(<http://localhost:8787>)를 브라우저로 열고 **방 만들기**를
누릅니다. 참가자에게는 **참여 코드**나 참여 링크만 알려 주세요. 방장 링크에는
진행 권한 토큰이 들어 있으므로 공유하면 안 됩니다.

### React UI(`music-quiz/`)로 플레이하기

위 명령이 띄우는 것은 참조 클라이언트(`client/`)입니다. 같은 서버에 Next.js
화면을 붙이려면 프로세스를 하나 더 띄웁니다.

```bash
# 터미널 1 — 게임 서버
node server/main.ts --songs data/songs.recovered.json --origin http://localhost:3000

# 터미널 2 — React UI
cd music-quiz
VITE_GAME_SERVER=http://localhost:8787 npm run dev
```

두 화면은 같은 방·같은 판정을 공유합니다. 설정값의 의미는
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) §2에 있습니다.

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
| **구현됨 (HTTP API)** | 방 생성(`POST /api/rooms`, 참여 코드와 방장 토큰 발급), 방 조회, 곡 카탈로그 조회, 방장 음원 등록, 유튜브 링크 조회·곡 자동 인식, 헬스 체크 |
| **구현됨 (유튜브 모드)** | 방장 화면에서만 재생, 영상 ID는 방장에게만 전송(제목이 곧 정답이므로), txt 플레이리스트, 영상 제목으로 곡 자동 인식, 임베드 차단 영상 안내 |
| **구현됨 (클라이언트)** | 방 만들기·참여·닉네임, 대기실과 준비 상태, 서버 기준 카운트다운·타이머, 클립·유튜브 재생, 정답 입력과 본인 전용 판정 결과, 방장 일시정지/재개/스킵, 정답 공개, 실시간 순위와 최종 시상대, 새로고침 후 이어하기 |
| **구현됨 (공용)** | 정답 정규화/별칭 매칭, 곡 카탈로그 검증·별칭 자동 확장, 유튜브 링크 파싱·곡 식별 — 서버와 클라이언트가 같은 파일을 가져다 씁니다 |
| **구현됨 (React UI)** | `music-quiz/`의 Next.js 화면 전체가 같은 서버·같은 프로토콜을 씁니다. 자체 정답 판정·자체 타이머·정답 노출·오답 브로드캐스트를 모두 제거했습니다 |
| **구현됨 (실행)** | Cloudflare 임시 터널로 공개 주소 발급, 그 주소를 `--origin`으로 넘겨 Origin 검사를 켠 채 실행 |
| **미구현** | 방 상태 영속화(프로세스 재시작 시 소멸), 브라우저에서의 실제 조작 검증(자동 재생 정책 포함), 음원 파일 모드용 라이선스 음원 |

기능별 상세는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) §5,
두 브랜치를 합치는 순서는 [`docs/integration-plan.md`](docs/integration-plan.md) §3에
있습니다.
