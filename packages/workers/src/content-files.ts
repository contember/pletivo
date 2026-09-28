/**
 * How the render isolate reads content files over a binding, and the host side that answers.
 * Content stays out of the module map so an edit does not mint a new isolate.
 * Every call carries a per-render `ref` because a warm isolate serves overlapping renders;
 * see docs/todos/016 "Content collections".
 */

import {
  baseNameOf,
  extensionOf,
  imageContentHash,
  imageContentType,
  imageOutputPath,
  readImageDimensions,
} from "@pletivo/core/image";
import type {
  ProjectAssetInfo,
  ProjectAssetsView,
  ServedProjectAsset,
} from "./asset-port.ts";
import type { ProjectFiles } from "./project-store.ts";

/**
 * The RPC surface the isolate calls. Structural, so a loopback `WorkerEntrypoint` or a
 * Durable Object can implement exactly this and nothing more.
 */
export interface ContentBinding {
  /** Files under `dir` matching `pattern`, sorted by `entry`. */
  scan(ref: string, dir: string, pattern: string): Promise<ContentFileRef[]> | ContentFileRef[];
  /** A file's text, or `null` when the project has no such file. */
  read(ref: string, path: string): Promise<string | null> | string | null;
  /**
   * What a binary asset is, or `null` when the project has no such file. Optional, so a
   * host with no binaries stays a valid binding and an `image()` schema fails by name.
   */
  image?(ref: string, path: string): Promise<ImageInfo | null> | ImageInfo | null;
}

/**
 * Everything a render learns about an image it cannot see. The bytes never cross the
 * binding: the isolate needs only dimensions, format and hash, derived on the host.
 */
export type ImageInfo = ProjectAssetInfo;

/**
 * One binary file: its bytes, or its precomputed info. The info form lets a host keep
 * images that do not fit a Worker's heap outside it (e.g. in R2).
 */
export type ProjectAsset = Uint8Array<ArrayBuffer> | ProjectAssetInfo;

/** The project's binary files, keyed like its sources. */
export type ProjectAssets = ReadonlyMap<string, ProjectAsset>;

/** One file a scan found: its path relative to the scan directory, and its full key. */
export interface ContentFileRef {
  entry: string;
  path: string;
}

/** A render's handle on the sources. Closed when the render is done, however it ends. */
export interface ContentHandle {
  ref: string;
  close(): void;
  /**
   * The first error a read through this handle threw, or `undefined`. The isolate sees
   * such an error only as a message, so the host rethrows it from here with its class.
   */
  failure(): unknown;
}

/** Where the bytes come from, for the length of one render. */
export interface ContentStore {
  /** `files` is the project's text; `assets` is its binaries (images). */
  open(
    files: ProjectFiles,
    assets?: ProjectAssets | ProjectAssetsView,
  ): ContentHandle;
}

/**
 * Serves content out of a virtual file map — the host half of the binding.
 *
 * The app owns the instance and exposes it as a `WorkerEntrypoint`, because only the
 * app has `ctx.exports`:
 *
 * ```ts
 * const CONTENT = new ContentFiles();
 * export class PletivoContent extends WorkerEntrypoint {
 *   scan(ref: string, dir: string, pattern: string) { return CONTENT.scan(ref, dir, pattern); }
 *   read(ref: string, path: string) { return CONTENT.read(ref, path); }
 * }
 * // per request:
 * renderPage({ files, loader: env.LOADER, content: { binding: ctx.exports.PletivoContent({}), store: CONTENT } })
 * ```
 *
 * `ctx.exports.PletivoContent({})` takes an options object; called bare it throws,
 * and passed uncalled it is not serializable into a dynamic Worker's `env`.
 */
export class ContentFiles implements ContentBinding, ContentStore {
  readonly #open = new Map<string, OpenProject>();
  #next = 0;

  /** How many renders currently hold a handle. A leak shows up here. */
  get openCount(): number {
    return this.#open.size;
  }

  open(
    files: ProjectFiles,
    assets?: ProjectAssets | ProjectAssetsView,
  ): ContentHandle {
    const ref = `r${++this.#next}`;
    const project: OpenProject = {
      files,
      assets: assets ? projectAssetsView(assets) : undefined,
      failure: undefined,
    };
    this.#open.set(ref, project);
    return {
      ref,
      close: () => {
        this.#open.delete(ref);
      },
      failure: () => project.failure?.error,
    };
  }

  scan(ref: string, dir: string, pattern: string): ContentFileRef[] {
    const project = this.#project(ref);
    return recording(project, () => scanFiles(project.files, dir, pattern));
  }

