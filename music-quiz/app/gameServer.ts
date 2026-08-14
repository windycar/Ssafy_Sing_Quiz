/**
 * Where the authoritative game server lives.
 *
 * This app deploys to Cloudflare Workers, which cannot run a process that
 * listens on a socket, so the game server is always somewhere else — see
 * docs/OPERATIONS.md §1. `VITE_GAME_SERVER` names it; an empty value means
 * "same origin", which is what a local `--headless`-less server gives you.
 */

const configured = readEnv().replace(/\/+$/u, '');

function readEnv(): string {
  // `import.meta.env` only exists under Vite; guard so the module is also
  // importable from a plain Node test.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.['VITE_GAME_SERVER'] ?? '';
}

/** Base for `fetch` calls. Empty string keeps them same-origin. */
export function apiBase(): string {
  return configured;
}

export function socketUrl(): string {
  const base = configured === '' ? window.location.origin : configured;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

/**
 * `sessionStorage`, not `localStorage`: a game session should not silently
 * resume days later in an unrelated tab (claude-analysis.md §5). Both helpers
 * swallow errors because private-browsing modes throw, and a game without
 * resume beats a crash on load.
 */
export const sessionKey = (roomId: string): string => `dtb:session:${roomId}`;
export const hostKey = (roomId: string): string => `dtb:host:${roomId}`;

export function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* see readStorage */
  }
}
