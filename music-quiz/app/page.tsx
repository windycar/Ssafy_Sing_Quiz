"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "lobby" | "game" | "results";

type Player = {
  id: number;
  nickname: string;
  score: number;
  correct: number;
  ready: boolean;
  avatar: string;
};

const initialPlayers: Player[] = [
  { id: 1, nickname: "리듬타는고양이", score: 2850, correct: 9, ready: true, avatar: "고" },
  { id: 2, nickname: "음악박사", score: 2420, correct: 8, ready: true, avatar: "음" },
  { id: 3, nickname: "새벽감성", score: 2180, correct: 7, ready: true, avatar: "새" },
  { id: 4, nickname: "멜론맛있다", score: 1940, correct: 6, ready: true, avatar: "멜" },
  { id: 5, nickname: "도레미파솔", score: 1760, correct: 6, ready: true, avatar: "도" },
  { id: 6, nickname: "노래는못참지", score: 1520, correct: 5, ready: true, avatar: "노" },
  { id: 7, nickname: "귀가쫑긋", score: 1410, correct: 5, ready: true, avatar: "귀" },
  { id: 8, nickname: "전주1초컷", score: 1320, correct: 4, ready: true, avatar: "전" },
  { id: 9, nickname: "케이팝수호자", score: 1180, correct: 4, ready: true, avatar: "케" },
  { id: 10, nickname: "오늘도정답", score: 1050, correct: 4, ready: true, avatar: "오" },
  { id: 11, nickname: "지니어스", score: 940, correct: 3, ready: true, avatar: "지" },
  { id: 12, nickname: "퇴근후한곡", score: 860, correct: 3, ready: true, avatar: "퇴" },
  { id: 13, nickname: "막귀탈출", score: 720, correct: 3, ready: true, avatar: "막" },
  { id: 14, nickname: "플레이리스트", score: 650, correct: 2, ready: true, avatar: "플" },
  { id: 15, nickname: "흥얼흥얼", score: 520, correct: 2, ready: true, avatar: "흥" },
  { id: 16, nickname: "저요저요", score: 430, correct: 2, ready: false, avatar: "저" },
  { id: 17, nickname: "마이크체크", score: 340, correct: 1, ready: true, avatar: "마" },
  { id: 18, nickname: "다음곡주세요", score: 220, correct: 1, ready: true, avatar: "다" },
  { id: 19, nickname: "첫참가", score: 100, correct: 1, ready: false, avatar: "첫" },
  { id: 20, nickname: "방장", score: 0, correct: 0, ready: true, avatar: "방" },
];

const recoveredSongs = [
  { title: "Dynamite", artist: "방탄소년단", aliases: ["dynamite", "다이나마이트"] },
  { title: "LOVE DIVE", artist: "아이브", aliases: ["love dive", "러브다이브"] },
  { title: "Celebrity", artist: "아이유", aliases: ["celebrity", "셀러브리티"] },
  { title: "TOMBOY", artist: "(여자)아이들", aliases: ["tomboy", "톰보이"] },
  { title: "롤린 (Rollin')", artist: "브레이브걸스", aliases: ["롤린", "rollin"] },
  { title: "사랑을 했다", artist: "iKON", aliases: ["사랑을했다", "love scenario"] },
];

const chatSeed = [
  { name: "음악박사", message: "이거 진짜 어디서 많이 들었는데", tone: "mint" },
  { name: "전주1초컷", message: "힌트 한번만요 👀", tone: "violet" },
  { name: "새벽감성", message: "잠깐만 거의 다 왔어", tone: "orange" },
  { name: "리듬타는고양이", message: "이번엔 내가 먼저 맞힌다", tone: "blue" },
];

