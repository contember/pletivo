/**
 * How the render isolate reads content files, and the host side that answers.
 *
 * Content deliberately does **not** go into the module map. The map is what the
 * isolate is content-addressed by, so putting a collection's markdown in it would
 * mint a new dynamic Worker on every edit — exactly the case a live preview makes
 * most often. Instead the isolate gets a binding back to the host and asks.
 *
 * That is compatible with `globalOutbound: null`, which stays: `globalOutbound`
 * governs `fetch()` and `connect()`, and `env` is a separate capability. The isolate
 * runs code the host just generated, so it keeps having no network — and still reads
 * the sources, because a binding is not the network.
 *
 * ## Why every call carries a `ref`
 *
 * `env.LOADER.get(id, code)` only runs `code` on a cache miss, so the binding is
 * created once and then serves every later request from a warm isolate. It therefore
 * cannot close over one request's sources. Measured in workerd: a host that answered
 * from a mutable module global returned the *wrong* project's bytes as soon as two
 * renders overlapped — a slow request read a fast one's content. The ref is opened
 * per render, travels in the isolate's request body, and comes back on every call, so
 * concurrent renders cannot see each other.
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

/**
 * The RPC surface the isolate calls. Structural rather than imported from
 * `@cloudflare/workers-types`, the same way `WorkerLoaderBinding` is: whatever the
 * host app implements it with — a loopback `WorkerEntrypoint`, a Durable Object
 * holding the site — has to satisfy exactly this and nothing more.
 */
export interface ContentBinding {
  /** Files under `dir` matching `pattern`, sorted by `entry`. */
  scan(ref: string, dir: string, pattern: string): Promise<ContentFileRef[]> | ContentFileRef[];
  /** A file's text, or `null` when the project has no such file. */
  read(ref: string, path: string): Promise<string | null> | string | null;
  /**
   * What a binary asset is, as far as anything downstream of it needs to know.
   * `null` when the project has no such file. Optional, so a host that carries no
   * binaries stays a valid binding and an `image()` schema fails by name instead.
   */
  image?(ref: string, path: string): Promise<ImageInfo | null> | ImageInfo | null;
}

/**
 * Everything a render learns about an image it cannot see.
 *
 * ## Why the bytes do not cross
 *
 * The obvious shape for this method is `bytes(ref, path): ArrayBuffer` — read the
 * image the way the isolate reads a markdown file. It is also the expensive one:
 * nothing inside the isolate consumes image *bytes*. `image()` in a collection schema
 * wants width, height and format; `getImage()` wants a URL, which is the source path
 * and a content hash. All four are derived, and all four are 40-odd bytes.
 *
 * Carrying the bytes instead would put a whole file across the RPC boundary for every
 * entry of every collection, on every render — a 200-entry collection of 300 kB photos
 * is 60 MB per page — and then hash it in JavaScript inside the isolate, which is the
 * one place with no native digest. Deriving it on the host costs the same read once,
 * where the file already is.
 *
 * ## Where the caching belongs
 *
 * On the project-owned asset view. It lives exactly as long as the snapshot whose
 * bytes it describes, so a new revision cannot inherit metadata keyed only by path.
 */
export type ImageInfo = ProjectAssetInfo;

/**
 * One binary file, as the host holds it.
 *
 * Bytes, or what the host already knows about them. The second form is not a
 * convenience: a site with 200 MiB of photos cannot put them in a Worker's 128 MiB
 * heap, so a real host keeps the files in R2 and a row per file — width, height,
 * format, hash, computed once when the file was uploaded — and hands *that* to a
 * render. Everything downstream needs the four fields and nothing else, which is what
 * makes the substitution possible at all.
 */
export type ProjectAsset = Uint8Array | ProjectAssetInfo;

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
}

