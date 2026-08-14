# Drop the Beat — 노래 · 속담 · 사자성어 맞히기 게임

한 공간에 모여서 하는 퀴즈입니다. 참가자는 각자 폰으로 정답을 입력하고,
방장이 앞 컴퓨터에서 진행합니다. 최대 20명, 방장 1명이 진행하는 단일 방
구조입니다. 정답 판정은 전부 서버가 합니다.

**고를 모드가 없습니다.** 방 하나가 곧 한 판이고, 아래 세 구간을 순서대로
이어서 진행합니다.

| 순서 | 구간 | 화면에 나오는 것 | 정답으로 인정되는 것 | 기본 문항 수 | 득점 |
| --- | --- | --- | --- | --- | --- |
| 1 | **노래 맞히기** | 방장이 튼 하이라이트 (최대 1분) | 곡 제목 | 100곡 | 먼저 맞힌 **1명**이 1점, 그 즉시 라운드 종료 |
| 2 | **속담 맞히기** | 속담의 앞부분 | 뒷부분, 또는 속담 전체 | 30문제 | 먼저 맞힌 **3명까지** 각 1점 |
| 3 | **사자성어 맞히기** | 뜻풀이 | 한글 네 글자, 또는 한자 네 글자 | 30문제 | 먼저 맞힌 **3명까지** 각 1점 |

기본 구성은 **총 160문제, 약 2시간 30분**입니다. 방을 만든 뒤 설정 화면에서
구간별 문제 수를 바꿀 수 있고, `0`을 넣으면 그 구간을 건너뜁니다. 순서는
바꿀 수 없습니다.

속담·사자성어는 50문항 은행에서 방마다 새로 뽑아 섞습니다. 같은 저녁에 두 팀이
해도 문제 구성이 달라집니다.

라운드는 득점 자리가 다 차면 그 자리에서 끝나고, 그 전이면 마감 시간까지
열려 있습니다. 아무도 못 맞혀도 시간을 채우고 정답을 공개한 뒤 넘어갑니다.
속담·사자성어 한 문제는 30초입니다.

## 바로 실행하기

이 폴더의 **`게임시작.bat`을 더블클릭**하면 됩니다. 공개 주소가 하나 뜨는데,
참가자에게 그 주소와 화면에 표시되는 **참여 코드**를 알려 주면 끝입니다.
자세한 절차는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)에 있습니다.

> **주소는 실행할 때마다 새로 생깁니다.** 창을 닫으면 사라지므로 행사가
> 끝날 때까지 켜 두세요.

### 문제를 바꾸려면

처음 실행하면 **`문제`** 폴더가 생깁니다. **여기만 열어서 고치면 됩니다.**

```
새 폴더\
  게임시작.bat      ← 더블클릭
  문제\             ← 여기만 열면 됩니다
    곡목록.txt      노래 맞히기에 쓸 유튜브 링크 목록
    속담.json       속담 문제
    사자성어.json   사자성어 문제
```

메모장으로 열어 고치고 `게임시작.bat`을 다시 실행하면 그대로 반영됩니다.
이미 있는 파일은 절대 덮어쓰지 않으니, 행사 직전에 손본 목록이 사라질 걱정은
없습니다. 파일을 지우면 다음 실행 때 기본값으로 다시 만들어집니다.

## 현재 상태

| 구성 요소 | 위치 | 상태 |
| --- | --- | --- |
| 실시간 프로토콜 설계 (WebSocket 메시지, 상태 전이) | [`docs/realtime-protocol.md`](docs/realtime-protocol.md) | 설계 완료 |
| 아키텍처 분석 (권위 서버, 재접속, 보안) | [`docs/claude-analysis.md`](docs/claude-analysis.md) | 설계 완료 |
| 권위 게임 서버 (WebSocket) | [`server/`](server) | 구현·테스트 완료 |
| 방 생성·조회·곡 카탈로그 HTTP API | [`server/http.ts`](server/http.ts) | 구현·테스트 완료 |
| 정답 정규화 · 별칭 매칭 · 곡 카탈로그 검증 | [`shared/`](shared) | 구현·테스트 완료. 서버와 클라이언트가 같은 모듈을 씁니다 |
| 종류 공용 문제 모델 (노래·속담·사자성어) | [`shared/questions.ts`](shared/questions.ts) | 구현·테스트 완료. 라운드 엔진은 종류를 구분하지 않고, 문제마다 붙은 값을 따릅니다 |
| 속담·사자성어 문제 은행 (각 50문항) | [`data/proverbs.json`](data/proverbs.json), [`data/idioms.json`](data/idioms.json), [`server/questionBanks.ts`](server/questionBanks.ts) | 구현·테스트 완료. 서버에서만 읽고, 시작할 때 검증합니다 |
| 프로토콜 클라이언트 (재접속, 서버 시계 보정) | [`client/protocolClient.ts`](client/protocolClient.ts) | 구현·테스트 완료. 프레임워크 비의존 |
| 웹 클라이언트 (방장/참가자 전 화면) | [`client/`](client) | 구현 완료. 브라우저에서 종단 확인 |
| 두 브랜치를 합치는 순서와 충돌 목록 | [`docs/integration-plan.md`](docs/integration-plan.md) | 문서 완료, 병합은 사용자 승인 대기 |
| React 클라이언트 (`music-quiz/`) | [`music-quiz/app/page.tsx`](music-quiz/app/page.tsx) | 프로토타입에서 프로토콜 클라이언트로 포팅 완료. 브라우저 조작 확인은 미완 |
| 유튜브 재생 · 곡 자동 인식 | [`shared/youtube.ts`](shared/youtube.ts) | 구현·테스트 완료 |
| txt 플레이리스트 | [`shared/playlist.ts`](shared/playlist.ts), [`data/playlist.example.txt`](data/playlist.example.txt) | 구현·테스트 완료 |
| 공개 주소 실행 (Cloudflare 터널) | [`scripts/host.ts`](scripts/host.ts) | 실제 터널로 종단 확인 |

