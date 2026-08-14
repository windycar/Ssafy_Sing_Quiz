/**
 * Reference web client.
 *
 * A complete, dependency-free implementation of the player and host flows, so
 * the authoritative server in `server/` can be played rather than only tested.
 * It is the worked example for integration-plan §3 step 5: every rule the
 * prototype broke is handled here the way the protocol requires.
 *
 * - No answer ever lives in this file. `ROUND_START` carries a clip URL and
 *   nothing else; the title first appears at `ROUND_REVEAL` (§1.2).
 * - The countdown is rendered from the server's `deadline`, never decremented
 *   locally (§1.4).
 * - The answer box is its own channel. There is no chat log for a wrong guess
 *   to leak into (§1.3).
 * - `normalizeAnswer` is imported from `shared/`, the same module the server
 *   judges with, and is used only to explain the rules to the player — never to
 *   decide anything (§1.1).
 *
 * Every player-supplied string reaches the DOM through `textContent`. Nicknames
 * and guesses are untrusted input rendered in everyone else's browser
 * (analysis §7); this file must never grow an `innerHTML` assignment.
 */

import { ProtocolClient } from './protocolClient.ts';
import type { ClientState } from './protocolClient.ts';
import { ApiError, createRoom, fetchCatalog, lookupRoom, setSetlist } from './api.ts';
import type { SongListEntry } from './api.ts';
import type { LeaderboardEntry, ServerMessage } from '../server/protocol.ts';
import type { MediaRegistration } from '../shared/songCatalog.ts';
import { normalizeAnswer } from '../shared/answerMatching.ts';
import { isGameMode, isTextMode, MODE_LABEL, MODE_PROMPT, QUESTIONS_PER_TEXT_GAME } from '../shared/questions.ts';
import type { GameMode } from '../shared/questions.ts';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} 요소를 찾을 수 없습니다.`);
  return node as T;
}

const SCREENS = ['home', 'setup', 'lobby', 'round', 'reveal', 'final'] as const;
type Screen = (typeof SCREENS)[number];

function showScreen(name: Screen): void {
  for (const screen of SCREENS) el(`screen-${screen}`).hidden = screen !== name;
}

let toastTimer: number | undefined;
function toast(message: string): void {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4_000) as unknown as number;
}

// ---------------------------------------------------------------------------
// Session persistence
//
// `sessionStorage`, not `localStorage`: a game session should not silently
// resume days later in an unrelated tab (analysis §5).
// ---------------------------------------------------------------------------

const sessionKey = (roomId: string): string => `dtb:session:${roomId}`;
const hostKey = (roomId: string): string => `dtb:host:${roomId}`;

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    // Private-browsing modes can throw here. A game without resume is still a
    // game; a crash on load is not.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* see readStorage */
  }
}

// ---------------------------------------------------------------------------
// Clip playback
// ---------------------------------------------------------------------------

/**
 * Plays the clip window the server named.
 *
 * Audio failure is never allowed to stall the game: the round's deadline is
 * server-owned, so a clip that will not load costs the player the clip, not the
 * round. Every failure path here reports and returns.
 */
class ClipPlayer {
  private readonly audio = el<HTMLAudioElement>('clip');
  private readonly state = el('audio-state');
  private readonly retry = el<HTMLButtonElement>('audio-retry');
  private endSec: number | null = null;

  constructor() {
    this.audio.addEventListener('timeupdate', () => {
      // Stopping on `timeupdate` rather than a timer means a pause costs
      // nothing to track: `currentTime` simply stops advancing.
      if (this.endSec !== null && this.audio.currentTime >= this.endSec) this.audio.pause();
    });
    this.audio.addEventListener('error', () => {
      this.state.textContent = '음원을 재생할 수 없습니다. 라운드는 그대로 진행됩니다.';
    });
    this.retry.addEventListener('click', () => void this.resume());
  }

  async start(url: string, startMs: number, endMs: number): Promise<void> {
    this.endSec = endMs / 1000;
    this.retry.hidden = true;
    this.state.textContent = '음원을 불러오는 중…';

    if (this.audio.src !== url) this.audio.src = url;
    try {
      await this.seek(startMs / 1000);
      await this.audio.play();
      this.state.textContent = '재생 중';
    } catch {
      // Overwhelmingly this is the browser's autoplay policy, which needs a
      // user gesture. Offer one instead of failing silently.
      this.state.textContent = '브라우저가 자동 재생을 막았습니다.';
      this.retry.hidden = false;
    }
  }

  pause(): void {
    this.audio.pause();
  }

  async resume(): Promise<void> {
    try {
      await this.audio.play();
      this.state.textContent = '재생 중';
      this.retry.hidden = true;
    } catch {
      this.state.textContent = '재생할 수 없습니다.';
    }
  }

  stop(): void {
    this.endSec = null;
    this.audio.pause();
    this.state.textContent = '';
    this.retry.hidden = true;
  }

  private async seek(seconds: number): Promise<void> {
    if (this.audio.readyState >= 1) {
      this.audio.currentTime = seconds;
      return;
    }
    await new Promise<void>((resolve) => {
      const onReady = (): void => {
        this.audio.removeEventListener('loadedmetadata', onReady);
        this.audio.removeEventListener('error', onReady);
        resolve();
      };
      this.audio.addEventListener('loadedmetadata', onReady);
      this.audio.addEventListener('error', onReady);
    });
    // A stream with no known duration may refuse the seek; play from wherever
    // it starts rather than giving up on the clip.
    try {
      this.audio.currentTime = seconds;
    } catch {
      /* non-seekable source */
    }
  }
}

// ---------------------------------------------------------------------------
// YouTube playback (host only)
// ---------------------------------------------------------------------------

/** The slice of the IFrame API this file uses. */
interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds: number; endSeconds: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  setVolume(volume: number): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement | string, options: Record<string, unknown>) => YTPlayer;
      PlayerState: { ENDED: number; PLAYING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

/** Loads the IFrame API once, and resolves every caller when it is ready. */
let apiReady: Promise<void> | null = null;
function loadIframeApi(): Promise<void> {
  if (apiReady !== null) return apiReady;
  apiReady = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player !== undefined) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.addEventListener('error', () => reject(new Error('iframe api')));
    window.onYouTubeIframeAPIReady = () => resolve();
    document.head.append(script);
  });
  return apiReady;
}

/**
 * Plays the round's video on the host machine, with the picture hidden.
 *
 * The front computer's screen is visible to the room, so showing the video
 * would show the answer — the title sits in the player chrome and the music
 * video itself is usually a bigger giveaway. The iframe is therefore parked
 * off to the side at almost zero opacity and behind everything else: it still
 * counts as rendered, which is what keeps browsers willing to play it, while
 * being invisible from any seat in the room.
 *
 * Only ever driven by `RoundView.cue`, which only the host receives.
 */
class YouTubePlayer {
  private readonly mount = el('yt-mount');
  private readonly state = el('yt-state');
  private readonly retry = el<HTMLButtonElement>('yt-retry');
  private player: YTPlayer | null = null;
  private pending: { videoId: string; startSeconds: number; endSeconds: number } | null = null;

  constructor() {
    this.retry.addEventListener('click', () => {
      this.retry.hidden = true;
      this.player?.playVideo();
      this.state.textContent = '재생 중';
    });
  }

  async start(videoId: string, startMs: number, playMs: number): Promise<void> {
    const request = {
      videoId,
      startSeconds: Math.round(startMs / 1000),
      endSeconds: Math.round((startMs + playMs) / 1000),
    };
    this.pending = request;
    this.retry.hidden = true;
    this.state.textContent = '영상을 불러오는 중…';

    try {
      await loadIframeApi();
    } catch {
      this.state.textContent = '유튜브에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
      return;
    }

    // Another round may have started while the API was loading.
    if (this.pending !== request) return;

    if (this.player === null) {
      this.player = this.create(request);
      return;
    }
    this.player.loadVideoById(request);
    this.player.playVideo();
    this.state.textContent = '재생 중';
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  resume(): void {
    this.player?.playVideo();
  }

  stop(): void {
    this.pending = null;
    this.player?.stopVideo();
    this.state.textContent = '';
    this.retry.hidden = true;
  }

  private create(request: { videoId: string; startSeconds: number; endSeconds: number }): YTPlayer {
    const YT = window.YT;
    if (YT === undefined) throw new Error('iframe api not ready');

    return new YT.Player(this.mount, {
      videoId: request.videoId,
      playerVars: {
        autoplay: 1,
        start: request.startSeconds,
        end: request.endSeconds,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        // Related videos and the end screen would name other songs.
        iv_load_policy: 3,
      },
      events: {
        onReady: (event: { target: YTPlayer }) => {
          event.target.setVolume(100);
          event.target.playVideo();
          this.state.textContent = '재생 중';
        },
        onStateChange: (event: { data: number }) => {
          // Autoplay blocked leaves the player parked rather than playing.
          if (event.data === YT.PlayerState.PLAYING) this.retry.hidden = true;
        },
        onError: (event: { data: number }) => {
          this.state.textContent = describeYouTubeError(event.data);
          this.retry.hidden = false;
        },
      },
    });
  }
}

/**
 * The two that matter in practice are 101/150: the uploader disallowed
 * embedding, so the video plays on youtube.com and nowhere else. A host needs
 * to hear that in time to swap the link, not after the round is ruined.
 */
function describeYouTubeError(code: number): string {
  switch (code) {
    case 101:
    case 150:
      return '이 영상은 외부 재생이 막혀 있습니다. 다른 링크로 바꿔 주세요.';
    case 100:
      return '삭제되었거나 비공개인 영상입니다.';
    case 2:
      return '영상 주소가 올바르지 않습니다.';
    default:
      return `영상을 재생할 수 없습니다 (오류 ${code}).`;
  }
}

// ---------------------------------------------------------------------------
// Host setup: catalog and media registration
// ---------------------------------------------------------------------------

interface Draft {
  mediaUrl: string;
  clipStart: string;
  clipEnd: string;
}

let catalogSongs: SongListEntry[] = [];
/** Kept outside the DOM so filtering the list never discards typed values. */
const drafts = new Map<string, Draft>();

/** How many rows the list renders at once. 171 inputs is a scroll, not a UI. */
const SONG_PAGE = 60;

function renderSongList(): void {
  const filter = el<HTMLInputElement>('song-filter').value.trim().toLowerCase();
  const list = el<HTMLUListElement>('song-list');
  const template = el<HTMLTemplateElement>('song-row');

  const matched = catalogSongs.filter(
    (song) =>
      filter === '' ||
      song.title.toLowerCase().includes(filter) ||
      song.artist.toLowerCase().includes(filter),
  );

  list.replaceChildren();
  for (const song of matched.slice(0, SONG_PAGE)) {
    const row = template.content.cloneNode(true) as DocumentFragment;
    const item = row.querySelector<HTMLLIElement>('.song');
    if (item === null) continue;

    item.querySelector('.song-title')!.textContent = song.title;
    item.querySelector('.song-artist')!.textContent = song.artist;

    const state = item.querySelector<HTMLElement>('.song-state')!;
    if (song.playable) {
      state.textContent = '재생 가능';
      state.classList.add('ok');
    } else {
      state.textContent = song.issue?.message ?? '재생 불가';
    }

    const draft = drafts.get(song.id);
    const url = item.querySelector<HTMLInputElement>('.media-url')!;
    const start = item.querySelector<HTMLInputElement>('.clip-start')!;
    const end = item.querySelector<HTMLInputElement>('.clip-end')!;
    url.value = draft?.mediaUrl ?? '';
    start.value = draft?.clipStart ?? '';
    end.value = draft?.clipEnd ?? '';

    const capture = (): void => {
      const next: Draft = { mediaUrl: url.value.trim(), clipStart: start.value, clipEnd: end.value };
      if (next.mediaUrl === '' && next.clipStart === '' && next.clipEnd === '') drafts.delete(song.id);
      else drafts.set(song.id, next);
    };
    for (const input of [url, start, end]) input.addEventListener('input', capture);

    list.append(item);
  }

  const more = el('song-list-more');
  more.hidden = matched.length <= SONG_PAGE;
  more.textContent = `${matched.length}곡 중 ${Math.min(matched.length, SONG_PAGE)}곡 표시. 검색으로 좁혀 주세요.`;
}

/** Turns the typed drafts into registrations, dropping incomplete rows. */
function collectRegistrations(): { media: MediaRegistration[]; skipped: number } {
  const media: MediaRegistration[] = [];
  let skipped = 0;

  for (const [id, draft] of drafts) {
    const clipStart = Number(draft.clipStart);
    const clipEnd = Number(draft.clipEnd);
    const complete =
      draft.mediaUrl !== '' &&
      draft.clipStart !== '' &&
      draft.clipEnd !== '' &&
      Number.isFinite(clipStart) &&
      Number.isFinite(clipEnd) &&
      clipEnd > clipStart;

    if (complete) media.push({ id, mediaUrl: draft.mediaUrl, clipStart, clipEnd });
    else skipped += 1;
  }
  return { media, skipped };
}

async function loadCatalog(roomId: string, token: string): Promise<void> {
  const summary = el('catalog-summary');
  try {
    const response = await fetchCatalog(roomId, token);
    catalogSongs = response.songs;
    summary.textContent = `전체 ${response.total}곡 중 재생 가능 ${response.playableCount}곡.`;
    if (response.playableCount === 0) {
      summary.textContent += ' 음원을 등록해야 게임을 시작할 수 있습니다.';
      el<HTMLDetailsElement>('media-panel').open = true;
    }
    renderSongList();
  } catch (error) {
    summary.textContent = error instanceof ApiError ? error.message : '곡 목록을 불러오지 못했습니다.';
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let client: ProtocolClient | null = null;
let hostToken: string | null = null;
/** The room being configured on the setup screen, before anyone has joined. */
let setupRoomId: string | null = null;
/**
 * The mode of the room on the setup screen.
 *
 * Only the host screen needs this, and only before anyone has joined. Once
 * there is a session the mode comes from `ROOM_STATE` like everything else —
 * this file never decides what game is being played.
 */
let setupMode: GameMode = 'song';
const player = new ClipPlayer();
const youtube = new YouTubePlayer();

/** The mode the host picked on the home screen. */
function selectedMode(): GameMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="game-mode"]:checked');
  const value = checked?.value ?? 'song';
  return isGameMode(value) ? value : 'song';
}

/**
 * Rewrites the host setup screen for the chosen mode.
 *
 * A proverb or idiom room has no media to register and no count to choose —
 * the server ships all thirty questions — so the panels that exist only for
 * songs are hidden rather than left on screen doing nothing.
 */
function applySetupMode(mode: GameMode): void {
  const text = isTextMode(mode);
  el('setup-mode').textContent = MODE_LABEL[mode];
  el('media-card').hidden = text;
  el('song-count-row').hidden = text;
  el('save-setlist-label').textContent = text ? '문제 설정' : '곡 설정';
  el('setup-heading').textContent = text ? '문제를 확인하고 방에 입장하세요.' : '곡을 고르고 방에 입장하세요.';

  const note = el('question-count-note');
  note.hidden = !text;
  note.textContent = text
    ? `${MODE_LABEL[mode]}는 서버가 가진 ${QUESTIONS_PER_TEXT_GAME}문제를 방마다 새로 섞어 모두 출제합니다.`
    : '';
}

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

function connect(roomId: string, options: { nickname?: string; playerToken?: string | null }): void {
  client?.disconnect();
  hostToken = readStorage(hostKey(roomId));

  client = new ProtocolClient({
    url: socketUrl(),
    roomId,
    nickname: options.nickname,
    playerToken: options.playerToken ?? null,
    hostToken,
    onToken: (token) => writeStorage(sessionKey(roomId), token),
    onStateChange: render,
    onEvent: handleEvent,
  });
  client.connect();
}

function handleEvent(message: ServerMessage): void {
  switch (message.type) {
    case 'ROUND_START':
      // A text round has no media at all, and a live-playback round has no URL
      // for a player to fetch — the host's ROUND_CUE arrives separately and
      // drives the video. Only a hosted-audio song round has something to play.
      if (message.question.mode === 'song' && !message.livePlayback) {
        void player.start(message.mediaUrl, message.clipStartMs, message.clipEndMs);
      }
      break;
    case 'ROUND_CUE':
      void youtube.start(message.youtubeId, message.startMs, message.playMs);
      break;
    case 'ROUND_PAUSED':
      player.pause();
      youtube.pause();
      break;
    case 'ROUND_RESUMED':
      void player.resume();
      youtube.resume();
      break;
    case 'ROUND_REVEAL':
    case 'GAME_OVER':
      player.stop();
      youtube.stop();
      break;
    case 'ERROR':
      toast(message.message);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CONNECTION_LABEL: Record<ClientState['status'], string> = {
  idle: '',
  connecting: '연결 중…',
  joined: '연결됨',
  reconnecting: '다시 연결하는 중…',
  closed: '연결이 끊어졌습니다',
};

function renderRanks(target: HTMLOListElement, entries: readonly LeaderboardEntry[], youId: string | null): void {
  target.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement('li');
    // `me` is what the stylesheet highlights; `you` is kept for anything
    // outside this file that still looks for it.
    if (entry.playerId === youId) item.classList.add('me', 'you');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(entry.rank);

    const name = document.createElement('span');
    // textContent, not innerHTML: nicknames are untrusted (analysis §7).
    name.textContent = entry.nickname;

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = String(entry.score);

    item.append(rank, name, score);
    target.append(item);
  }
}

function renderRoster(state: ClientState): void {
  const roster = el<HTMLUListElement>('roster');
  roster.replaceChildren();
  for (const entry of state.players) {
    const item = document.createElement('li');
    if (!entry.connected) item.classList.add('offline');
    if (!entry.ready) item.classList.add('waiting');

    const name = document.createElement('span');
    name.textContent = entry.nickname;

    const tag = document.createElement('span');
    tag.className = entry.ready ? 'state tag ready' : 'state tag';
    tag.textContent = !entry.connected ? 'OFF' : entry.ready ? '✓' : '…';

    item.append(name, tag);
    roster.append(item);
  }

  const you = state.players.find((entry) => entry.id === state.playerId);
  el<HTMLButtonElement>('ready-toggle').textContent = you?.ready === true ? '준비 해제' : '준비';
  el<HTMLButtonElement>('start-game').hidden = hostToken === null;
  el('lobby-hint').textContent =
    hostToken === null
      ? '방장이 시작할 때까지 기다려 주세요.'
      : '준비 상태와 관계없이 방장이 언제든 시작할 수 있습니다.';
}

function renderFeedback(state: ClientState): void {
  const node = el('answer-feedback');
  node.classList.remove('ok', 'no');

  switch (state.answerFeedback.kind) {
    case 'accepted':
      // The place is worth saying only where more than one player can score;
      // in a song round it is always 1st and reads as noise.
      node.textContent =
        state.answerFeedback.place > 1 || isTextMode(state.mode)
          ? `정답입니다! ${state.answerFeedback.place}등 +${state.answerFeedback.pointsAwarded}점`
          : `정답입니다! +${state.answerFeedback.pointsAwarded}점`;
      node.classList.add('ok');
      break;
    case 'rejected':
      node.textContent = `"${state.answerFeedback.guess}" 은(는) 오답입니다. 다시 시도해 보세요.`;
      node.classList.add('no');
      break;
    case 'tooLate':
      // The server deliberately does not say whether this guess was right.
      // Covers both "the places are gone" and "you already took one", without
      // distinguishing them — either verdict would say something about the
      // answer to a player who is still guessing.
      node.textContent = '이번 라운드에서는 더 이상 점수를 받을 수 없습니다.';
      break;
    default:
      node.textContent = '';
      break;
  }
}

/** Placeholder text for the answer box, per mode. */
const ANSWER_PLACEHOLDER: Record<GameMode, string> = {
  song: '곡 제목을 입력하세요',
  proverb: '속담의 뒷부분을 입력하세요',
  idiom: '사자성어 네 글자를 입력하세요',
};

/** What the clue card calls itself, per mode. */
const CLUE_KIND: Record<GameMode, string> = {
  song: 'K-POP',
  proverb: '속담',
  idiom: '사자성어',
};

const CLUE_HELP: Record<GameMode, string> = {
  song: '',
  proverb: '속담 전체를 적어도 되고, 빠진 뒷부분만 적어도 됩니다.',
  idiom: '한글 네 글자도, 한자 네 글자도 정답으로 인정됩니다.',
};

/**
 * How many people can score this mode's round, in words.
 *
 * Song rounds end on the first correct answer; text rounds hold three places.
 * Written per mode rather than read off a server constant because it is copy,
 * not a rule — the rule lives in `POINTS_BY_PLACE` on the server, and this
 * screen only ever reports what it was told.
 */
const SCORING_NOTE: Record<GameMode, string> = {
  song: '가장 먼저 맞힌 1명 1점',
  proverb: '먼저 맞힌 3명까지 각 1점',
  idiom: '먼저 맞힌 3명까지 각 1점',
};

function renderRound(state: ClientState): void {
  const round = state.round;
  const mode = round?.question.mode ?? state.mode;
  const total = round?.question.totalQuestions ?? state.totalQuestions;

  el('round-label').textContent = isTextMode(mode) ? '문제' : 'ROUND';
  el('scoring-note').textContent = SCORING_NOTE[mode];
  el('round-progress').textContent =
    round === null ? '' : `${String(round.question.index + 1).padStart(2, '0')} / ${total}`;

  // The media stage and the clue card are the same slot: exactly one of them
  // belongs on screen, decided by the mode the server named.
  const text = isTextMode(mode);
  el('vinyl-stage').hidden = text;
  el('clue-card').hidden = !text;
  el('question-kind').textContent = CLUE_KIND[mode];
  el('question-prompt').textContent = MODE_PROMPT[mode];

  if (text) {
    el('clue-kind').textContent = CLUE_KIND[mode];
    el('clue-help').textContent = CLUE_HELP[mode];
    // The clue is whatever the server sent and nothing else. During COUNTDOWN
    // there is no round yet, so there is nothing to show.
    el('clue-text').textContent = round?.question.clue ?? '';
  }

  const isHost = hostToken !== null;
  el('host-controls').hidden = !isHost;
  el<HTMLButtonElement>('host-pause').hidden = round?.paused !== false;
  el<HTMLButtonElement>('host-resume').hidden = round?.paused !== true;

  const answering = state.phase === 'IN_ROUND' && round !== null && !round.paused;
  const input = el<HTMLInputElement>('answer-input');
  input.disabled = !answering;
  input.placeholder = ANSWER_PLACEHOLDER[mode];
  el<HTMLFormElement>('answer-form').hidden = round === null;

  renderFeedback(state);
  renderRanks(el<HTMLOListElement>('round-ranks'), state.leaderboard, state.playerId);
}

/**
 * Draws the answer, in whichever shape this mode has one.
 *
 * Every string here comes from `ROUND_REVEAL`. Nothing on this screen is
 * derived from anything the client held during the round, because during the
 * round it held none of it.
 */
function renderReveal(state: ClientState): void {
  const reveal = state.reveal;
  const answer = reveal?.answer ?? null;
  const mode = answer?.mode ?? state.mode;

  el('reveal-kind').textContent = isTextMode(mode) ? `${CLUE_KIND[mode]} 정답` : 'ROUND ANSWER';

  // For a proverb the prefix was already on screen and the suffix is what
  // players had to supply, so they are drawn as two spans and the stylesheet
  // dims the half nobody had to guess.
  el('reveal-known').textContent = answer?.mode === 'proverb' ? `${answer.clue ?? ''} ` : '';
  el('reveal-title').textContent =
    answer === null ? '' : answer.mode === 'proverb' ? (answer.detail ?? answer.answer) : answer.answer;

  el('reveal-artist').textContent = answer?.artist ?? '';
  el('reveal-detail').textContent =
    answer?.mode === 'idiom'
      ? [answer.hanja, answer.detail].filter((part) => part !== null && part !== '').join(' · ')
      : '';

  const scorers = reveal?.scorers ?? [];
  const node = el('reveal-winner');
  node.classList.remove('ok', 'no');
  node.textContent = scorers.length === 0 ? '아무도 맞히지 못했습니다.' : '';
  if (scorers.some((entry) => entry.playerId === state.playerId)) node.classList.add('ok');

  // One row per scorer, in the order the server received them, so who came
  // first, second and third is legible from the back of a room.
  const list = el<HTMLOListElement>('reveal-scorers');
  list.replaceChildren();
  for (const entry of scorers) {
    const item = document.createElement('li');
    if (entry.playerId === state.playerId) item.classList.add('me');

    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = `${entry.place}등`;

    const who = document.createElement('span');
    // textContent, not innerHTML: nicknames are untrusted (analysis §7).
    who.textContent = entry.playerId === state.playerId ? '나' : entry.nickname;

    const points = document.createElement('span');
    points.className = 'score';
    points.textContent = `+${entry.pointsAwarded}점`;

    item.append(place, who, points);
    list.append(item);
  }
}

function render(state: ClientState): void {
  el('connection').textContent = CONNECTION_LABEL[state.status];

  if (state.error !== null && state.status === 'closed') {
    showScreen('home');
    toast(state.error.message);
    return;
  }

  // Until the first ROOM_STATE arrives there is no phase to render — `phase`
  // is still the local default of LOBBY, and showing the lobby on the strength
  // of it puts a live "게임 시작" button in front of a socket that is still
  // connecting. Stay on the current screen and let the status line speak.
  if (state.playerId === null) return;

  switch (state.phase) {
    case 'COUNTDOWN':
    case 'IN_ROUND':
      showScreen('round');
      renderRound(state);
      break;

    case 'REVEAL': {
      showScreen('reveal');
      renderReveal(state);
      renderRanks(el<HTMLOListElement>('reveal-ranks'), state.leaderboard, state.playerId);
      break;
    }

    case 'FINISHED': {
      showScreen('final');
      const ranks = state.finalRanks ?? [];
      const podium = el<HTMLOListElement>('podium');
      podium.replaceChildren();
      // Document order is 1st, 2nd, 3rd; the stylesheet reorders them so the
      // winner stands in the middle.
      for (const [position, entry] of ranks.slice(0, 3).entries()) {
        const item = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = entry.nickname;
        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = `${entry.score} PTS`;
        const block = document.createElement('div');
        block.className = 'block';
        block.textContent = String(position + 1);
        item.append(name, score, block);
        podium.append(item);
      }
      renderRanks(el<HTMLOListElement>('final-ranks'), ranks, state.playerId);
      break;
    }

    default:
      showScreen('lobby');
      el('lobby-code').textContent = state.roomId ?? '';
      // The mode the server recorded on the room, not the radio button this
      // tab happened to have selected.
      el('lobby-mode').textContent =
        `${MODE_LABEL[state.mode]} · ${state.totalQuestions}문제`;
      renderRoster(state);
      break;
  }
}

// ---------------------------------------------------------------------------
// Timer ticking
//
// Separate from `render` because it runs at 10 Hz off the server's deadline,
// while `render` runs only when a message changes the state.
// ---------------------------------------------------------------------------

function tick(): void {
  if (client === null) return;
  const state = client.getState();

  // Two places to put it, because the vinyl and the clue card are alternatives
  // and the countdown belongs to whichever one is on screen.
  const countdowns = [el('countdown'), el('clue-countdown')];
  if (state.phase === 'COUNTDOWN' && state.countdownStartsAt !== null) {
    const left = String(Math.ceil(Math.max(0, state.countdownStartsAt - client.serverNow()) / 1000));
    for (const node of countdowns) {
      node.hidden = false;
      node.textContent = left;
    }
  } else {
    for (const node of countdowns) node.hidden = true;
  }

  const round = state.round;
  const timer = el('timer');
  const fill = el('timer-fill');
  const text = el('timer-text');
  // The record stops spinning while the round is paused, which is the clearest
  // signal from the back of a room that nothing is running.
  const stage = document.querySelector('#screen-round .stage');
  const notice = el('round-notice');

  if (round === null || state.phase !== 'IN_ROUND') {
    fill.style.width = '0%';
    text.textContent = '';
    notice.textContent = '';
    timer.classList.remove('paused', 'urgent');
    stage?.classList.remove('paused');
    return;
  }

  // A frozen screen with no explanation reads as a broken game. Say which of
  // the two pauses this is, and — for the one the server is timing — how much
  // of the wait is left. It is drawn here rather than in `render` so the number
  // counts down instead of sitting at whatever it was when the pause landed.
  if (!round.paused) {
    notice.textContent = '';
  } else if (!round.hostAway) {
    notice.textContent = '방장이 라운드를 잠시 멈췄습니다.';
  } else {
    const waitMs = round.hostGraceEndsAt === null ? 0 : round.hostGraceEndsAt - client.serverNow();
    const seconds = Math.max(0, Math.ceil(waitMs / 1000));
    notice.textContent =
      round.livePlayback
        ? `방장 연결이 끊겼습니다. ${seconds}초 안에 돌아오지 않으면 게임이 여기서 종료됩니다.`
        : `방장 연결이 끊겼습니다. ${seconds}초 뒤 자동으로 이어집니다.`;
  }

  const remaining = client.remainingMs() ?? 0;
  const total = Math.max(1, round.deadline - round.serverStartedAt);
  fill.style.width = `${Math.min(100, (remaining / total) * 100)}%`;
  text.textContent = (remaining / 1000).toFixed(1);
  timer.classList.toggle('paused', round.paused);
  timer.classList.toggle('urgent', remaining <= 5_000);
  stage?.classList.toggle('paused', round.paused);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function inviteLink(roomId: string): string {
  return `${location.origin}/#room=${encodeURIComponent(roomId)}`;
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}을(를) 복사했습니다.`);
  } catch {
    toast(`복사에 실패했습니다. 직접 선택해 복사해 주세요: ${text}`);
  }
}

function wire(): void {
  // Creating the room comes first now, because the catalog is only readable
  // with a host token and the token does not exist until the room does.
  el('go-setup').addEventListener('click', () => {
    void (async () => {
      const button = el<HTMLButtonElement>('go-setup');
      button.disabled = true;
      try {
        // The mode is chosen here, before the room exists, and the server
        // records it on the room. Everything after this reads it back.
        const created = await createRoom({ mode: selectedMode() });
        writeStorage(hostKey(created.roomId), created.hostToken);
        hostToken = created.hostToken;
        setupRoomId = created.roomId;
        setupMode = created.mode;

        el('invite-code').textContent = created.roomId;
        el<HTMLInputElement>('invite-link').value = inviteLink(created.roomId);
        el('setlist-summary').textContent =
          isTextMode(created.mode) ? `${created.questionCount}문제로 진행합니다.` : '';
        location.hash = `room=${encodeURIComponent(created.roomId)}`;
        applySetupMode(created.mode);
        showScreen('setup');
        // A text room draws from the server's own bank; there is no catalog to
        // register media against, so there is nothing to fetch.
        if (!isTextMode(created.mode)) await loadCatalog(created.roomId, created.hostToken);
      } catch (caught) {
        toast(caught instanceof ApiError ? caught.message : '방을 만들지 못했습니다.');
      } finally {
        button.disabled = false;
      }
    })();
  });

  el('song-filter').addEventListener('input', renderSongList);

  el('save-setlist').addEventListener('click', () => {
    void (async () => {
      const button = el<HTMLButtonElement>('save-setlist');
      const error = el('setup-error');
      const { media, skipped } = collectRegistrations();
      if (setupRoomId === null || hostToken === null) return;

      button.disabled = true;
      error.hidden = true;
      try {
        // The mode travels with every reconfiguration, so the room's recorded
        // mode and this screen never disagree.
        const setlist = await setSetlist(setupRoomId, hostToken, {
          mode: setupMode,
          ...(isTextMode(setupMode)
            ? {}
            : { songCount: Number(el<HTMLInputElement>('song-count').value) || 5, media }),
        });

        if (isTextMode(setlist.mode)) {
          el('setlist-summary').textContent = `${setlist.questionCount}문제로 진행합니다. 방마다 순서가 새로 섞입니다.`;
        } else {
          el('setlist-summary').textContent =
            setlist.questionCount === 0
              ? '재생 가능한 곡이 없습니다. 음원을 등록해야 게임을 시작할 수 있습니다.'
              : `${setlist.questionCount}곡으로 진행합니다. (재생 가능한 곡 ${setlist.playableCount}곡` +
                (skipped > 0 ? `, 입력이 덜 된 ${skipped}곡은 제외` : '') +
                ')';

          if (setlist.registrationIssues.length > 0) {
            toast(`등록한 음원 중 ${setlist.registrationIssues.length}곡이 조건을 만족하지 않아 제외되었습니다.`);
          }
          // The catalog changed: songs that just became playable should show it.
          await loadCatalog(setupRoomId, hostToken);
        }
      } catch (caught) {
        error.textContent = caught instanceof ApiError ? caught.message : '곡 설정을 저장하지 못했습니다.';
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    })();
  });

  el('copy-invite').addEventListener('click', () => {
    void copy(el<HTMLInputElement>('invite-link').value, '참여 링크');
  });

  el('copy-host').addEventListener('click', () => {
    if (hostToken === null || setupRoomId === null) return;
    void copy(`${inviteLink(setupRoomId)}&host=${encodeURIComponent(hostToken)}`, '방장 링크');
  });

  el<HTMLFormElement>('host-enter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (setupRoomId === null) return;
    connect(setupRoomId, { nickname: el<HTMLInputElement>('host-nickname').value });
  });

  el<HTMLFormElement>('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const roomId = el<HTMLInputElement>('join-code').value.trim();
      const nickname = el<HTMLInputElement>('join-nickname').value.trim();
      if (roomId === '' || nickname === '') return;

      try {
        const room = await lookupRoom(roomId);
        if (!room.joinable) {
          toast('이미 시작된 방에는 참여할 수 없습니다.');
          return;
        }
        // Joining early is fine — the host may still be picking songs — but say
        // so, otherwise the lobby looks broken when start does nothing.
        if (!room.ready) toast('방장이 아직 문제를 고르는 중입니다. 대기실에서 기다려 주세요.');
        else toast(`${MODE_LABEL[room.mode]} 방에 들어갑니다.`);
      } catch (caught) {
        toast(caught instanceof ApiError ? caught.message : '방을 확인하지 못했습니다.');
        return;
      }
      connect(roomId, { nickname });
    })();
  });

  el('ready-toggle').addEventListener('click', () => {
    if (client === null) return;
    const state = client.getState();
    const you = state.players.find((entry) => entry.id === state.playerId);
    if (!client.setReady(you?.ready !== true)) toast('서버와 연결되어 있지 않습니다.');
  });

  // Every action can be refused while the socket is down. Saying so beats a
  // button that silently does nothing.
  const act = (run: () => boolean | undefined): void => {
    if (run() === false) toast('서버와 연결되어 있지 않습니다. 잠시 후 다시 시도해 주세요.');
  };

  el('start-game').addEventListener('click', () => act(() => client?.hostStart()));
  el('host-pause').addEventListener('click', () => act(() => client?.hostPause()));
  el('host-resume').addEventListener('click', () => act(() => client?.hostResume()));
  el('host-skip').addEventListener('click', () => act(() => client?.hostSkip()));

  const answerInput = el<HTMLInputElement>('answer-input');
  answerInput.addEventListener('input', () => {
    // Cosmetic only. This is the server's normalizer, shown so a player can see
    // that spacing and punctuation do not matter — it decides nothing.
    const normalized = normalizeAnswer(answerInput.value);
    el('answer-hint').textContent =
      answerInput.value.trim() === '' ? '띄어쓰기와 문장부호는 무시됩니다.' : `판정 기준: ${normalized}`;
  });

  el<HTMLFormElement>('answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const guess = answerInput.value.trim();
    if (guess === '' || client === null) return;
    if (!client.submitAnswer(guess)) {
      // Keep the text in the box: the player should not have to retype an
      // answer the client failed to deliver.
      toast('서버와 연결되어 있지 않아 정답을 보내지 못했습니다.');
      return;
    }
    answerInput.value = '';
    el('answer-hint').textContent = '띄어쓰기와 문장부호는 무시됩니다.';
  });

  el('play-again').addEventListener('click', () => {
    client?.disconnect();
    location.hash = '';
    location.reload();
  });
}

/**
 * Restores a session from the URL and storage.
 *
 * The host token travels in the fragment, which browsers never send to the
 * server, and is removed from the visible URL as soon as it is stored — it is
 * the one secret in this system that grants control of a running game
 * (analysis §7).
 */
function bootstrap(): void {
  wire();
  setInterval(tick, 100);

  const hash = new URLSearchParams(location.hash.replace(/^#/u, ''));
  const roomId = hash.get('room');
  if (roomId === null) {
    showScreen('home');
    return;
  }

  const tokenFromLink = hash.get('host');
  if (tokenFromLink !== null) {
    writeStorage(hostKey(roomId), tokenFromLink);
    history.replaceState(null, '', `#room=${encodeURIComponent(roomId)}`);
  }

  const stored = readStorage(sessionKey(roomId));
  if (stored !== null) {
    connect(roomId, { playerToken: stored });
    return;
  }

  // A host token but no player session: this tab created the room (or opened a
  // host link) and has not entered it yet. Put them back on the setup screen
  // rather than making them type their own join code.
  const storedHost = readStorage(hostKey(roomId));
  if (storedHost !== null) {
    hostToken = storedHost;
    setupRoomId = roomId;
    el('invite-code').textContent = roomId;
    el<HTMLInputElement>('invite-link').value = inviteLink(roomId);
    showScreen('setup');
    void (async () => {
      // The mode lives on the room, not in this tab, so a refresh asks the
      // server what it is rather than guessing from the radio buttons.
      try {
        const room = await lookupRoom(roomId);
        setupMode = room.mode;
      } catch {
        // The lookup is a convenience; a failure leaves the song setup on
        // screen, which is what the previous build always showed.
      }
      applySetupMode(setupMode);
      if (!isTextMode(setupMode)) await loadCatalog(roomId, storedHost);
    })();
    return;
  }

  // Known room, no session yet: this is a shared invite link.
  el<HTMLInputElement>('join-code').value = roomId;
  showScreen('home');
  el<HTMLInputElement>('join-nickname').focus();
}

bootstrap();
