/**
 * Where a host reads the project from.
 *
 * Until now `@pletivo/workers` had one answer: the caller hands the whole project in
 * with the request. That is right for a preview server handed a different project
 * every time, and wrong for the shape `docs/todos/023` describes — a live workspace
 * that outlives any one render and that an agent writes to between two of them.
 *
 * This is the seam. A store answers "the project, as it is now"; everything above it
 * is unchanged, because a `ProjectSnapshot` is exactly the pair of maps `renderPage`
 * already takes.
 *
 * **This materialises the whole project, deliberately, for now.** The compile no longer
 * walks all of it — `compileProject` follows the requested page's import graph (023 §4).
 * What still reads every key is routing, which needs a listing of `src/pages`, and the
 * base stylesheet, which is every `.css` under `srcDir` and needs their bytes. Both are
 * key scans rather than compiles, so the lazier shape they want is a listing and a
 * read — and this interface is where it goes.
 */

import type { ProjectAssets } from "./content-files.ts";

/** The project as one render sees it: text one side, bytes the other. */
export interface ProjectSnapshot {
  /** Path -> source, keyed the way `renderPage` keys `files`. */
  files: ReadonlyMap<string, string>;
  /** Path -> the binary's bytes, or what the store already knows about it. */
  assets: ProjectAssets;
  /**
   * Changes when the project does, and only then.
   *
   * What it buys is the read: a store that can answer "nothing moved" hands the same
   * snapshot back instead of walking the tree and re-reading every file.
   *
   * It is *not* what makes the compile cache correct. `===` on two strings compares
   * their contents, so an equal source hits whether or not it is the same object — a
   * store with no revision source pays a memcmp per file instead of a pointer compare,
   * which is still far below the hashing 023 §3 rejects. Returning the same object is
   * therefore an optimisation on both counts, and nothing depends on it.
   */
  revision: string;
}

export interface ProjectStore {
  /**
   * The project, now.
   *
   * Async because a store over KV or R2 has to be. The one this exists for — a
   * `@cloudflare/computer` workspace inside the Durable Object that owns it — reads
   * SQLite synchronously and returns an already-settled promise.
   */
  snapshot(): Promise<ProjectSnapshot>;
}

/**
 * A store over maps the caller already holds.
 *
 * What every host here did before a store existed, named: the preview server handed a
 * project per request, and the tests. The revision is supplied by the caller, since
 * only the caller knows whether it swapped the maps out.
 */
export function createMapProjectStore(
  files: ReadonlyMap<string, string>,
  assets: ProjectAssets = new Map(),
  revision = "static",
): ProjectStore {
  const snapshot: ProjectSnapshot = { files, assets, revision };
  return { snapshot: () => Promise.resolve(snapshot) };
}
