/**
 * Where the three files a host actually edits live.
 *
 * The song list, the proverbs, and the idioms are content, not code. Asking
 * someone to find them under `data/` — next to a recovered song catalog, two
 * `.50.json` archives and a handoff note — is asking them to edit the wrong
 * file at some point. So all three sit together in a `문제/` folder next to the
 * launcher, under plain Korean names, and those copies win whenever they exist.
 *
 * A folder rather than three loose files in the project root: the root already
 * holds a dozen source directories, and the point of this is that there is one
 * obvious place to open and nothing else in it to get wrong.
 *
 * Nothing here is required: with no `문제/` folder the server falls back to what
 * the repository ships, which is what a fresh clone and every test does. That is
 * also why the folder is gitignored — it is one host's setlist for one event,
 * not a change to the project.
 *
 * `resolveLocalFile` takes the root directory rather than reading it from
 * `import.meta.url`, so a test can point it at a temporary folder.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root: the folder holding `server/`, `data/` and the launcher. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one folder a host opens. Relative to `PROJECT_ROOT`. */
export const EDITABLE_DIR = '문제';

export interface ResolvedFile {
  /** Absolute path to the file the server should read. */
  path: string;
  /**
   * True when this is the host's own copy from the project root.
   *
   * Callers treat the two differently on failure. A bundled file that will not
   * parse is a mistake in this repository and should stop the server; a root
   * file that will not parse is a typo in something somebody edited half an
   * hour ago, and taking the whole server down over it — including the modes
   * that file has nothing to do with — is the wrong trade.
   */
  fromRoot: boolean;
}

/**
 * One editable file: what it may be called in the root, and what ships with the
 * repository when it is not there.
 */
export interface LocalFileSpec {
  /** For messages. e.g. `곡 목록`. */
  label: string;
  /**
   * Accepted paths relative to the project root, most preferred first. The
   * first is what the documentation and the launcher tell people to use and the
   * one `prepare-files.ts` creates; anything after it is a location that used to
   * work and should not silently stop.
   */
  rootNames: readonly string[];
  /** Path relative to the project root, used when no host file exists. */
  bundled: string;
}

export const PLAYLIST_FILE: LocalFileSpec = {
  label: '곡 목록',
  // `playlist.txt` in the root is where the launcher looked before this folder
  // existed. Someone's list is sitting there; it keeps working.
  rootNames: [`${EDITABLE_DIR}/곡목록.txt`, 'playlist.txt'],
  bundled: 'data/playlist.top100.txt',
};

export const PROVERB_FILE: LocalFileSpec = {
  label: '속담 문제',
  rootNames: [`${EDITABLE_DIR}/속담.json`],
  bundled: 'data/proverbs.json',
};

export const IDIOM_FILE: LocalFileSpec = {
  label: '사자성어 문제',
  rootNames: [`${EDITABLE_DIR}/사자성어.json`],
  bundled: 'data/idioms.json',
};

/** Every file a host is expected to edit, in the order the launcher lists them. */
export const EDITABLE_FILES: readonly LocalFileSpec[] = [PLAYLIST_FILE, PROVERB_FILE, IDIOM_FILE];

/**
 * The host's copy if there is one, otherwise the bundled file.
 *
 * Existence is checked at call time rather than cached, because the launcher
 * creates the root copies immediately before starting the server.
 */
export function resolveLocalFile(spec: LocalFileSpec, root: string = PROJECT_ROOT): ResolvedFile {
  for (const name of spec.rootNames) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return { path: candidate, fromRoot: true };
  }
  return { path: resolve(root, spec.bundled), fromRoot: false };
}
