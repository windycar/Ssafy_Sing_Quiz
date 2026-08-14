"use client";

/**
 * Drop the Beat — the prototype, converted into a real protocol client.
 *
 * This file used to judge answers in the browser, hold the answer in client
 * state, hardcode the reveal, run its own countdown, and append wrong guesses
 * to a shared chat log. Every one of those is a defect the protocol exists to
 * prevent, catalogued in docs/integration-plan.md §1. The visual language is
 * kept; the mechanics are now the server's:
 *
 * - §1.1 `normalizeAnswer` is imported from `@song-quiz/shared` — the module
 *   the server judges with — and is used only to show the player what their
 *   input reduces to. It decides nothing.
 * - §1.2 No aliases and no titles reach this file before `ROUND_REVEAL`.
 * - §1.3 There is no chat. A wrong guess is reported to its author alone.
 * - §1.4 The countdown renders `deadline - serverNow()`. It is never
 *   decremented locally.
 * - §1.5 No hint is derived from an answer this client does not have.
 * - §1.6 Points, round length, and ranking all come from the server.
 * - §1.7 Host actions carry a host token; the room code is issued by the
 *   server, not hardcoded.
 *
 * Player-supplied strings (nicknames, guesses) are rendered as JSX text, which
 * React escapes. Do not introduce `dangerouslySetInnerHTML` here.
 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProtocolClient } from "@song-quiz/client/protocolClient.ts";
import type { ClientState } from "@song-quiz/client/protocolClient.ts";
import { ApiError, createRoom, fetchCatalog, lookupRoom, setSetlist } from "@song-quiz/client/api.ts";
import type { SectionSummary, SongListEntry } from "@song-quiz/client/api.ts";
import { DEFAULT_SECTION_COUNTS, SECTION_ORDER } from "@song-quiz/server/index.ts";
import type { MediaRegistration } from "@song-quiz/shared/songCatalog.ts";
import type { ServerMessage } from "@song-quiz/server/protocol.ts";
import { normalizeAnswer } from "@song-quiz/shared/answerMatching.ts";
import { isTextMode, MODE_LABEL, MODE_PROMPT } from "@song-quiz/shared/questions.ts";
import type { GameMode } from "@song-quiz/shared/questions.ts";
import { apiBase, hostKey, readStorage, sessionKey, socketUrl, writeStorage } from "./gameServer";

type View = "home" | "setup" | "lobby" | "game" | "results";

type Draft = { mediaUrl: string; clipStart: string; clipEnd: string };

const AVATAR = (nickname: string): string => nickname.trim().slice(0, 1) || "?";

/** Only as many places as the server actually scores. */
const ORDINAL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };

/** One line of copy per section, on the running order shown before a room exists. */
const MODE_HINT: Record<GameMode, string> = {
  song: "하이라이트를 듣고 곡 제목을 맞힙니다.",
  proverb: "속담의 앞부분을 보고 뒷부분을 맞힙니다.",
  idiom: "뜻풀이를 보고 사자성어를 맞힙니다.",
};

/**
 * "노래 100 · 속담 30 · 사자성어 30 — 총 160문제" — the plan, in playing order.
 *
 * Sections the room will not play are dropped rather than shown as zero: a game
 * with no songs in it is a game of proverbs and idioms, and saying "노래 0"
 * invites the reader to wonder what went wrong.
 */
function describeSections(sections: readonly SectionSummary[], questionCount: number): string {
  const played = sections.filter((section) => section.count > 0);
  if (played.length === 0) return "출제할 문제가 없습니다.";
  const parts = played.map((section) => `${MODE_LABEL[section.mode]} ${section.count}`);
  return `${parts.join(" · ")} — 총 ${questionCount}문제`;
}

const ANSWER_PLACEHOLDER: Record<GameMode, string> = {
  song: "노래 제목을 입력하세요",
  proverb: "속담의 뒷부분을 입력하세요",
  idiom: "사자성어 네 글자를 입력하세요",
};

const CLUE_KIND: Record<GameMode, string> = {
  song: "K-POP",
  proverb: "속담",
  idiom: "사자성어",
};

const CLUE_HELP: Record<GameMode, string> = {
  song: "하이라이트를 듣고 정답을 입력하세요",
  proverb: "속담 전체를 적어도 되고, 빠진 뒷부분만 적어도 됩니다.",
  idiom: "한글 네 글자도, 한자 네 글자도 정답으로 인정됩니다.",
};

/**
 * How many people can score this mode's round, in words.
 *
 * Copy, not a rule: the rule is `POINTS_BY_PLACE` on the server, and this
 * screen only ever reports what it was told.
 */
const SCORING_NOTE: Record<GameMode, string> = {
  song: "가장 먼저 맞힌 1명 1점",
  proverb: "먼저 맞힌 3명까지 각 1점",
  idiom: "먼저 맞힌 3명까지 각 1점",
};