/** Where the bytes come from, for the length of one render. */
export interface ContentStore {
  /**
   * `files` is the text map; `assets` is everything that is not text — images today.
   * They are two maps rather than one because a Worker's sources arrive as text and
   * its binaries do not, and merging them would force every caller to decide which
   * an unknown extension is.
   */
  open(
    files: ReadonlyMap<string, string>,
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
 * // ...and then, per request:
 * renderPage({ files, loader: env.LOADER, content: { binding: ctx.exports.PletivoContent({}), store: CONTENT } })
 * ```
 *
 * `ctx.exports.PletivoContent({})` takes an options object; called bare it throws,
 * and passed uncalled it is not serializable into a dynamic Worker's `env`.
 */
export class ContentFiles implements ContentBinding, ContentStore {
  readonly #open = new Map<string, ReadonlyMap<string, string>>();
  readonly #openAssets = new Map<string, ProjectAssetsView>();
  #next = 0;

  /** How many renders currently hold a handle. A leak shows up here. */
  get openCount(): number {
    return this.#open.size;
  }

  open(
    files: ReadonlyMap<string, string>,
    assets?: ProjectAssets | ProjectAssetsView,
  ): ContentHandle {
    const ref = `r${++this.#next}`;
    this.#open.set(ref, files);
    if (assets) this.#openAssets.set(ref, projectAssetsView(assets));
    return {
      ref,
      close: () => {
        this.#open.delete(ref);
        this.#openAssets.delete(ref);
      },
    };
  }

  scan(ref: string, dir: string, pattern: string): ContentFileRef[] {
    const files = this.#files(ref);
    const prefix = dir === "" ? "" : `${dir}/`;
    const match = globMatcher(pattern);
    const found: ContentFileRef[] = [];
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const entry = path.slice(prefix.length);
      if (entry === "" || !match(entry)) continue;
      found.push({ entry, path });
    }
    // Sorted here rather than by the caller, because the caller is the isolate and
    // this is the enumeration the Bun host sorts too — see `ContentScan.files`.
    found.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
    return found;
  }

  read(ref: string, path: string): string | null {
    return this.#files(ref).get(path) ?? null;
  }

  image(ref: string, path: string): ImageInfo | null | Promise<ImageInfo | null> {
    // `#files` first, so a call against a finished render is the same loud error here
    // as it is for `read` — an asset map is allowed to be absent, a ref is not.
    this.#files(ref);
    return this.#openAssets.get(ref)?.info(path) ?? null;
  }

  #files(ref: string): ReadonlyMap<string, string> {
    const files = this.#open.get(ref);
    if (!files) {
      throw new Error(
        `[pletivo-workers] no open project for content ref ${JSON.stringify(ref)} — ` +
          "the render that opened it has already finished",
      );
    }
    return files;
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
  return new MapProjectAssetsView(ownProjectAssets(assets), probe);
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

class MapProjectAssetsView implements ProjectAssetsView {
  readonly #info = new Map<string, ProjectAssetInfo | null>();
  readonly #outputs = new Map<string, ServedProjectAsset | null>();
  readonly #ambiguities = new Map<string, readonly string[]>();
  readonly #candidates = new Map<string, string[]>();

  constructor(
    readonly assets: ProjectAssets,
    readonly probe: AssetProbe,
  ) {
    // Keys only: snapshot construction never reads, hashes or probes asset bytes.
    for (const source of assets.keys()) {
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
    const asset = this.assets.get(source);
    if (!asset) {
      this.#info.set(source, null);
      return null;
    }
    try {
      const info = asset instanceof Uint8Array ? this.probe(asset, source) : asset;
      this.#info.set(source, info);
      return info;
    } catch {
      this.#info.set(source, null);
      return null;
    }
  }

  resolveOutput(pathname: string): ServedProjectAsset | null {
    const path = withoutCdnImagePrefix(pathname);
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
    const matches: ServedProjectAsset[] = [];
    for (const source of this.#candidates.get(key) ?? []) {
      const info = this.info(source);
      if (!info || `/${imageOutputPath(source, info.hash)}` !== path) continue;
      const asset = this.assets.get(source);
      matches.push({
        path,
        contentType: imageContentType(info.format),
        source,
        bytes: asset instanceof Uint8Array ? asset : null,
      });
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
 * A `Bun.Glob` pattern, as far as a content scan needs it.
 *
 * A re-implementation, and therefore a place the two hosts can disagree — the same
 * shape as the Tailwind candidate scanner. It covers what a `glob()` loader's
 * `pattern` realistically is: `**`, `*`, `?` and `{a,b}` alternation. Extended
 * globbing (`!(…)`, `+(…)`), character classes and escapes are not translated, so a
 * pattern using them matches differently here than under `Bun.Glob`.
 *
 * Dotfiles are excluded, matching `Bun.Glob.scan`'s `dot: false` default — otherwise
 * `**\/*.md` would pull in an editor's `.backup.md` on one host and not the other.
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
        // `**/` spans any number of directories, including none, so a pattern like
        // `**\/*.md` still matches a file sitting directly in the base.
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