  read(ref: string, path: string): string | null {
    const project = this.#project(ref);
    return recording(project, () => project.files.get(path) ?? null);
  }

  image(ref: string, path: string): ImageInfo | null | Promise<ImageInfo | null> {
    // `#project` first: an asset map may be absent, a finished render's ref may not.
    const project = this.#project(ref);
    const info = recording(project, () => project.assets?.info(path) ?? null);
    if (!(info instanceof Promise)) return info;
    return info.catch((error: unknown) => {
      project.failure ??= { error };
      throw error;
    });
  }

  #project(ref: string): OpenProject {
    const project = this.#open.get(ref);
    if (!project) {
      throw new Error(
        `[pletivo-workers] no open project for content ref ${JSON.stringify(ref)} — ` +
          "the render that opened it has already finished",
      );
    }
    return project;
  }
}

/** One render's sources, and the first error a read of them threw. */
interface OpenProject {
  files: ProjectFiles;
  assets: ProjectAssetsView | undefined;
  failure: { error: unknown } | undefined;
}

function scanFiles(files: ProjectFiles, dir: string, pattern: string): ContentFileRef[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const match = globMatcher(pattern);
  const found: ContentFileRef[] = [];
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const entry = path.slice(prefix.length);
    if (entry === "" || !match(entry)) continue;
    found.push({ entry, path });
  }
  // The sort is part of the `ContentScan.files` contract both hosts share.
  found.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  return found;
}

function recording<T>(project: OpenProject, read: () => T): T {
  try {
    return read();
  } catch (error) {
    project.failure ??= { error };
    throw error;
  }
}

/** What one asset is, whether the host handed bytes or the answer itself. */
export function assetInfo(asset: ProjectAsset, path: string): ImageInfo {
  return asset instanceof Uint8Array ? probeImage(asset, path) : asset;
}

/** Dimensions and content hash of one image. Project-owned views cache this result. */
export function probeImage(bytes: Uint8Array, path: string): ImageInfo {
  return {
    ...readImageDimensions(bytes, path),
    hash: imageContentHash(bytes),
  };
}

export type AssetProbe = (bytes: Uint8Array, path: string) => ProjectAssetInfo;

/** Two project sources claim one immutable generated output name. */
export class ProjectAssetOutputAmbiguityError extends Error {
  constructor(
    readonly pathname: string,
    readonly sources: readonly string[],
  ) {
    super(
      `[pletivo-workers] generated asset ${JSON.stringify(pathname)} is ambiguous: ` +
        sources.map((source) => JSON.stringify(source)).join(", "),
    );
    this.name = "ProjectAssetOutputAmbiguityError";
  }
}

/** A map-backed, snapshot-owned asset view with no eager image probing. */
export function createProjectAssetsView(
  assets: ProjectAssets,
  probe: AssetProbe = probeImage,
): ProjectAssetsView {
  const owned = ownProjectAssets(assets);
  return new SnapshotAssetsView(owned.keys(), (source) => owned.get(source) ?? null, probe);
}

/**
 * An asset view over files it reads on demand.
 *
 * `readBytes` is called when `info` first asks about a source, and again each time
 * `resolveOutput` serves it. Only the derived `ProjectAssetInfo` is kept, never the bytes,
 * so a project's images do not have to fit the isolate's heap.
 */
export function createLazyProjectAssetsView(
  sources: Iterable<string>,
  readBytes: (source: string) => Uint8Array<ArrayBuffer> | null,
  probe: AssetProbe = probeImage,
): ProjectAssetsView {
  return new SnapshotAssetsView(sources, readBytes, probe);
}

/** Preserve an existing view, or adapt the legacy map input used by direct render callers. */
export function projectAssetsView(
  assets: ProjectAssets | ProjectAssetsView,
): ProjectAssetsView {
  return isProjectAssetsView(assets) ? assets : createProjectAssetsView(assets);
}

function isProjectAssetsView(
  assets: ProjectAssets | ProjectAssetsView,
): assets is ProjectAssetsView {
  return "info" in assets && "resolveOutput" in assets;
}

/** An output name resolved to its source; the bytes are loaded each time it is served. */
interface ResolvedOutput {
  path: string;
  contentType: string;
  source: string;
}

class SnapshotAssetsView implements ProjectAssetsView {
  readonly #info = new Map<string, ProjectAssetInfo | null>();
  readonly #outputs = new Map<string, ResolvedOutput | null>();
  readonly #ambiguities = new Map<string, readonly string[]>();
  readonly #candidates = new Map<string, string[]>();
  readonly #load: (source: string) => ProjectAsset | null;
  readonly #probe: AssetProbe;

