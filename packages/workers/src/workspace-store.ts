/**
 * A `ProjectStore` over a synchronous, Node-shaped virtual filesystem (docs/todos/023).
 *
 * A snapshot lists directories and reads no file; files are read on first use. Every
 * read first checks the workspace is still at the snapshot's revision and throws
 * `WorkspaceSnapshotChangedError` otherwise, so a snapshot never mixes two revisions.
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
  readdirSync(path: string, options: { withFileTypes: true }): WorkspaceDirent[];
  readFileSync(path: string, encoding?: "utf-8"): string | Uint8Array;
  statSync(path: string): { size: number };
}

/** One entry of a subtree's scan; see `WorkspaceStoreOptions.entries`. */
export interface WorkspaceEntry {
  /** Absolute workspace path. */
  path: string;
  /** `"other"` for a symlink or a device: the listing leaves it out and does not follow it. */
  type: "file" | "directory" | "other";
  /** Bytes, for `maxFileBytes`; read for files only. */
  size: number;
}

export interface WorkspaceStoreOptions {
  /** Where the project starts in the workspace. Defaults to the workspace root. */
  root?: string;
  /**
   * Every entry below the absolute `root`, in any order, in place of a `readdirSync` per
   * directory and a `statSync` per file: a provider that keeps its tree in a database answers
   * it with one scan. A directory `prune` answers true for is listed, but its contents need
   * not be. The listing is the one `readdirSync` gives where that lists each directory in code
   * point order of its names, the order of its keys included. Unset, the listing walks
   * `readdirSync`.
   */
  entries?: (root: string, prune: (directory: string) => boolean) => Iterable<WorkspaceEntry>;
  /**
   * Answers "has anything under `root` changed" without walking the tree. On an
   * unchanged revision the previous snapshot is reused, and a lazy read can notice a
   * later write (023 §3).
   *
   * Called with the store's absolute root (`"/"` for the workspace root). Pass a
   * revision scoped to that subtree, so a write elsewhere (another session's checkout)
   * neither discards this snapshot nor fails a read in flight. A whole-workspace
   * counter, `() => fs.rev()`, is correct too, only coarser.
   */
  revision: (root: string) => string | number;
  /**
   * Largest file to read, in bytes; a larger file is left out of the listing. Unset, one
   * enormous file can exhaust the isolate heap. `ProjectSnapshot.readBytes` is not bound by it.
   */
  maxFileBytes?: number;
  /**
   * The version of each file at the workspace paths asked, for `ProjectFiles.versions`, in
   * one call: a scan asks for a whole collection. A version changes with every write to its
   * file, and equal versions must mean equal text across every workspace whose renders share
   * an isolate: where one isolate serves several workspaces, put the workspace's identity in
   * it. Unset, files carry no version.
   */
  versions?: (paths: readonly string[]) => (string | null)[];
  /**
   * The text of each file at the workspace paths asked, `null` where there is none, in one read:
   * a collection asks for all of its files. Unset, each file is read on its own.
   */
  readMany?: (paths: readonly string[]) => (string | null)[];
}

/** Build products and dependencies. npm packages arrive through the artifact (023 §6). */
const SKIP = new Set(["node_modules", ".git", ".wrangler", ".astro", "dist"]);

/**
 * Read as bytes; everything else is read as text. Must match `test/sources.ts`, or the
 * parity harness compares differently classified files.
 */
const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);

/** Text that is also an image: listed on both sides, for `?raw` and for image metadata. */
const TEXT_IMAGE = ".svg";

