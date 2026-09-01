"use client";

import Script from "next/script";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export interface YouTubeCue {
  videoId: string;
  startMs: number;
  playMs: number;
}

export interface YouTubePlaybackStatus {
  message: string;
  canRetry: boolean;
}

export interface YouTubeHostPlayerHandle {
  start(cue: YouTubeCue): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

interface YouTubePlayerInstance {
  loadVideoById(options: {
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  setVolume(volume: number): void;
  unMute(): void;
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady(event: { target: YouTubePlayerInstance }): void;
        onStateChange(event: { data: number }): void;
        onError(event: { data: number }): void;
      };
    },
  ) => YouTubePlayerInstance;
  PlayerState: { PLAYING: number };
}

type YouTubeWindow = {
  YT?: YouTubeApi;
  onYouTubeIframeAPIReady?: () => void;
};

const EMPTY_STATUS: YouTubePlaybackStatus = { message: "", canRetry: false };

/** Human-readable failures from the YouTube IFrame Player API. */
export function describeYouTubeError(code: number): string {
  switch (code) {
    case 101:
    case 150:
      return "이 영상은 외부 재생이 막혀 있습니다. 곡목록의 링크를 바꿔 주세요.";
    case 100:
      return "삭제되었거나 비공개인 영상입니다. 곡목록의 링크를 바꿔 주세요.";
    case 2:
      return "곡목록의 유튜브 주소가 올바르지 않습니다.";
    case 153:
      return "유튜브가 이 사이트의 재생 요청을 확인하지 못했습니다. 페이지를 새로고침해 주세요.";
    default:
      return `유튜브 영상을 재생할 수 없습니다 (오류 ${code}).`;
  }
}

function cueOptions(cue: YouTubeCue) {
  const startSeconds = Math.round(cue.startMs / 1000);
  return {
    videoId: cue.videoId,
    startSeconds,
    endSeconds: Math.round((cue.startMs + cue.playMs) / 1000),
  };
}

interface Props {
  enabled: boolean;
  onStatus(status: YouTubePlaybackStatus): void;
}

/**
 * Hidden YouTube player driven only by the host-private `ROUND_CUE` message.
 *
 * The iframe stays visually inaccessible because its video and chrome reveal
 * the answer. Participants never receive the video id, so mounting this on a
 * participant screen cannot make it play.
 */
const YouTubeHostPlayer = forwardRef<YouTubeHostPlayerHandle, Props>(function YouTubeHostPlayer(
  { enabled, onStatus },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const pendingRef = useRef<YouTubeCue | null>(null);
  const pausedRef = useRef(false);

  const playPending = useCallback(() => {
    const cue = pendingRef.current;
    const mount = mountRef.current;
    const browser = window as unknown as YouTubeWindow;
    const api = browser.YT;
    if (cue === null || mount === null || api?.Player === undefined) return;

    const request = cueOptions(cue);
    const current = playerRef.current;
    if (current !== null) {
      current.loadVideoById(request);
      if (pausedRef.current) current.pauseVideo();
      else {
        current.setVolume(100);
        current.unMute();
        current.playVideo();
      }
      onStatus({ message: "유튜브 하이라이트를 재생하는 중…", canRetry: true });
      return;
    }

    try {
      playerRef.current = new api.Player(mount, {
        videoId: request.videoId,
        playerVars: {
          autoplay: pausedRef.current ? 0 : 1,
          start: request.startSeconds,
          end: request.endSeconds,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: { target: YouTubePlayerInstance }) => {
            const latest = pendingRef.current;
            if (latest !== null) event.target.loadVideoById(cueOptions(latest));
            event.target.setVolume(100);
            event.target.unMute();
            if (pausedRef.current) event.target.pauseVideo();
            else event.target.playVideo();
            onStatus({ message: "유튜브 하이라이트를 재생하는 중…", canRetry: true });
          },
          onStateChange: (event: { data: number }) => {
            if (event.data === browser.YT?.PlayerState.PLAYING) onStatus(EMPTY_STATUS);
          },
          onError: (event: { data: number }) => {
            onStatus({ message: describeYouTubeError(event.data), canRetry: true });
          },
        },
      });
    } catch {
      onStatus({
        message: "유튜브 플레이어를 시작하지 못했습니다. 인터넷 연결을 확인해 주세요.",
        canRetry: true,
      });
    }
  }, [onStatus]);

  const stop = useCallback(() => {
    pendingRef.current = null;
    pausedRef.current = false;
    playerRef.current?.stopVideo();
    onStatus(EMPTY_STATUS);
  }, [onStatus]);

  useImperativeHandle(
    ref,
    () => ({
      start(cue) {
        pendingRef.current = cue;
        onStatus({ message: "유튜브 영상을 불러오는 중…", canRetry: true });
        playPending();
      },
      pause() {
        pausedRef.current = true;
        playerRef.current?.pauseVideo();
      },
      resume() {
        pausedRef.current = false;
        const player = playerRef.current;
        if (player === null) {
          playPending();
          return;
        }
        player.setVolume(100);
        player.unMute();
        player.playVideo();
        onStatus({ message: "재생을 다시 시도하는 중…", canRetry: true });
      },
      stop,
    }),
    [onStatus, playPending, stop],
  );

  useEffect(() => {
    const browser = window as unknown as YouTubeWindow;
    const previous = browser.onYouTubeIframeAPIReady;
    const ready = () => {
      previous?.();
      playPending();
    };
    browser.onYouTubeIframeAPIReady = ready;
    if (browser.YT?.Player !== undefined) playPending();

    return () => {
      if (browser.onYouTubeIframeAPIReady === ready) browser.onYouTubeIframeAPIReady = previous;
      playerRef.current?.stopVideo();
      playerRef.current = null;
    };
  }, [playPending]);

  return (
    <>
      {enabled && (
        <Script
          id="youtube-iframe-api"
          src="https://www.youtube.com/iframe_api"
          strategy="afterInteractive"
          onReady={playPending}
        />
      )}
      <div className="youtube-host-mount" aria-hidden="true">
        <div ref={mountRef} />
      </div>
    </>
  );
});

export default YouTubeHostPlayer;