  constructor(
    sources: Iterable<string>,
    load: (source: string) => ProjectAsset | null,
    probe: AssetProbe,
  ) {
    this.#load = load;
    this.#probe = probe;
    // Keys only: snapshot construction never reads, hashes or probes asset bytes.
    for (const source of sources) {
      const key = outputCandidateKey(source);
      const candidates = this.#candidates.get(key);
      if (candidates) candidates.push(source);
      else this.#candidates.set(key, [source]);
    }
    for (const candidates of this.#candidates.values()) candidates.sort(compareStrings);
  }

  info(source: string): ProjectAssetInfo | null {
    const cached = this.#info.get(source);
    if (cached !== undefined || this.#info.has(source)) return cached ?? null;
    // Outside the `try`: a failed load (a workspace that moved) must not read as a missing file.
    const asset = this.#load(source);
    let info: ProjectAssetInfo | null = null;
    if (asset instanceof Uint8Array) {
      try {
        info = this.#probe(asset, source);
      } catch {
        info = null;
      }
    } else if (asset !== null) {
      info = asset;
    }
    this.#info.set(source, info);
    return info;
  }

  resolveOutput(pathname: string): ServedProjectAsset | null {
    const resolved = this.#resolve(withoutCdnImagePrefix(pathname));
    if (resolved === null) return null;
    const asset = this.#load(resolved.source);
    return { ...resolved, bytes: asset instanceof Uint8Array ? asset : null };
  }

  #resolve(path: string): ResolvedOutput | null {
    const ambiguity = this.#ambiguities.get(path);
    if (ambiguity !== undefined) {
      throw new ProjectAssetOutputAmbiguityError(path, ambiguity);
    }
    const cached = this.#outputs.get(path);
    if (cached !== undefined || this.#outputs.has(path)) return cached ?? null;
    const key = requestedCandidateKey(path);
    if (key === null) {
      this.#outputs.set(path, null);
      return null;
    }
    const matches: ResolvedOutput[] = [];
    for (const source of this.#candidates.get(key) ?? []) {
      const info = this.info(source);
      if (!info || `/${imageOutputPath(source, info.hash)}` !== path) continue;
      matches.push({ path, contentType: imageContentType(info.format), source });
    }
    if (matches.length > 1) {
      const sources = matches.map((match) => match.source);
      this.#ambiguities.set(path, sources);
      throw new ProjectAssetOutputAmbiguityError(path, sources);
    }
    const resolved = matches[0] ?? null;
    this.#outputs.set(path, resolved);
    return resolved;
  }
}

/** Copy caller-owned values once; metadata and bytes then describe one revision. */
function ownProjectAssets(assets: ProjectAssets): ProjectAssets {
  const owned = new Map<string, ProjectAsset>();
  for (const [source, asset] of assets) {
    owned.set(source, asset instanceof Uint8Array ? new Uint8Array(asset) : { ...asset });
  }
  return owned;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function outputCandidateKey(source: string): string {
  return `${baseNameOf(source, true)}${extensionOf(source)}`;
}

function requestedCandidateKey(pathname: string): string | null {
  if (!pathname.startsWith("/_astro/")) return null;
  const filename = pathname.slice("/_astro/".length);
  const extension = extensionOf(filename);
  if (extension === "") return null;
  const stem = filename.slice(0, -extension.length);
  const separator = stem.lastIndexOf(".");
  if (separator <= 0 || !/^[0-9a-f]{8}$/.test(stem.slice(separator + 1))) return null;
  return `${stem.slice(0, separator)}${extension}`;
}

const CDN_IMAGE_PREFIX = "/cdn-cgi/image/";

function withoutCdnImagePrefix(pathname: string): string {
  if (!pathname.startsWith(CDN_IMAGE_PREFIX)) return pathname;
  const rest = pathname.slice(CDN_IMAGE_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? pathname : `/${rest.slice(slash + 1)}`;
}

/**
 * A `Bun.Glob` re-implementation covering `**`, `*`, `?` and `{a,b}`; extglob, character
 * classes and escapes match differently. Dotfiles are excluded, like `Bun.Glob.scan`.
 */
export function globMatcher(pattern: string): (entry: string) => boolean {
  const source = globToRegExpSource(pattern);
  const regexp = new RegExp(`^${source}$`);
  return (entry) =>
    !entry.split("/").some((segment) => segment.startsWith(".")) && regexp.test(entry);
}

function globToRegExpSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans zero or more directories, so `**\/*.md` matches a file in the base.
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const alternatives = pattern.slice(i + 1, end).split(",");
        out += `(?:${alternatives.map(globToRegExpSource).join("|")})`;
        i = end;
        continue;
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}
