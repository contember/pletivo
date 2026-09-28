/**
 * A `ProjectStore` over a synchronous, Node-shaped virtual filesystem (docs/todos/023).
 *
 * A snapshot lists directories and reads no file; files are read on first use. With a
 * `revision` source, every read first checks the workspace is still at the snapshot's
 * revision and throws `WorkspaceSnapshotChangedError` otherwise, so a snapshot never
 * mixes two revisions. Without one, reads are unchecked and nothing is reused.
 *
 * The filesystem is typed structurally, so this package takes no dependency on the
 * workspace provider or on `node:fs` types.
 */

import { createLazyProjectAssetsView } from "./content-files.ts";
import {
  WorkspaceSnapshotChangedError,
  type ProjectFiles,
  type ProjectSnapshot,
  type ProjectStore,
} from "./project-store.ts";

export { WorkspaceSnapshotChangedError };

/** One `readdir` entry, in the `withFileTypes` shape. */
export interface WorkspaceDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The synchronous read surface a workspace has to offer. */
export interface WorkspaceFiles {
  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | WorkspaceDirent[];
  readFileSync(path: string, options?: { encoding?: string | null } | string | null): unknown;
  statSync(path: string): { size: number };
  existsSync(path: string): boolean;
}

export interface WorkspaceStoreOptions {
  /** Where the project starts in the workspace. Defaults to the workspace root. */
  root?: string;
  /**
   * Answers "has anything changed" without walking the tree. On an unchanged workspace
   * the previous snapshot is reused, and a lazy read can notice a later write (023 §3).
   */
  revision?: () => string | number | undefined;
  /** Directory names never descended into. */
  skip?: Iterable<string>;
  /** Extensions read as bytes rather than text. */
  binaryExtensions?: Iterable<string>;
  /**
   * Largest file to read, in bytes; a larger file is left out of the listing. Unset, one
   * enormous file can exhaust the isolate heap. `ProjectSnapshot.readBytes` is not bound by it.
   */
  maxFileBytes?: number;
}

/** Build products and dependencies. npm packages arrive through the artifact (023 §6). */
const DEFAULT_SKIP = ["node_modules", ".git", ".wrangler", ".astro", "dist"];

/**
 * Read as bytes; everything else is read as text. Must match `test/sources.ts`, or the
 * parity harness compares differently classified files.
 */
const DEFAULT_BINARY = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"];

export function createWorkspaceProjectStore(
  files: WorkspaceFiles,
  options: WorkspaceStoreOptions = {},
): ProjectStore {
  const root = normalizeRoot(options.root ?? "/");
  const skip = new Set(options.skip ?? DEFAULT_SKIP);
  const binary = new Set(options.binaryExtensions ?? DEFAULT_BINARY);
  const readRevision = options.revision;
  const maxFileBytes = options.maxFileBytes;

  /** The last snapshot, and what the workspace's revision was when it was listed. */
  let cached: { revision: string; snapshot: ProjectSnapshot } | null = null;
  /** Stands in for a revision the workspace will not give, so nothing is reused. */
  let fallback = 0;

  function currentRevision(): string | undefined {
    const revision = readRevision?.();
    return revision === undefined ? undefined : String(revision);
  }

  /** Project key -> workspace path, for text and binary files. Stats, reads no file. */
  function list(): Listing {
    const text = new Map<string, string>();
    const binaryFiles = new Map<string, string>();
    const directories = [""];

    while (directories.length > 0) {
      const relative = directories.pop() ?? "";
      const absolute = relative === "" ? root || "/" : `${root}${relative}`;
      for (const entry of dirents(files, absolute)) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) directories.push(`${relative}/${entry.name}`);
          continue;
        }
        // Symlinks and devices: a render has nothing to do with them.
        if (!entry.isFile()) continue;
        const key = relative === "" ? entry.name : `${relative.slice(1)}/${entry.name}`;
        const path = absolute === "/" ? `/${entry.name}` : `${absolute}/${entry.name}`;
        if (maxFileBytes !== undefined && sizeOf(files, path) > maxFileBytes) continue;
        if (binary.has(extensionOf(entry.name))) binaryFiles.set(key, path);
        else text.set(key, path);
      }
    }
    return { text, binary: binaryFiles };
  }

  function snapshotOf(listing: Listing, revision: string, checked: boolean): ProjectSnapshot {
    const assertCurrent = (): void => {
      if (!checked) return;
      const now = currentRevision();
      if (now !== revision) throw new WorkspaceSnapshotChangedError(revision, String(now));
    };
    const readBytesOf = (source: string): Uint8Array<ArrayBuffer> | null => {
      const path = listing.binary.get(source);
      if (path === undefined) return null;
      assertCurrent();
      return readBytes(files, path);
    };
    return {
      files: new LazyWorkspaceFiles(listing.text, (path) => {
        assertCurrent();
        return readText(files, path);
      }),
      assets: createLazyProjectAssetsView(listing.binary.keys(), readBytesOf),
      revision,
      readBytes: (key) => {
        assertCurrent();
        return readBytes(files, root === "" ? `/${key}` : `${root}/${key}`) ?? undefined;
      },
    };
  }

  function unknownSnapshot(listing: Listing): ProjectSnapshot {
    return snapshotOf(listing, `unknown:${++fallback}`, false);
  }

  function stableSnapshot(listing: Listing, revision: string): ProjectSnapshot {
    const snapshot = snapshotOf(listing, revision, true);
    cached = { revision, snapshot };
    return snapshot;
  }

  return {
    async snapshot(): Promise<ProjectSnapshot> {
      const before = currentRevision();
      if (before !== undefined && cached?.revision === before) {
        return cached.snapshot;
      }

      const first = list();
      const after = currentRevision();
      if (before === undefined || after === undefined) {
        // No usable revision means no coherence proof and therefore no cache reuse.
        return unknownSnapshot(first);
      }
      if (before === after) return stableSnapshot(first, before);

      const retryBefore = currentRevision();
      const retry = list();
      const retryAfter = currentRevision();
      if (retryBefore === undefined || retryAfter === undefined) {
        return unknownSnapshot(retry);
      }
      if (retryBefore !== retryAfter) {
        throw new WorkspaceSnapshotChangedError(retryBefore, retryAfter);
      }
      return stableSnapshot(retry, retryBefore);
    },
  };
}