export function createWorkspaceProjectStore(
  files: WorkspaceFiles,
  options: WorkspaceStoreOptions,
): ProjectStore {
  const root = normalizeRoot(options.root ?? "/");
  const maxFileBytes = options.maxFileBytes;

  /** The last snapshot, and what the workspace's revision was when it was listed. */
  let cached: { revision: string; snapshot: ProjectSnapshot } | null = null;

  const absoluteRoot = root === "" ? "/" : root;
  function currentRevision(): string {
    return String(options.revision(absoluteRoot));
  }

  /** Project key -> workspace path, for text and binary files. Stats, reads no file. */
  function list(): Listing {
    const text = new Map<string, string>();
    const binaryFiles = new Map<string, string>();
    const regular = new Map<string, string>();
    const directories = [""];
    const children = options.entries === undefined ? null : scannedChildren(options.entries);

    while (directories.length > 0) {
      const relative = directories.pop() ?? "";
      const absolute = relative === "" ? root || "/" : `${root}${relative}`;
      for (const entry of children === null ? walkedChildren(absolute) : (children.get(relative) ?? [])) {
        if (entry.type === "directory") {
          if (!SKIP.has(entry.name)) directories.push(`${relative}/${entry.name}`);
          continue;
        }
        // Symlinks and devices: a render has nothing to do with them.
        if (entry.type !== "file") continue;
        const key = relative === "" ? entry.name : `${relative.slice(1)}/${entry.name}`;
        const path = absolute === "/" ? `/${entry.name}` : `${absolute}/${entry.name}`;
        regular.set(key, path);
        if (maxFileBytes !== undefined && entry.size() > maxFileBytes) continue;
        const extension = extensionOf(entry.name);
        if (BINARY.has(extension)) binaryFiles.set(key, path);
        else text.set(key, path);
        if (extension === TEXT_IMAGE) binaryFiles.set(key, path);
      }
    }
    return { text, binary: binaryFiles, regular };
  }

  function walkedChildren(absolute: string): ListedChild[] {
    return dirents(files, absolute).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: () => sizeOf(files, absolute === "/" ? `/${entry.name}` : `${absolute}/${entry.name}`),
    }));
  }

  /** The scan's entries by their directory (`""` for the root, `/src` below it), each in code point order of its names. */
  function scannedChildren(entries: NonNullable<WorkspaceStoreOptions["entries"]>): Map<string, ListedChild[]> {
    const byDirectory = new Map<string, ListedChild[]>();
    const prune = (directory: string): boolean => SKIP.has(directory.slice(directory.lastIndexOf("/") + 1));
    for (const entry of entries(absoluteRoot, prune)) {
      if (entry.path === absoluteRoot || !entry.path.startsWith(`${root}/`)) continue;
      const relative = entry.path.slice(root.length);
      const slash = relative.lastIndexOf("/");
      const directory = relative.slice(0, slash);
      const siblings = byDirectory.get(directory) ?? [];
      const { size } = entry;
      siblings.push({ name: relative.slice(slash + 1), type: entry.type, size: () => size });
      byDirectory.set(directory, siblings);
    }
    for (const siblings of byDirectory.values()) siblings.sort((a, b) => compareCodePoints(a.name, b.name));
    return byDirectory;
  }

  function snapshotOf(listing: Listing, revision: string): ProjectSnapshot {
    const assertCurrent = (): void => {
      const now = currentRevision();
      if (now !== revision) throw new WorkspaceSnapshotChangedError(revision, now);
    };
    const readBytesOf = (source: string): Uint8Array<ArrayBuffer> | null => {
      const path = listing.binary.get(source);
      if (path === undefined) return null;
      assertCurrent();
      return readBytes(files, path);
    };
    const readVersions = options.versions;
    // A version holds for the snapshot's revision, so each file's is asked for once.
    const known = new Map<string, string | null>();
    const versions =
      readVersions === undefined
        ? undefined
        : (keys: readonly string[]): (string | null)[] => {
            const missing: string[] = [];
            const paths: string[] = [];
            for (const key of keys) {
              const path = listing.text.get(key);
              if (path === undefined || known.has(key)) continue;
              missing.push(key);
              paths.push(path);
            }
            if (paths.length > 0) {
              // Synchronous: one check covers the versions read below.
              assertCurrent();
              const read = readVersions(paths);
              missing.forEach((key, index) => known.set(key, read[index] ?? null));
            }
            return keys.map((key) => known.get(key) ?? null);
          };
    const readTexts = options.readMany;
    return {
      files: new LazyWorkspaceFiles(
        listing.text,
        (path) => {
          assertCurrent();
          return readText(files, path);
        },
        versions,
        readTexts === undefined
          ? undefined
          : (paths) => {
              assertCurrent();
              return readTexts(paths);
            },
      ),
      assets: createLazyProjectAssetsView(listing.binary.keys(), readBytesOf),
      revision,
      readBytes: (key) => {
        // Listed keys only: the walk skipped symlinks, so a read cannot leave the tree.
        const path = listing.regular.get(key);
        if (path === undefined) return undefined;
        assertCurrent();
        return readBytes(files, path) ?? undefined;
      },
    };
  }

  return {
    async snapshot(): Promise<ProjectSnapshot> {
      const before = currentRevision();
      if (cached?.revision === before) return cached.snapshot;
      const listing = list();
      const after = currentRevision();
      // The caller retries the whole operation; see `withSnapshot` in project-host.ts.
      if (before !== after) throw new WorkspaceSnapshotChangedError(before, after);
      const snapshot = snapshotOf(listing, before);
      cached = { revision: before, snapshot };
      return snapshot;
    },
  };
}