## 실행

Node.js 22.13 이상이 필요합니다. 설치할 의존성은 없습니다.

### 속담·사자성어만으로 진행 (준비물 없음)

문제는 서버가 이미 갖고 있으므로 곡 목록도, 음원도, 플레이리스트도 필요
없습니다. 서버만 켜고 방을 만든 뒤 **노래를 `0`으로** 두면 됩니다.

```bash
node server/main.ts --songs data/songs.recovered.json
```

브라우저로 <http://localhost:8787> 을 열고 **방 만들기**를 누른 뒤, 설정
화면에서 노래를 `0`으로 바꾸고 저장합니다. 재생 가능한 곡이 하나도 없으면
노래 구간은 어차피 0문제가 되므로, 그대로 두어도 속담·사자성어만 진행됩니다.

> `--songs` 는 노래 구간을 함께 쓸 때만 의미가 있습니다. 속담·사자성어만 할
> 거라면 아무 곡 파일이나 넘겨도 되고, 곡이 하나도 재생 가능하지 않아도
> 게임은 정상적으로 시작됩니다.

### 유튜브로 진행 (노래 구간, 권장)

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
| [`docs/GAME_RULES.md`](docs/GAME_RULES.md) | 게임 방식 — 진행 순서와 구간별 규칙, 라운드 길이, 점수·순위, 정답 판정 |
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
| **구현됨 (게임 구성)** | 한 방이 노래 → 속담 → 사자성어를 고정 순서로 진행, 구간별 문제 수를 방장이 지정(기본 100/30/30, 있는 만큼으로 보정, 0이면 건너뜀), 문제 종류별 라운드 길이와 득점 자리 수, 방마다 새로 섞는 문제 순서 |
| **구현됨 (서버)** | 방 상태 기계와 페이즈 전이, 서버 수신 시각 기준 선착순 판정, 방장 토큰 권한 검사, 오답 비공개, 정답 미노출, 일시정지 시간 보존, 세션 토큰 재접속, 순위 계산, Origin 검증, 라운드당 제출 제한, 방 생성 요청 빈도 제한, 방치된 방 회수 |
| **구현됨 (HTTP API)** | 방 생성(`POST /api/rooms`, 참여 코드와 방장 토큰 발급), 방 조회, 곡 카탈로그 조회, 방장 음원 등록, 유튜브 링크 조회·곡 자동 인식, 헬스 체크 |
| **구현됨 (유튜브 곡)** | 방장 화면에서만 재생, 영상 ID는 방장에게만 전송(제목이 곧 정답이므로), txt 플레이리스트, 영상 제목으로 곡 자동 인식, 임베드 차단 영상 안내 |
| **구현됨 (클라이언트)** | 방 만들기 화면의 진행 순서 안내와 구간별 문제 수 입력, 대기실의 구성 표시, 속담·사자성어 라운드의 단서 카드와 `현재 문제 / 30` 진행 표시, 정답 공개 시 빠진 부분·한자·뜻풀이와 득점자 순서, 방 만들기·참여·닉네임, 대기실과 준비 상태, 서버 기준 카운트다운·타이머, 클립·유튜브 재생, 정답 입력과 본인 전용 판정 결과, 방장 일시정지/재개/스킵, 정답 공개, 실시간 순위와 최종 시상대, 새로고침 후 이어하기 |
| **구현됨 (공용)** | 정답 정규화/별칭 매칭, 곡 카탈로그 검증·별칭 자동 확장, 유튜브 링크 파싱·곡 식별 — 서버와 클라이언트가 같은 파일을 가져다 씁니다 |
| **구현됨 (React UI)** | `music-quiz/`의 Next.js 화면 전체가 같은 서버·같은 프로토콜을 씁니다. 자체 정답 판정·자체 타이머·정답 노출·오답 브로드캐스트를 모두 제거했습니다 |
| **구현됨 (실행)** | Cloudflare 임시 터널로 공개 주소 발급, 그 주소를 `--origin`으로 넘겨 Origin 검사를 켠 채 실행 |
| **미구현** | 방 상태 영속화(프로세스 재시작 시 소멸), 브라우저에서의 실제 조작 검증(자동 재생 정책 포함), 음원 파일 방식용 라이선스 음원 |

기능별 상세는 [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) §5,
두 브랜치를 합치는 순서는 [`docs/integration-plan.md`](docs/integration-plan.md) §3에
있습니다.
