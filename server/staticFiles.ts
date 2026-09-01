/**
 * Static file serving for the reference web client.
 *
 * `.ts` files are served as JavaScript with their types stripped by Node's
 * built-in `stripTypeScriptTypes`. That is what lets `client/` and `shared/`
 * stay first-class TypeScript — checked by the repo tsconfig, tested by
 * `node --test` — while a browser loads the exact same source files with no
 * bundler, no build step, and no dependency, which is the property `server/`
 * and `shared/` already have. Stripping only replaces type syntax with spaces,
 * so line and column numbers in a browser stack trace still point at the real
 * source.
 *
 * Serving raw sources is a development-mode choice. See docs/OPERATIONS.md for
 * what a public deployment should do instead.
 */

import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Extension allow-list. An unlisted extension is not served at all, so a
 * stray `.env`, `.json` credential dump, or `.md` note under a mounted
 * directory cannot be fetched even if someone drops one there.
 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Locks the page down to its own origin, apart from the two capabilities the
 * host-only YouTube player needs: its official API script and its player
 * iframe. Without both exceptions the browser blocks the API before the round
 * can make any sound. `media-src` is open because the host may also register a
 * licensed clip URL we do not control. This is defence in depth behind the
 * client's use of `textContent` for all player-supplied strings.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  "style-src 'self'",
  "img-src 'self' data:",
  'media-src *',
  "connect-src 'self' ws: wss:",
  'frame-src https://www.youtube.com',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface StaticMount {
  /** URL prefix this mount answers for. Must start and end with `/`. */
  urlPrefix: string;
  /** Directory the prefix maps to. */
  dir: string;
}

/** Resolves and writes the file, or returns false so the caller can 404. */
export type StaticHandler = (pathname: string, response: ServerResponse) => Promise<boolean>;

export function createStaticHandler(mounts: readonly StaticMount[]): StaticHandler {
  // Longest prefix wins, so a `/shared/` mount is not swallowed by `/`.
  const ordered = [...mounts]
    .map((mount) => ({ urlPrefix: mount.urlPrefix, root: resolve(mount.dir) }))
    .sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);

  return async (pathname, response) => {
    const mount = ordered.find((candidate) => pathname.startsWith(candidate.urlPrefix));
    if (mount === undefined) return false;

    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(mount.urlPrefix.length));
    } catch {
      // Malformed percent-encoding. Nothing legitimate looks like this.
      return false;
    }
    if (relative.includes('\0')) return false;
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';

    // Escape check is done on the *resolved* path, never on the request string.
    // Decoding above means `%2e%2e%2f` has become `../` by now, and only a
    // resolved comparison catches every spelling of it.
    const target = resolve(join(mount.root, relative));
    if (target !== mount.root && !target.startsWith(mount.root + sep)) return false;

    const extension = extname(target);
    const contentType = MIME[extension];
    if (contentType === undefined) return false;

    let body: string | Buffer;
    try {
      if (extension === '.ts') {
        body = stripTypeScriptTypes(await readFile(target, 'utf8'));
      } else {
        body = await readFile(target);
      }
    } catch {
      return false;
    }

    const headers: Record<string, string> = {
      'content-type': contentType,
      // `no-store`, not `no-cache`: these responses carry no validator, and a
      // browser will happily reuse a `no-cache` copy for the rest of a session
      // rather than revalidate against nothing. Editing a source and reloading
      // has to show the edit. A production deployment serving a built bundle
      // should replace this with real caching (docs/OPERATIONS.md).
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (extension === '.html') {
      headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
      // YouTube error 153 is raised when a player request has no referrer (or
      // equivalent client identity). Send only this page's origin cross-site;
      // the room path and host token in the URL remain private.
      headers['referrer-policy'] = 'strict-origin-when-cross-origin';
    }

    response.writeHead(200, headers);
    response.end(body);
    return true;
  };
}
