/**
 * Where a host reads the project from. A store answers "the project, as it is now";
 * a `ProjectSnapshot` is a listing plus on-demand reads, so it never has to hold the
 * project in memory (`docs/todos/023` §4).
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
   * Changes when the project does, and only then. Lets a store hand back the same
   * snapshot; the compile cache does not depend on it (it compares sources by `===`).
   */
  revision: string;
  /**
   * A file's raw bytes, read now and not kept. Checked against `revision`; not bound by
   * a store's size limit. Absent on stores that hold only text.
   */
  readBytes?(path: string): Uint8Array<ArrayBuffer> | undefined;
}

/** The workspace moved off a snapshot's revision: during the listing walk, or before a read. */
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
  /** The project, now. Async because a store over KV or R2 has to be. */
  snapshot(): Promise<ProjectSnapshot>;
}

/**
 * A store over maps the caller already holds. The maps are copied once so later
 * caller mutation cannot change a snapshot without changing its revision.
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