/** One entry of a directory, as the listing walks it. */
interface ListedChild {
  name: string;
  type: WorkspaceEntry["type"];
  /** Asked only for a file, and only with `maxFileBytes` set. */
  size: () => number;
}

interface Listing {
  text: ReadonlyMap<string, string>;
  binary: ReadonlyMap<string, string>;
  /** Every regular file, whatever its size: what `readBytes` may read. */
  regular: ReadonlyMap<string, string>;
}

/** Text files of one snapshot, each read on its first `get` and kept for the snapshot. */
class LazyWorkspaceFiles implements ProjectFiles {
  readonly #paths: ReadonlyMap<string, string>;
  readonly #read: (path: string) => string | null;
  readonly #sources = new Map<string, string | null>();
  readonly #readMany: ((paths: readonly string[]) => (string | null)[]) | undefined;
  readonly versions?: (paths: readonly string[]) => (string | null)[];

  constructor(
    paths: ReadonlyMap<string, string>,
    read: (path: string) => string | null,
    versions: ((paths: readonly string[]) => (string | null)[]) | undefined,
    readMany: ((paths: readonly string[]) => (string | null)[]) | undefined,
  ) {
    this.#paths = paths;
    this.#read = read;
    this.#readMany = readMany;
    if (versions !== undefined) this.versions = versions;
  }

  getMany(keys: readonly string[]): (string | undefined)[] {
    const missing: string[] = [];
    const paths: string[] = [];
    for (const key of keys) {
      const path = this.#paths.get(key);
      if (path === undefined || this.#sources.has(key)) continue;
      missing.push(key);
      paths.push(path);
    }
    if (paths.length > 0 && this.#readMany !== undefined) {
      const texts = this.#readMany(paths);
      missing.forEach((key, index) => this.#sources.set(key, texts[index] ?? null));
    }
    return keys.map((key) => this.get(key));
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
  try {
    return files.readdirSync(path, { withFileTypes: true });
  } catch {
    // Vanished since its parent was listed; a snapshot of a live tree may miss it.
    return [];
  }
}

function sizeOf(files: WorkspaceFiles, path: string): number {
  try {
    return files.statSync(path).size;
  } catch {
    return 0;
  }
}

// The provider types every read as `string | Uint8Array`, whatever the encoding asked for.
function readText(files: WorkspaceFiles, path: string): string | null {
  let value: string | Uint8Array;
  try {
    value = files.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function readBytes(files: WorkspaceFiles, path: string): Uint8Array<ArrayBuffer> | null {
  let value: string | Uint8Array;
  try {
    value = files.readFileSync(path);
  } catch {
    return null;
  }
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const { buffer, byteOffset, byteLength } = bytes;
  // A Response body cannot be a view of a SharedArrayBuffer.
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer, byteOffset, byteLength) : new Uint8Array(bytes);
}

/** Code point order, which is the byte order of the names' UTF-8: UTF-16 code units order a surrogate pair before U+E000..U+FFFF. */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  while (true) {
    const x = left.next();
    const y = right.next();
    if (x.done === true || y.done === true) return (x.done === true ? 0 : 1) - (y.done === true ? 0 : 1);
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}
