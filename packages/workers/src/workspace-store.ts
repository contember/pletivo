/**
 * A `ProjectStore` over a SQLite-backed virtual filesystem — `@cloudflare/computer`'s
 * `SQLiteWorkspaceProvider`, and anything else with the same synchronous shape.
 *
 * This is the store `docs/todos/023` is about. Inside the Durable Object that owns the
 * workspace, `readFileSync` is a primary-key lookup rather than an RPC hop, so reading
 * the project is a walk over SQLite rather than a network round trip per file.
 *
 * The provider is named structurally, the way `WorkerLoaderBinding` is: this package
 * takes no dependency on `@cloudflare/computer`, on which version of it the app
 * installed, or on `node:fs` types. A `SQLiteWorkspaceProvider` satisfies
 * `WorkspaceFiles` as it stands.
 */

import type { ProjectAsset, ProjectAssets } from "./content-files.ts";
import type { ProjectSnapshot, ProjectStore } from "./project-store.ts";

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

/**
 * The one query the revision needs, structurally — a `Workspace`'s `db` satisfies it.
 *
 * See `vfsRevision` for why this is a separate argument rather than something read off
 * the provider.
 */
export interface WorkspaceRevisionSource {
  one(query: string, ...bindings: unknown[]): unknown;
}

export interface WorkspaceStoreOptions {
  /** Where the project starts in the workspace. Defaults to the workspace root. */
  root?: string;
  /**
   * Answers "has anything changed" without walking the tree.
   *
   * The gate that makes the whole store worth having: on an unchanged workspace the
   * tree is not walked and no file is re-read — the previous snapshot is handed straight
   * back. Without one, every snapshot re-reads the project, and the compile cache below
   * it pays a string compare per file instead of an engine-level pointer compare
   * (023 §3). Both are correct; one reads SQLite once per request and the other reads it
   * once per file.
   */
  revision?: () => string | number | undefined;
  /** Directory names never descended into. */
  skip?: Iterable<string>;
  /** Extensions read as bytes rather than text. */
  binaryExtensions?: Iterable<string>;
  /**
   * Largest file to read, in bytes. Unset, there is no limit and a workspace holding
   * one enormous file can exhaust the isolate's 128 MiB heap. Set, a file over the
   * limit is left out of the snapshot — which is a broken import rather than a dead
   * Worker, and the one this host can report.
   */
  maxFileBytes?: number;
}

/**
 * Build products and dependencies, not sources.
 *
 * `node_modules` is skipped because nothing reads it yet: npm arrives through the
 * artifact today, and 023 §6 has vendored output landing in the workspace later. When
 * it does, this default is what has to change.
 */
const DEFAULT_SKIP = ["node_modules", ".git", ".wrangler", ".astro", "dist"];

/**
 * Read as bytes; everything else is read as text.
 *
 * Deliberately the same list as `test/sources.ts`, because the parity harness and this
 * store have to classify a file the same way or the comparison means nothing. `.svg` is
 * text on both sides. The consequence is that an unlisted binary — a font, a PDF — is
 * read as UTF-8 and mangled; nothing serves those today, and the list is the lever.
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

  /** The last walk, and what the workspace's revision was when it was taken. */
  let cached: { revision: string; snapshot: ProjectSnapshot } | null = null;
  /** Stands in for a revision the workspace will not give, so nothing is reused. */
  let fallback = 0;

  function currentRevision(): string {
    const revision = readRevision?.();
    if (revision === undefined) return `unknown:${++fallback}`;
    return String(revision);
  }

  function walk(): ProjectSnapshot {
    const text = new Map<string, string>();
    const assets = new Map<string, ProjectAsset>();
    const revision = currentRevision();
    const directories = [""];

    while (directories.length > 0) {
      const relative = directories.pop() ?? "";
      const absolute = relative === "" ? root || "/" : `${root}${relative}`;
      for (const entry of dirents(files, absolute)) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) directories.push(`${relative}/${entry.name}`);
          continue;
        }
        // Symlinks and devices are neither: a workspace is allowed to hold them, and a
        // render has nothing to do with one.
        if (!entry.isFile()) continue;
        const key = relative === "" ? entry.name : `${relative.slice(1)}/${entry.name}`;
        const path = absolute === "/" ? `/${entry.name}` : `${absolute}/${entry.name}`;
        if (maxFileBytes !== undefined && sizeOf(files, path) > maxFileBytes) continue;
        if (binary.has(extensionOf(entry.name))) {
          const bytes = readBytes(files, path);
          if (bytes !== null) assets.set(key, bytes);
          continue;
        }
        const source = readText(files, path);
        if (source !== null) text.set(key, source);
      }
    }
    return { files: text, assets, revision };
  }

  return {
    snapshot(): Promise<ProjectSnapshot> {
      const revision = currentRevision();
      if (cached?.revision === revision) return Promise.resolve(cached.snapshot);
      const snapshot = walk();
      cached = { revision: snapshot.revision, snapshot };
      return Promise.resolve(snapshot);
    },
  };
}

/**
 * The revision counter `@cloudflare/computer` keeps, as a `revision` callback.
 *
 * dofs bumps one row in `vfs_meta` before it touches a node — writes, deletes, renames,
 * chmod alike — so one primary-key lookup answers the question the whole store is gated
 * on. `vfs_*` is that package's private schema rather than an API, so this is the only
 * place that names it and every failure degrades to `undefined`: a host whose schema has
 * moved keeps working and simply re-reads, exactly like a host that passed no callback.
 *
 * The same trick `@roj-ai/computer-platform` plays for its own filesystem cache; that
 * package cannot be depended on from here, so the query is repeated rather than shared.
 */
export function vfsRevision(db: WorkspaceRevisionSource): () => string | undefined {
  return () => {
    try {
      const row = db.one("SELECT v FROM vfs_meta WHERE k = 'rev'");
      if (typeof row !== "object" || row === null || !("v" in row)) return undefined;
      const value: unknown = row.v;
      return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * `""` for the workspace root, `/project` for a subdirectory.
 *
 * Empty rather than `"/"` so a child is `${root}/src` in both cases; the one place that
 * needs a path rather than a prefix spells the root out.
 */
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
    // A directory that vanished between the listing of its parent and this call. The
    // workspace is live; a snapshot of a moving tree is allowed to miss what moved.
    return [];
  }
  const dirents: WorkspaceDirent[] = [];
  for (const entry of entries) {
    // A provider that ignored `withFileTypes` would hand back names. Nothing can be
    // decided from a name, so such an entry is skipped rather than guessed at.
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

function readBytes(files: WorkspaceFiles, path: string): Uint8Array | null {
  let value: unknown;
  try {
    value = files.readFileSync(path);
  } catch {
    return null;
  }
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}
