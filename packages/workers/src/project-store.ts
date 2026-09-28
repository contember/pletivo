/**
 * Where a host reads the project from.
 *
 * A store answers "the project, as it is now" for a live workspace that outlives any one
 * render and that an agent writes to between two of them (`docs/todos/023`). Everything
 * above it sees a `ProjectSnapshot`: a listing of source paths with a read of one file,
 * plus a demand-driven asset view bound to the same revision.
 *
 * Every consumer needs only those two operations. Routing lists `src/pages`, content
 * scans list a collection's directory, and the compile reads what the page's import
 * graph reaches (023 §4). So a snapshot never has to hold the project in memory.
 */

import type { ProjectAssetsView } from "./asset-port.ts";
import {
  createProjectAssetsView,
  projectAssetsView,
  type ProjectAssets,
} from "./content-files.ts";

/** Project sources as one revision sees them. A `ReadonlyMap<string, string>` satisfies it. */
export interface ProjectFiles {
  /** Every source path. Listing only: no content is read. */
  keys(): Iterable<string>;
  get(path: string): string | undefined;
  has(path: string): boolean;
}

/** The project as one render sees it: text and assets from one revision. */
export interface ProjectSnapshot {
  /** Source paths, keyed the way `renderPage` keys `files`. */
  files: ProjectFiles;
  /** Snapshot-owned source metadata and output lookup, both demand-driven. */
  assets: ProjectAssetsView;
  /**
   * Changes when the project does, and only then.
   *
   * What it buys is the read: a store that can answer "nothing moved" hands the same
   * snapshot back, with the files it already read, instead of walking the tree again.
   *
   * It is *not* what makes the compile cache correct. `===` on two strings compares
   * their contents, so an equal source hits whether or not it is the same object — a
   * store with no revision source pays a memcmp per file instead of a pointer compare,
   * which is still far below the hashing 023 §3 rejects. Returning the same object is
   * therefore an optimisation on both counts, and nothing depends on it.
   */
  revision: string;
  /**
   * A file's raw bytes, read now and not kept, for a caller that needs exact bytes
   * rather than text. Checked against `revision` like any other read; not bound by a
   * store's size limit. Absent on stores that hold only text.
   */
  readBytes?(path: string): Uint8Array<ArrayBuffer> | undefined;
}

/** The workspace moved off a snapshot's revision: during both listing walks, or before a read. */
export class WorkspaceSnapshotChangedError extends Error {
  constructor(
    readonly before: string,
    readonly after: string,
  ) {
    super(
      `[pletivo-workers] workspace changed under a project snapshot ` +
        `(${JSON.stringify(before)} -> ${JSON.stringify(after)})`,
    );
    this.name = "WorkspaceSnapshotChangedError";
  }
}

export interface ProjectStore {
  /**
   * The project, now.
   *
   * Async because a store over KV or R2 has to be. The one this exists for — a
   * `kompjutr` workspace inside the Durable Object that owns it — reads SQLite
   * synchronously and returns an already-settled promise.
   */
  snapshot(): Promise<ProjectSnapshot>;
}

/**
 * A store over maps the caller already holds. The maps are copied once so later
 * caller mutation cannot change a snapshot without changing its revision.
 *
 * What every host here did before a store existed, named: the preview server handed a
 * project per request, and the tests. The revision is supplied by the caller, since
 * only the caller knows whether it swapped the maps out.
 */
export function createMapProjectStore(
  files: ReadonlyMap<string, string>,
  assets: ProjectAssets | ProjectAssetsView = new Map(),
  revision = "static",
): ProjectStore {
  const snapshotFiles = new Map(files);
  const snapshotAssets = isAssetMap(assets)
    ? createProjectAssetsView(assets)
    : projectAssetsView(assets);
  const snapshot: ProjectSnapshot = {
    files: snapshotFiles,
    assets: snapshotAssets,
    revision,
  };
  return { snapshot: () => Promise.resolve(snapshot) };
}

function isAssetMap(
  assets: ProjectAssets | ProjectAssetsView,
): assets is ProjectAssets {
  return !("info" in assets && "resolveOutput" in assets);
}