function normalizeAnswer(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function isCorrectAnswer(value: string, aliases: string[]) {
  const normalized = normalizeAnswer(value);
  return aliases.some((alias) => normalizeAnswer(alias) === normalized);
}

export default function Home() {
  const [view, setView] = useState<View>("lobby");
  const [players, setPlayers] = useState(initialPlayers);
  const [round, setRound] = useState(12);
  const [remaining, setRemaining] = useState(12);
  const [paused, setPaused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState("");
  const [winner, setWinner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [chat, setChat] = useState(chatSeed);
  const [songCount, setSongCount] = useState(20);

  const ranked = useMemo(
    () => [...players].sort((a, b) => b.score - a.score || b.correct - a.correct),
    [players],
  );

  useEffect(() => {
    if (view !== "game" || paused || revealed) return;
    const timer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 0.1) {
          window.clearInterval(timer);
          setRevealed(true);
          setWinner(null);
          return 0;
        }
        return Math.max(0, Number((value - 0.1).toFixed(1)));
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [view, paused, revealed, round]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const startGame = () => {
    setView("game");
    setRound(12);
    setRemaining(12);
    setPaused(false);
    setRevealed(false);
    setWinner(null);
  };

  const nextRound = () => {
    if (round >= songCount) {
      setView("results");
      return;
    }
    setRound((value) => value + 1);
    setRemaining(12);
    setRevealed(false);
    setWinner(null);
    setAnswer("");
    setPaused(false);
  };

  const skipRound = () => {
    setRevealed(true);
    setWinner(null);
    setRemaining(0);
    setToast("방장이 현재 곡을 스킵했습니다");
  };

  const submitAnswer = (event: FormEvent) => {
    event.preventDefault();
    const value = answer.trim();
    if (!value || paused || revealed) return;

    if (isCorrectAnswer(value, recoveredSongs[0].aliases)) {
      setRevealed(true);
      setWinner("방장");
      setRemaining(0);
      setPlayers((current) =>
        current.map((player) =>
          player.nickname === "방장"
            ? { ...player, score: player.score + 320, correct: player.correct + 1 }
            : player,
        ),
      );
      setToast("정답입니다! +320점");
    } else {
      setChat((current) => [
        ...current.slice(-4),
        { name: "방장", message: value, tone: "lime" },
      ]);
    }
    setAnswer("");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("lobby")} aria-label="대기실로 이동">
          <span className="brand-mark"><i /><i /><i /></span>
          <span className="brand-copy"><b>DROP THE BEAT</b><small>ONLINE MUSIC QUIZ</small></span>
        </button>
        <nav className="demo-nav" aria-label="화면 미리보기">
          <button className={view === "lobby" ? "active" : ""} onClick={() => setView("lobby")}>대기실</button>
          <button className={view === "game" ? "active" : ""} onClick={() => setView("game")}>게임</button>
          <button className={view === "results" ? "active" : ""} onClick={() => setView("results")}>결과</button>
        </nav>
        <div className="top-actions">
          <span className="connection"><i /> 서버 연결됨 <b>28ms</b></span>
          <button className="room-code" onClick={() => { navigator.clipboard?.writeText("B7K2A"); setToast("방 코드가 복사되었습니다"); }}>
            <small>ROOM CODE</small><b>B7K2A</b><span>복사</span>
          </button>
          <div className="host-avatar">방</div>
        </div>
      </header>

      {view === "lobby" && (
        <section className="lobby page-enter">
          <div className="lobby-heading">
            <div><span className="eyebrow">WAITING ROOM · B7K2A</span><h1>모두 준비되면<br /><em>비트를 시작하세요.</em></h1></div>
            <div className="lobby-summary"><b>18<small>/20</small></b><span>READY PLAYERS</span></div>
          </div>

          <div className="lobby-grid">
            <section className="panel player-panel">
              <div className="panel-title"><div><span className="live-dot" /> 참가자 20명</div><span>18명 준비 완료</span></div>
              <div className="player-grid">
                {players.map((player) => (
                  <div className={`player-card ${player.ready ? "ready" : "waiting"}`} key={player.id}>
                    <div className={`avatar avatar-${(player.id % 5) + 1}`}>{player.avatar}</div>
                    <div><b>{player.nickname}</b><small>{player.id === 20 ? "HOST" : player.ready ? "READY" : "WAITING"}</small></div>
                    <span className="ready-state">{player.ready ? "✓" : "…"}</span>
                  </div>
                ))}
              </div>
            </section>

            <aside className="lobby-side">
              <section className="panel settings-card">
                <div className="panel-title"><div>게임 설정</div><span className="host-only">HOST ONLY</span></div>
                <label><span>출제 곡 수</span><b>{songCount}곡</b></label>
                <input type="range" min="10" max="40" step="5" value={songCount} onChange={(e) => setSongCount(Number(e.target.value))} />
                <div className="setting-row"><span>제한 시간</span><b>12초</b></div>
                <div className="setting-row"><span>힌트 공개</span><b>종료 5초 전</b></div>
                <div className="setting-row"><span>정답 공개</span><button className="switch on" aria-label="정답 공개 켜짐"><i /></button></div>
              </section>

              <section className="panel playlist-card">
                <div className="panel-title"><div>SCX에서 찾은 곡</div><span>{recoveredSongs.length} / 175</span></div>
                <div className="song-stack">
                  {recoveredSongs.slice(0, 4).map((song, index) => (
                    <div key={song.title}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{song.title}</b><small>{song.artist}</small></div><i>✓</i></div>
                  ))}
                </div>
                <button className="text-button" onClick={() => setToast("음원 URL 등록 화면은 다음 구현 단계입니다")}>+ 미디어 URL 연결하기</button>
              </section>

              <button className="start-button" onClick={startGame}><span>게임 시작</span><b>ENTER ↵</b></button>
            </aside>
          </div>
        </section>
      )}

      {view === "game" && (
        <section className="game-layout page-enter">
          <aside className="scoreboard panel">
            <div className="panel-title"><div><span className="live-dot" /> LIVE RANKING</div><span>TOP 5</span></div>
            <div className="rank-list">
              {ranked.slice(0, 5).map((player, index) => (
                <div className={`rank-item rank-${index + 1}`} key={player.id}>
                  <strong>{index + 1}</strong><div className={`avatar avatar-${(player.id % 5) + 1}`}>{player.avatar}</div>
                  <div><b>{player.nickname}</b><small>{player.correct}곡 정답</small></div><span>{player.score.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <div className="my-rank"><span>내 순위</span><b>{ranked.findIndex((p) => p.nickname === "방장") + 1}위</b><strong>{ranked.find((p) => p.nickname === "방장")?.score ?? 0} PTS</strong></div>
            <div className="legend"><span><i className="lime-dot" /> 실시간 반영</span><small>서버 판정 기준</small></div>
          </aside>

          <section className="stage">
            <div className="round-meta">
              <div><span>ROUND</span><b>{String(round).padStart(2, "0")}</b><i>/</i><strong>{songCount}</strong></div>
              <div className={`timer ${remaining <= 5 ? "urgent" : ""}`}><span>TIME LEFT</span><b>{remaining.toFixed(1)}</b><small>SEC</small></div>
            </div>

            <div className={`vinyl-stage ${paused ? "paused" : ""} ${revealed ? "revealed" : ""}`}>
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="vinyl"><span className="vinyl-label"><i>♪</i><b>{revealed ? "ANSWER" : paused ? "PAUSED" : "PLAYING"}</b></span></div>
              <div className="sound-pill"><span className="equalizer">{Array.from({ length: 18 }).map((_, i) => <i key={i} style={{ height: `${10 + ((i * 13) % 26)}px` }} />)}</span><b>{paused ? "일시정지" : revealed ? "정답 공개" : "하이라이트 재생 중"}</b></div>
            </div>

            {revealed ? (
              <div className="answer-reveal">
                <span>{winner ? "FIRST CORRECT ANSWER" : "ROUND ANSWER"}</span>
                <h2>Dynamite</h2><p>방탄소년단 · BTS</p>
                {winner && <div className="winner-chip"><i>1st</i><b>{winner}</b><span>+320 PTS</span></div>}
                <button onClick={nextRound}>{round >= songCount ? "최종 결과 보기" : "다음 라운드"}<b>→</b></button>
              </div>
            ) : (
              <div className="question-copy">
                <span className="genre-pill">K-POP · 2020</span>
                <h2>이 노래의 제목은?</h2>
                <p>{remaining <= 5 ? "힌트: 영어 제목 · 8글자" : "전주와 하이라이트를 듣고 정답을 입력하세요"}</p>
              </div>
            )}

            <div className="host-controls">
              <span><i /> HOST CONTROL</span>
              <button onClick={() => setPaused((value) => !value)} disabled={revealed}>{paused ? "▶ 계속" : "Ⅱ 일시정지"}</button>
              <button className="skip" onClick={skipRound} disabled={revealed}>현재 곡 스킵 <b>⇥</b></button>
            </div>
          </section>

          <aside className="chat-panel panel">
            <div className="panel-title"><div>LIVE CHAT</div><span><i className="live-dot" /> 20명</span></div>
            <div className="chat-notice"><b>TIP</b><span>띄어쓰기·대소문자·특수문자는 자동으로 무시됩니다.</span></div>
            <div className="chat-log">
              {chat.map((item, index) => (
                <div className="chat-message" key={`${item.name}-${index}`}><span className={`chat-avatar ${item.tone}`}>{item.name[0]}</span><div><b>{item.name}<small>방금</small></b><p>{item.message}</p></div></div>
              ))}
              {revealed && <div className="system-message"><i>✓</i><p><b>{winner ?? "방장"}</b>{winner ? "님이 정답을 맞혔습니다!" : "님이 현재 곡을 스킵했습니다."}</p></div>}
            </div>
            <form className="answer-form" onSubmit={submitAnswer}>
              <label htmlFor="answer">정답 입력</label>
              <div><input id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={revealed ? "라운드가 종료되었습니다" : "노래 제목을 입력하세요"} disabled={revealed || paused} autoComplete="off" /><button disabled={revealed || paused || !answer.trim()}>ENTER</button></div>
              <small><kbd>Enter</kbd> 키를 눌러 가장 빠르게 제출하세요</small>
            </form>
          </aside>
        </section>
      )}

      {view === "results" && (
        <section className="results page-enter">
          <div className="result-head"><span className="eyebrow">GAME COMPLETE · 20 ROUNDS</span><h1>오늘의 <em>음악 왕</em>이<br />결정되었습니다.</h1><p>2026. 08. 12 · ROOM B7K2A · 20 PLAYERS</p></div>
          <div className="podium">
            {[ranked[1], ranked[0], ranked[2]].map((player, index) => {
              const rank = index === 0 ? 2 : index === 1 ? 1 : 3;
              return <div className={`podium-place place-${rank}`} key={player.id}><span className="crown">{rank === 1 ? "♛" : "●"}</span><div className={`avatar avatar-${(player.id % 5) + 1}`}>{player.avatar}</div><b>{player.nickname}</b><small>{player.correct}곡 정답</small><strong>{player.score.toLocaleString()}<i> PTS</i></strong><div className="podium-block"><span>{rank}</span></div></div>;
            })}
          </div>
          <section className="final-table panel">
            <div className="panel-title"><div>FINAL RANKING</div><span>전체 20명</span></div>
            <div className="table-head"><span>순위</span><span>플레이어</span><span>맞힌 곡</span><span>정답률</span><span>최종 점수</span></div>
            <div className="table-body">
              {ranked.map((player, index) => (
                <div className={player.nickname === "방장" ? "me" : ""} key={player.id}><span>{String(index + 1).padStart(2, "0")}</span><span><i className={`avatar avatar-${(player.id % 5) + 1}`}>{player.avatar}</i><b>{player.nickname}</b>{player.nickname === "방장" && <small>YOU</small>}</span><span>{player.correct}곡</span><span>{Math.round((player.correct / songCount) * 100)}%</span><strong>{player.score.toLocaleString()}</strong></div>
              ))}
            </div>
          </section>
          <div className="result-actions"><button className="ghost-button" onClick={() => setView("lobby")}>대기실로 돌아가기</button><button className="start-button" onClick={startGame}><span>한 판 더</span><b>↻</b></button></div>
        </section>
      )}

      {toast && <div className="toast"><i>✓</i>{toast}</div>}
    </main>
  );
}