interface Listing {
  text: ReadonlyMap<string, string>;
  binary: ReadonlyMap<string, string>;
}

/** Text files of one snapshot, each read on its first `get` and kept for the snapshot. */
class LazyWorkspaceFiles implements ProjectFiles {
  readonly #paths: ReadonlyMap<string, string>;
  readonly #read: (path: string) => string | null;
  readonly #sources = new Map<string, string | null>();

  constructor(paths: ReadonlyMap<string, string>, read: (path: string) => string | null) {
    this.#paths = paths;
    this.#read = read;
  }

  keys(): Iterable<string> {
    return this.#paths.keys();
  }

  has(key: string): boolean {
    return this.#paths.has(key);
  }

  get(key: string): string | undefined {
    const known = this.#sources.get(key);
    if (known !== undefined || this.#sources.has(key)) return known ?? undefined;
    const path = this.#paths.get(key);
    if (path === undefined) return undefined;
    const source = this.#read(path);
    this.#sources.set(key, source);
    return source ?? undefined;
  }
}

/** `""` for the workspace root, `/project` for a subdirectory, so a child is always `${root}/src`. */
function normalizeRoot(root: string): string {
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function dirents(files: WorkspaceFiles, path: string): WorkspaceDirent[] {
  let entries: string[] | WorkspaceDirent[];
  try {
    entries = files.readdirSync(path, { withFileTypes: true });
  } catch {
    // Vanished since its parent was listed; a snapshot of a live tree may miss it.
    return [];
  }
  const dirents: WorkspaceDirent[] = [];
  for (const entry of entries) {
    // A provider that ignored `withFileTypes`; a bare name cannot be classified.
    if (typeof entry === "string") continue;
    dirents.push(entry);
  }
  return dirents;
}

function sizeOf(files: WorkspaceFiles, path: string): number {
  try {
    return files.statSync(path).size;
  } catch {
    return 0;
  }
}

function readText(files: WorkspaceFiles, path: string): string | null {
  let value: unknown;
  try {
    value = files.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

function readBytes(files: WorkspaceFiles, path: string): Uint8Array<ArrayBuffer> | null {
  let value: unknown;
  try {
    value = files.readFileSync(path);
  } catch {
    return null;
  }
  if (value instanceof Uint8Array) {
    const { buffer, byteOffset, byteLength } = value;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer, byteOffset, byteLength);
    // A Response body cannot be a view of a SharedArrayBuffer.
    return new Uint8Array(value);
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  return null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}