export default function Home() {
  const [state, setState] = useState<ClientState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [countdown, setCountdown] = useState(0);
  /** Seconds left before the server stops waiting for an absent host. */
  const [hostWait, setHostWait] = useState(0);

  // Host setup
  const [roomId, setRoomId] = useState<string | null>(null);
  const [hostToken, setHostToken] = useState<string | null>(null);
  /**
   * How many questions the host wants from each section.
   *
   * Only the setup screen needs it, and only before anyone has joined. What was
   * actually drawn comes back from the server and is written straight back in
   * here — 100 songs from a 40-song list is 40, and the box has to say so.
   */
  const [counts, setCounts] = useState<Record<GameMode, number>>({ ...DEFAULT_SECTION_COUNTS });
  /** What the server drew, in playing order. */
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [catalog, setCatalog] = useState<SongListEntry[]>([]);
  const [catalogNote, setCatalogNote] = useState("");
  const [setlistNote, setSetlistNote] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  // Join
  const [joinCode, setJoinCode] = useState("");
  const [nickname, setNickname] = useState("");

  const clientRef = useRef<ProtocolClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipEndRef = useRef<number | null>(null);
  const draftsRef = useRef(new Map<string, Draft>());
  const [audioNote, setAudioNote] = useState("");

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // --- Clip playback ------------------------------------------------------
  // Audio failure never stalls the game: the deadline is server-owned, so a
  // clip that will not load costs the player the clip, not the round.

  const playClip = useCallback(async (url: string, startMs: number, endMs: number) => {
    const audio = audioRef.current;
    if (audio === null) return;
    clipEndRef.current = endMs / 1000;
    setAudioNote("음원을 불러오는 중…");

    if (audio.src !== url) audio.src = url;
    try {
      if (audio.readyState < 1) {
        await new Promise<void>((resolve) => {
          const done = () => {
            audio.removeEventListener("loadedmetadata", done);
            audio.removeEventListener("error", done);
            resolve();
          };
          audio.addEventListener("loadedmetadata", done);
          audio.addEventListener("error", done);
        });
      }
      try {
        audio.currentTime = startMs / 1000;
      } catch {
        /* non-seekable source */
      }
      await audio.play();
      setAudioNote("");
    } catch {
      // Overwhelmingly the browser's autoplay policy, which needs a gesture.
      setAudioNote("브라우저가 자동 재생을 막았습니다. 아래 재생 버튼을 눌러 주세요.");
    }
  }, []);

  const onServerEvent = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "ROUND_START":
          // A proverb or idiom round has no media at all; its clue is the text
          // already on screen.
          if (message.question.mode === "song" && !message.livePlayback) {
            void playClip(message.mediaUrl, message.clipStartMs, message.clipEndMs);
          }
          break;
        case "ROUND_PAUSED":
          audioRef.current?.pause();
          break;
        case "ROUND_RESUMED":
          void audioRef.current?.play().catch(() => undefined);
          break;
        case "ROUND_REVEAL":
        case "GAME_OVER":
          audioRef.current?.pause();
          setAudioNote("");
          break;
        case "ERROR":
          setToast(message.message);
          break;
        default:
          break;
      }
    },
    [playClip],
  );

  const connect = useCallback(
    (room: string, options: { nickname?: string; playerToken?: string | null }) => {
      clientRef.current?.disconnect();
      const token = readStorage(hostKey(room));
      setHostToken(token);
      setRoomId(room);

      const client = new ProtocolClient({
        url: socketUrl(),
        roomId: room,
        nickname: options.nickname,
        playerToken: options.playerToken ?? null,
        hostToken: token,
        onToken: (issued) => writeStorage(sessionKey(room), issued),
        onStateChange: setState,
        onEvent: onServerEvent,
      });
      clientRef.current = client;
      client.connect();
    },
    [onServerEvent],
  );

  // --- Restore a session from the URL and storage --------------------------

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const room = hash.get("room");
    if (room === null) return;

    // The host token travels in the fragment, which browsers never send to the
    // server, and is stripped from the visible URL as soon as it is stored.
    const linked = hash.get("host");
    if (linked !== null) {
      writeStorage(hostKey(room), linked);
      window.history.replaceState(null, "", `#room=${encodeURIComponent(room)}`);
    }

    const session = readStorage(sessionKey(room));
    if (session !== null) {
      connect(room, { playerToken: session });
      return;
    }

    const host = readStorage(hostKey(room));
    if (host !== null) {
      setRoomId(room);
      setHostToken(host);
      // The setlist lives on the room, not in this tab, so a refresh asks the
      // server what was drawn rather than showing this build's defaults.
      void (async () => {
        try {
          const found = await lookupRoom(room, apiBase());
          applyDrawnSections(found.sections, found.questionCount);
        } catch {
          /* a convenience; the defaults stay on screen and saving replaces them */
        }
        await loadCatalog(room, host);
      })();
      return;
    }
    setJoinCode(room);
    // The effect intentionally runs once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clientRef.current?.disconnect(), []);

  // --- Server-owned clocks -------------------------------------------------

  useEffect(() => {
    const timer = window.setInterval(() => {
      const client = clientRef.current;
      if (client === null) return;
      setRemaining(client.remainingMs() ?? 0);

      const startsAt = client.getState().countdownStartsAt;
      setCountdown(startsAt === null ? 0 : Math.max(0, Math.ceil((startsAt - client.serverNow()) / 1000)));

      // How long the server will keep waiting for a host who dropped out. Read
      // on the same clock as everything else, so a frozen round shows a number
      // going down rather than a screen that looks broken.
      const endsAt = client.getState().round?.hostGraceEndsAt ?? null;
      setHostWait(endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - client.serverNow()) / 1000)));
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  // --- Host setup ----------------------------------------------------------

  async function loadCatalog(room: string, token: string): Promise<void> {
    try {
      const response = await fetchCatalog(room, token, apiBase());
      setCatalog(response.songs);
      setCatalogNote(
        `전체 ${response.total}곡 중 재생 가능 ${response.playableCount}곡.` +
          (response.playableCount === 0 ? " 음원을 등록해야 게임을 시작할 수 있습니다." : ""),
      );
    } catch (error) {
      setCatalogNote(error instanceof ApiError ? error.message : "곡 목록을 불러오지 못했습니다.");
    }
  }

  /** Writes back what the server drew, which is not always what was asked for. */
  function applyDrawnSections(drawn: readonly SectionSummary[], total: number): void {
    setSections([...drawn]);
    setQuestionCount(total);
    setCounts((current) => {
      const next = { ...current };
      for (const section of drawn) next[section.mode] = section.count;
      return next;
    });
  }

  const onCreateRoom = async (): Promise<void> => {
    setBusy(true);
    try {
      // The room comes first: the catalog is host-authorized, and there is no
      // host token until the room exists. Nothing is chosen here — every room
      // plays the same three sections in the same order, and the server draws
      // its defaults. The setup screen only changes how many of each.
      const created = await createRoom({}, apiBase());
      writeStorage(hostKey(created.roomId), created.hostToken);
      setRoomId(created.roomId);
      setHostToken(created.hostToken);
      applyDrawnSections(created.sections, created.questionCount);
      setSetlistNote("");
      window.location.hash = `room=${encodeURIComponent(created.roomId)}`;
      await loadCatalog(created.roomId, created.hostToken);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "방을 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const onSaveSetlist = async (): Promise<void> => {
    if (roomId === null || hostToken === null) return;
    const media: MediaRegistration[] = [];
    let skipped = 0;
    for (const [id, draft] of draftsRef.current) {
      const clipStart = Number(draft.clipStart);
      const clipEnd = Number(draft.clipEnd);
      const complete =
        draft.mediaUrl !== "" &&
        draft.clipStart !== "" &&
        draft.clipEnd !== "" &&
        Number.isFinite(clipStart) &&
        Number.isFinite(clipEnd) &&
        clipEnd > clipStart;
      if (complete) media.push({ id, mediaUrl: draft.mediaUrl, clipStart, clipEnd });
      else skipped += 1;
    }

    setBusy(true);
    try {
      const setlist = await setSetlist(roomId, hostToken, { counts, media }, apiBase());
      applyDrawnSections(setlist.sections, setlist.questionCount);

      const songs = setlist.sections.find((section) => section.mode === "song")?.count ?? 0;
      setSetlistNote(
        setlist.questionCount === 0
          ? "출제할 문제가 없습니다. 음원을 등록하거나 문제 수를 올려 주세요."
          : `${setlist.questionCount}문제로 진행합니다.` +
            (songs === 0
              ? ""
              : ` (재생 가능 ${setlist.playableCount}곡` +
                (skipped > 0 ? `, 입력이 덜 된 ${skipped}곡 제외` : "") +
                ")"),
      );
      if (setlist.registrationIssues.length > 0) {
        setToast(`등록한 음원 중 ${setlist.registrationIssues.length}곡이 조건을 만족하지 않았습니다.`);
      }
      await loadCatalog(roomId, hostToken);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "곡 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const code = joinCode.trim();
    const name = nickname.trim();
    if (code === "" || name === "") return;
    try {
      const room = await lookupRoom(code, apiBase());
      if (!room.joinable) {
        setToast("이미 시작된 방에는 참여할 수 없습니다.");
        return;
      }
      if (!room.ready) setToast("방장이 아직 문제를 고르는 중입니다.");
      else setToast(`${MODE_LABEL[room.mode]} 방에 들어갑니다.`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "방을 확인하지 못했습니다.");
      return;
    }
    connect(code, { nickname: name });
  };

  const onSubmitAnswer = (event: FormEvent): void => {
    event.preventDefault();
    const guess = answer.trim();
    const client = clientRef.current;
    if (guess === "" || client === null) return;
    if (!client.submitAnswer(guess)) {
      setToast("서버와 연결되어 있지 않아 정답을 보내지 못했습니다.");
      return;
    }
    setAnswer("");
  };

  // --- Derived view --------------------------------------------------------

  const view: View = useMemo(() => {
    if (state !== null && state.playerId !== null) {
      if (state.phase === "FINISHED") return "results";
      if (state.phase === "LOBBY") return "lobby";
      return "game";
    }
    return roomId !== null && hostToken !== null ? "setup" : "home";
  }, [state, roomId, hostToken]);

  const isHost = hostToken !== null;
  const players = state?.players ?? [];
  const leaderboard = state?.leaderboard ?? [];
  const round = state?.round ?? null;
  const inviteLink = roomId === null ? "" : `${window.location.origin}/#room=${encodeURIComponent(roomId)}`;

  // In a live room the mode is whatever the server said; on the setup screen it
  // is the mode the server recorded when the room was created. Never a guess.
  /**
   * What to say about a stopped round, or null when it is running.
   *
   * A frozen screen with no explanation reads as a broken game. There are two
   * pauses and they mean different things to a player: one is the host taking a
   * break, the other is the host's connection dropping — and only the second
   * one has the server counting down to a decision.
   */
  const pauseNotice: string | null =
    round === null || !round.paused
      ? null
      : !round.hostAway
        ? "방장이 라운드를 잠시 멈췄습니다."
        : round.livePlayback
          ? `방장 연결이 끊겼습니다. ${hostWait}초 안에 돌아오지 않으면 게임이 여기서 종료됩니다.`
          : `방장 연결이 끊겼습니다. ${hostWait}초 뒤 자동으로 이어집니다.`;

  // The live round's own kind first; the room's next-up kind between rounds.
  // Songs open every game, so that is the fallback before any of it arrives.
  const mode: GameMode = round?.question.mode ?? state?.mode ?? "song";
  const textMode = isTextMode(mode);
  const totalQuestions = round?.question.totalQuestions ?? state?.totalQuestions ?? 0;
  const reveal = state?.reveal ?? null;

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched =
      needle === ""
        ? catalog
        : catalog.filter(
            (song) =>
              song.title.toLowerCase().includes(needle) || song.artist.toLowerCase().includes(needle),
          );
    return matched.slice(0, 60);
  }, [catalog, filter]);

  const copy = (text: string, label: string): void => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setToast(`${label}을(를) 복사했습니다.`))
      .catch(() => setToast("복사에 실패했습니다."));
  };

  const hostAction = (run: () => boolean | undefined): void => {
    if (run() === false) setToast("서버와 연결되어 있지 않습니다.");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-copy">
            <b>DROP THE BEAT</b>
            <small>ONLINE MUSIC QUIZ</small>
          </span>
        </div>
        <div className="top-actions">
          <span className="connection">
            <i /> {connectionLabel(state)}
          </span>
          {roomId !== null && (
            <button className="room-code" onClick={() => copy(inviteLink, "참여 링크")}>
              <small>ROOM CODE</small>
              <b>{roomId}</b>
              <span>복사</span>
            </button>
          )}
        </div>
      </header>

      {view === "home" && (
        <section className="lobby page-enter">
          <div className="lobby-heading">
            <div>
              <span className="eyebrow">ONLINE MUSIC QUIZ</span>
              <h1>
                방에 들어가
                <br />
                <em>비트를 맞히세요.</em>
              </h1>
            </div>
          </div>
          <div className="lobby-grid">
            <section className="panel player-panel">
              <div className="panel-title">
                <div>방 참여</div>
              </div>
              <form className="answer-form" onSubmit={onJoin}>
                <label htmlFor="join-code">참여 코드</label>
                <div>
                  <input
                    id="join-code"
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <label htmlFor="join-nickname">닉네임</label>
                <div>
                  <input
                    id="join-nickname"
                    value={nickname}
                    maxLength={16}
                    onChange={(event) => setNickname(event.target.value)}
                    autoComplete="off"
                  />
                  <button disabled={joinCode.trim() === "" || nickname.trim() === ""}>참여</button>
                </div>
              </form>
            </section>
            <aside className="lobby-side">
              <section className="panel settings-card">
                <div className="panel-title">
                  <div>방 만들기</div>
                  <span className="host-only">HOST</span>
                </div>
                <p>방장은 게임을 진행합니다. 참가자에게는 참여 코드만 알려 주세요.</p>
                {/* 고를 모드가 없습니다. 한 방이 곧 한 게임이고, 아래 순서대로
                    끝까지 이어서 진행합니다. 몇 문제씩 낼지는 방을 만든 뒤
                    설정 화면에서 조절합니다. */}
                <ol className="section-plan">
                  {SECTION_ORDER.map((option) => (
                    <li key={option}>
                      <b>{MODE_LABEL[option]}</b>
                      <small>{MODE_HINT[option]}</small>
                    </li>
                  ))}
                </ol>
              </section>
              <button className="start-button" onClick={() => void onCreateRoom()} disabled={busy}>
                <span>방 만들기</span>
                <b>NEW</b>
              </button>
            </aside>
          </div>
        </section>
      )}

      {view === "setup" && (
        <section className="lobby page-enter">
          <div className="lobby-heading">
            <div>
              <span className="eyebrow">HOST SETUP · {roomId}</span>
              <h1>
                문제 수를 정하고
                <br />
                <em>방에 입장하세요.</em>
              </h1>
              <p className="mode-badge">{describeSections(sections, questionCount)}</p>
            </div>
          </div>

          <div className="lobby-grid">
            {/* 노래 구간에만 쓰입니다. 노래를 0문제로 두면 필요 없지만, 어느 곡이
                왜 빠졌는지 확인하는 곳이기도 해서 항상 보여 줍니다. */}
            <section className="panel playlist-card">
                <div className="panel-title">
                  <div>음원 등록</div>
                  <span>{catalogNote}</span>
                </div>
                <p>
                  음원 URL과 재생 구간(5~15초)을 입력하세요. <b>저작권이 확보된 음원만</b> 사용해야 합니다.
                  여기 입력한 값은 이 방에만 적용되며 서버에 저장되지 않습니다.
                </p>
                <input
                  type="search"
                  placeholder="곡 제목 또는 가수 검색"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <div className="song-stack">
                  {filtered.map((song) => (
                    <SongRow key={song.id} song={song} drafts={draftsRef.current} />
                  ))}
                </div>
            </section>

            <aside className="lobby-side">
              <section className="panel settings-card">
                <div className="panel-title">
                  <div>게임 설정</div>
                  <span className="host-only">HOST ONLY</span>
                </div>
                {/* 순서는 고정입니다. 방장이 정하는 것은 각 구간의 문제 수뿐이고,
                    0을 넣으면 그 구간을 건너뜁니다. */}
                <p>아래 순서대로 한 판에 이어서 진행합니다.</p>
                {SECTION_ORDER.map((option, index) => (
                  <div className="setting-row" key={option}>
                    <span>
                      {index + 1}. {MODE_LABEL[option]}
                    </span>
                    <input
                      type="number"
                      min="0"
                      max={option === "song" ? 100 : 50}
                      value={counts[option]}
                      onChange={(event) =>
                        setCounts((current) => ({ ...current, [option]: Number(event.target.value) || 0 }))
                      }
                    />
                  </div>
                ))}
                <button className="text-button" onClick={() => void onSaveSetlist()} disabled={busy}>
                  문제 수 저장
                </button>
                {setlistNote !== "" && <p>{setlistNote}</p>}
              </section>

              <section className="panel settings-card">
                <div className="panel-title">
                  <div>초대</div>
                </div>
                <div className="setting-row">
                  <span>참여 링크</span>
                  <button className="text-button" onClick={() => copy(inviteLink, "참여 링크")}>
                    복사
                  </button>
                </div>
                <div className="setting-row">
                  <span>방장 링크 (공유 금지)</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      hostToken !== null &&
                      copy(`${inviteLink}&host=${encodeURIComponent(hostToken)}`, "방장 링크")
                    }
                  >
                    복사
                  </button>
                </div>
                <p>방장 링크에는 게임을 진행할 수 있는 권한 토큰이 들어 있습니다.</p>
              </section>

              <form
                className="answer-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (roomId !== null) connect(roomId, { nickname: nickname.trim() || "방장" });
                }}
              >
                <label htmlFor="host-nickname">방장 닉네임</label>
                <div>
                  <input
                    id="host-nickname"
                    value={nickname}
                    maxLength={16}
                    placeholder="방장"
                    onChange={(event) => setNickname(event.target.value)}
                  />
                  <button>입장</button>
                </div>
              </form>
            </aside>
          </div>
        </section>
      )}

      {view === "lobby" && (
        <section className="lobby page-enter">
          <div className="lobby-heading">
            <div>
              <span className="eyebrow">WAITING ROOM · {roomId}</span>
              <h1>
                모두 준비되면
                <br />
                <em>게임을 시작하세요.</em>
              </h1>
              {/* 서버가 ROOM_STATE 로 알려 준 진행 계획. 이 화면이 정하지 않습니다. */}
              <p className="mode-badge">
                {describeSections(state?.sections ?? [], state?.totalQuestions ?? 0)}
              </p>
            </div>
            <div className="lobby-summary">
              <b>
                {players.filter((player) => player.ready).length}
                <small>/{players.length}</small>
              </b>
              <span>READY PLAYERS</span>
            </div>
          </div>

          <div className="lobby-grid">
            <section className="panel player-panel">
              <div className="panel-title">
                <div>
                  <span className="live-dot" /> 참가자 {players.length}명
                </div>
                <span>{players.filter((player) => player.ready).length}명 준비 완료</span>
              </div>
              <div className="player-grid">
                {players.map((player, index) => (
                  <div
                    className={`player-card ${player.ready ? "ready" : "waiting"}`}
                    key={player.id}
                    style={player.connected ? undefined : { opacity: 0.45 }}
                  >
                    <div className={`avatar avatar-${(index % 5) + 1}`}>{AVATAR(player.nickname)}</div>
                    <div>
                      <b>{player.nickname}</b>
                      <small>{!player.connected ? "OFFLINE" : player.ready ? "READY" : "WAITING"}</small>
                    </div>
                    <span className="ready-state">{player.ready ? "✓" : "…"}</span>
                  </div>
                ))}
              </div>
            </section>

            <aside className="lobby-side">
              <section className="panel settings-card">
                <div className="panel-title">
                  <div>내 상태</div>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    const client = clientRef.current;
                    if (client === null) return;
                    const me = players.find((player) => player.id === state?.playerId);
                    client.setReady(me?.ready !== true);
                  }}
                >
                  {players.find((player) => player.id === state?.playerId)?.ready === true
                    ? "준비 해제"
                    : "준비"}
                </button>
                <p>
                  {isHost
                    ? "준비 상태와 관계없이 방장이 언제든 시작할 수 있습니다."
                    : "방장이 시작할 때까지 기다려 주세요."}
                </p>
              </section>

              {isHost && (
                <button
                  className="start-button"
                  onClick={() => hostAction(() => clientRef.current?.hostStart())}
                >
                  <span>게임 시작</span>
                  <b>ENTER ↵</b>
                </button>
              )}
            </aside>
          </div>
        </section>
      )}

      {(view === "game" || view === "results") && (
        <audio ref={audioRef} preload="auto" style={{ display: "none" }} />
      )}

      {view === "game" && (
        <section className="game-layout page-enter">
          <aside className="scoreboard panel">
            <div className="panel-title">
              <div>
                <span className="live-dot" /> LIVE RANKING
              </div>
              <span>TOP 5</span>
            </div>
            <div className="rank-list">
              {leaderboard.slice(0, 5).map((entry, index) => (
                <div className={`rank-item rank-${index + 1}`} key={entry.playerId}>
                  <strong>{entry.rank}</strong>
                  <div className={`avatar avatar-${(index % 5) + 1}`}>{AVATAR(entry.nickname)}</div>
                  <div>
                    <b>{entry.nickname}</b>
                  </div>
                  <span>{entry.score.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <div className="my-rank">
              <span>내 순위</span>
              <b>{state?.you?.rank ?? "-"}위</b>
              <strong>{state?.you?.score ?? 0} PTS</strong>
            </div>
            <div className="legend">
              <span>
                <i className="lime-dot" /> 서버 판정
              </span>
              <small>{SCORING_NOTE[mode]}</small>
            </div>
          </aside>

          <section className="stage">
            <div className="round-meta">
              <div>
                <span>{textMode ? "문제" : "ROUND"}</span>
                <b>{String((round?.question.index ?? 0) + 1).padStart(2, "0")}</b>
                <i>/</i>
                <strong>{totalQuestions}</strong>
              </div>
              <div className={`timer ${remaining <= 5000 ? "urgent" : ""}`}>
                <span>TIME LEFT</span>
                {/* Rendered from the server's deadline; never decremented here. */}
                <b>{(remaining / 1000).toFixed(1)}</b>
                <small>SEC</small>
              </div>
            </div>

            {/* The media stage and the clue card are the same slot: exactly one
                of them belongs on screen, decided by the mode the server named. */}
            {textMode ? (
              <div className="clue-card">
                {state?.phase === "COUNTDOWN" && <b className="clue-countdown">{countdown}</b>}
                <span className="genre-pill">{CLUE_KIND[mode]}</span>
                {/* Whatever the server sent as the clue, and nothing else.
                    During COUNTDOWN there is no round yet. */}
                <p className="clue-text">{round?.question.clue ?? ""}</p>
                <small>{round?.paused === true ? "일시정지" : CLUE_HELP[mode]}</small>
              </div>
            ) : (
              <div
                className={`vinyl-stage ${round?.paused === true ? "paused" : ""} ${
                  state?.phase === "REVEAL" ? "revealed" : ""
                }`}
              >
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="vinyl">
                  <span className="vinyl-label">
                    <i>♪</i>
                    <b>
                      {state?.phase === "COUNTDOWN"
                        ? countdown
                        : state?.phase === "REVEAL"
                          ? "ANSWER"
                          : round?.paused === true
                            ? "PAUSED"
                            : "PLAYING"}
                    </b>
                  </span>
                </div>
                <div className="sound-pill">
                  <span className="equalizer">
                    {Array.from({ length: 18 }).map((_, index) => (
                      <i key={index} style={{ height: `${10 + ((index * 13) % 26)}px` }} />
                    ))}
                  </span>
                  <b>
                    {state?.phase === "COUNTDOWN"
                      ? "곧 시작합니다"
                      : state?.phase === "REVEAL"
                        ? "정답 공개"
                        : round?.paused === true
                          ? "일시정지"
                          : "하이라이트 재생 중"}
                  </b>
                </div>
              </div>
            )}

            {pauseNotice !== null && <p className="pause-notice">{pauseNotice}</p>}

            {state?.phase === "REVEAL" && reveal !== null ? (
              <div className="answer-reveal">
                <span>{textMode ? `${CLUE_KIND[reveal.answer.mode]} 정답` : "ROUND ANSWER"}</span>
                {/* The first moment any of the answer exists on this client.
                    For a proverb the prefix that was already on screen is drawn
                    dimmed, so the half players had to supply is unmistakable. */}
                <h2>
                  {reveal.answer.mode === "proverb" ? (
                    <>
                      <span id="reveal-known">{reveal.answer.clue} </span>
                      <span id="reveal-title">{reveal.answer.detail}</span>
                    </>
                  ) : (
                    <span id="reveal-title">{reveal.answer.answer}</span>
                  )}
                </h2>
                {reveal.answer.artist !== null && <p>{reveal.answer.artist}</p>}
                {reveal.answer.mode === "idiom" && (
                  <p className="reveal-detail">
                    {[reveal.answer.hanja, reveal.answer.detail].filter((part) => part).join(" · ")}
                  </p>
                )}
                {reveal.scorers.length === 0 && <p>아무도 맞히지 못했습니다.</p>}
                {/* Every scorer, not just the winner: second and third earned
                    points too and should see themselves named, in order. */}
                {reveal.scorers.map((entry) => (
                  <div className="winner-chip" key={entry.playerId}>
                    <i>{ORDINAL[entry.place] ?? `${entry.place}th`}</i>
                    <b>{entry.playerId === state.playerId ? "나" : entry.nickname}</b>
                    <span>+{entry.pointsAwarded} PTS</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="question-copy">
                <span className="genre-pill">{CLUE_KIND[mode]}</span>
                <h2>{MODE_PROMPT[mode]}</h2>
                <p>{!textMode && audioNote !== "" ? audioNote : CLUE_HELP[mode]}</p>
                {!textMode && audioNote !== "" && (
                  <button
                    className="text-button"
                    onClick={() => void audioRef.current?.play().then(() => setAudioNote(""))}
                  >
                    음원 재생
                  </button>
                )}
              </div>
            )}

            {isHost && (
              <div className="host-controls">
                <span>
                  <i /> HOST CONTROL
                </span>
                <button
                  onClick={() =>
                    hostAction(() =>
                      round?.paused === true
                        ? clientRef.current?.hostResume()
                        : clientRef.current?.hostPause(),
                    )
                  }
                  disabled={state?.phase !== "IN_ROUND"}
                >
                  {round?.paused === true ? "▶ 계속" : "Ⅱ 일시정지"}
                </button>
                <button
                  className="skip"
                  onClick={() => hostAction(() => clientRef.current?.hostSkip())}
                  disabled={state?.phase !== "IN_ROUND"}
                >
                  {textMode ? "현재 문제 스킵" : "현재 곡 스킵"} <b>⇥</b>
                </button>
              </div>
            )}
          </section>

          <aside className="chat-panel panel">
            <div className="panel-title">
              <div>정답 입력</div>
              <span>
                <i className="live-dot" /> {players.length}명
              </span>
            </div>
            <div className="chat-notice">
              <b>TIP</b>
              <span>띄어쓰기·대소문자·특수문자는 자동으로 무시됩니다.</span>
            </div>

            {/* No chat log. A wrong guess is private to its author, so there is
                nowhere for one to be broadcast (integration-plan §1.3). */}
            <div className="chat-log">
              <Feedback state={state} textMode={textMode} />
            </div>

            <form className="answer-form" onSubmit={onSubmitAnswer}>
              <label htmlFor="answer">정답 입력</label>
              <div>
                <input
                  id="answer"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={state?.phase === "IN_ROUND" ? ANSWER_PLACEHOLDER[mode] : "라운드 대기 중"}
                  disabled={state?.phase !== "IN_ROUND" || round?.paused === true}
                  autoComplete="off"
                />
                <button disabled={state?.phase !== "IN_ROUND" || answer.trim() === ""}>ENTER</button>
              </div>
              {/* Cosmetic only: the same normalizer the server judges with,
                  shown so the rules are visible. It decides nothing. */}
              <small>
                {answer.trim() === "" ? "Enter 키로 가장 빠르게 제출하세요" : `판정 기준: ${normalizeAnswer(answer)}`}
              </small>
            </form>
          </aside>
        </section>
      )}

      {view === "results" && (
        <section className="results page-enter">
          <div className="result-head">
            <span className="eyebrow">GAME COMPLETE</span>
            <h1>
              오늘의 <em>음악 왕</em>이<br />
              결정되었습니다.
            </h1>
            <p>
              ROOM {roomId} · {players.length} PLAYERS
            </p>
          </div>

          <div className="podium">
            {podiumOrder(state?.finalRanks ?? []).map(({ entry, place }, index) =>
              entry === undefined ? null : (
                <div className={`podium-place place-${place}`} key={entry.playerId}>
                  <span className="crown">{place === 1 ? "♛" : "●"}</span>
                  <div className={`avatar avatar-${(index % 5) + 1}`}>{AVATAR(entry.nickname)}</div>
                  <b>{entry.nickname}</b>
                  <strong>
                    {entry.score.toLocaleString()}
                    <i> PTS</i>
                  </strong>
                  <div className="podium-block">
                    <span>{place}</span>
                  </div>
                </div>
              ),
            )}
          </div>

          <section className="final-table panel">
            <div className="panel-title">
              <div>FINAL RANKING</div>
              <span>전체 {state?.finalRanks?.length ?? 0}명</span>
            </div>
            <div className="table-head">
              <span>순위</span>
              <span>플레이어</span>
              <span>최종 점수</span>
            </div>
            <div className="table-body">
              {(state?.finalRanks ?? []).map((entry, index) => (
                <div className={entry.playerId === state?.playerId ? "me" : ""} key={entry.playerId}>
                  <span>{String(entry.rank).padStart(2, "0")}</span>
                  <span>
                    <i className={`avatar avatar-${(index % 5) + 1}`}>{AVATAR(entry.nickname)}</i>
                    <b>{entry.nickname}</b>
                    {entry.playerId === state?.playerId && <small>YOU</small>}
                  </span>
                  <strong>{entry.score.toLocaleString()}</strong>
                </div>
              ))}
            </div>
          </section>

          <div className="result-actions">
            <button
              className="ghost-button"
              onClick={() => {
                clientRef.current?.disconnect();
                window.location.hash = "";
                window.location.reload();
              }}
            >
              처음으로
            </button>
          </div>
        </section>
      )}

      {toast !== null && (
        <div className="toast">
          <i>✓</i>
          {toast}
        </div>
      )}
    </main>
  );
}

function connectionLabel(state: ClientState | null): string {
  switch (state?.status) {
    case "joined":
      return "서버 연결됨";
    case "connecting":
      return "연결 중…";
    case "reconnecting":
      return "다시 연결하는 중…";
    case "closed":
      return "연결 끊김";
    default:
      return "대기 중";
  }
}

/** Second place on the left, first in the middle, third on the right. */
function podiumOrder(ranks: readonly { playerId: string; nickname: string; score: number }[]) {
  return [
    { entry: ranks[1], place: 2 as const },
    { entry: ranks[0], place: 1 as const },
    { entry: ranks[2], place: 3 as const },
  ];
}

/**
 * The verdict on this player's own guess, and nobody else's.
 *
 * `textMode` only decides whether the place is worth printing: in a song round
 * there is one scoring place, so "1등" reads as noise.
 */
function Feedback({ state, textMode }: { state: ClientState | null; textMode: boolean }) {
  const feedback = state?.answerFeedback;
  if (feedback === undefined || feedback.kind === "none") {
    return <div className="chat-notice"><span>정답을 입력하면 결과가 여기에 표시됩니다.</span></div>;
  }
  if (feedback.kind === "accepted") {
    return (
      <div className="system-message">
        <i>✓</i>
        <p>
          <b>정답입니다!</b> {feedback.place > 1 || textMode ? `${feedback.place}등 ` : ""}+
          {feedback.pointsAwarded}점
        </p>
      </div>
    );
  }
  if (feedback.kind === "rejected") {
    return (
      <div className="system-message">
        <i>✕</i>
        <p>
          <b>{feedback.guess}</b> 은(는) 오답입니다. 다시 시도해 보세요.
        </p>
      </div>
    );
  }
  // "tooLate" deliberately carries no verdict: saying whether a late guess was
  // right would leak the answer before the reveal (claude-analysis.md §4).
  return (
    <div className="system-message">
      <i>—</i>
      <p>이번 라운드에서는 더 이상 점수를 받을 수 없습니다.</p>
    </div>
  );
}

/** One catalog row. Uncontrolled, so typing never re-renders the whole list. */
function SongRow({ song, drafts }: { song: SongListEntry; drafts: Map<string, Draft> }) {
  const draft = drafts.get(song.id);
  const update = (patch: Partial<Draft>): void => {
    const next: Draft = {
      mediaUrl: "",
      clipStart: "",
      clipEnd: "",
      ...drafts.get(song.id),
      ...patch,
    };
    if (next.mediaUrl === "" && next.clipStart === "" && next.clipEnd === "") drafts.delete(song.id);
    else drafts.set(song.id, next);
  };

  return (
    <div>
      <span>{song.playable ? "✓" : "—"}</span>
      <div style={{ flex: 1 }}>
        <b>{song.title}</b>
        <small>
          {song.artist}
          {song.issue !== null ? ` · ${song.issue.message}` : ""}
        </small>
        <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.3rem" }}>
          <input
            defaultValue={draft?.mediaUrl ?? ""}
            placeholder="음원 URL"
            onChange={(event) => update({ mediaUrl: event.target.value.trim() })}
          />
          <input
            defaultValue={draft?.clipStart ?? ""}
            type="number"
            placeholder="시작"
            style={{ width: "5rem" }}
            onChange={(event) => update({ clipStart: event.target.value })}
          />
          <input
            defaultValue={draft?.clipEnd ?? ""}
            type="number"
            placeholder="끝"
            style={{ width: "5rem" }}
            onChange={(event) => update({ clipEnd: event.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
