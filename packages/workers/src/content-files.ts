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

import { imageContentHash, readImageDimensions } from "@pletivo/core/image";

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
 * On the host, and keyed by the bytes rather than by the path. The isolate is
 * content-addressed by its module map, so it survives content edits by design — an
 * isolate-side cache keyed by path would answer with a stale size after an image was
 * replaced, and would have to read the bytes to find out. `ContentFiles` below caches
 * against the `Uint8Array` it was handed, which is exactly as long-lived as the bytes
 * are: a host that keeps its asset map (a Durable Object, a preview server) probes
 * each image once for the life of the map, and one that rebuilds the array per render
 * pays per render and is never wrong.
 */
export interface ImageInfo {
  width: number;
  height: number;
  /** `png` / `jpeg` / `gif` / `webp` / `svg`, as the file's own header says. */
  format: string;
  /** `md5(bytes)`, first 8 hex characters — what names `_astro/<name>.<hash>.<ext>`. */
  hash: string;
}

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
export type ProjectAsset = Uint8Array | ImageInfo;

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
  open(files: ReadonlyMap<string, string>, assets?: ProjectAssets): ContentHandle;
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
  readonly #openAssets = new Map<string, ProjectAssets>();
  #next = 0;

  /** How many renders currently hold a handle. A leak shows up here. */
  get openCount(): number {
    return this.#open.size;
  }

  open(files: ReadonlyMap<string, string>, assets?: ProjectAssets): ContentHandle {
    const ref = `r${++this.#next}`;
    this.#open.set(ref, files);
    if (assets) this.#openAssets.set(ref, assets);
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

  image(ref: string, path: string): ImageInfo | null {
    // `#files` first, so a call against a finished render is the same loud error here
    // as it is for `read` — an asset map is allowed to be absent, a ref is not.
    this.#files(ref);
    const asset = this.#openAssets.get(ref)?.get(path);
    if (!asset) return null;
    return assetInfo(asset, path);
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

/**
 * Probed images, keyed by the bytes themselves.
 *
 * Weak, so it cannot outlive the map the caller holds, and keyed by identity, so it
 * can never answer for other bytes — see `ImageInfo` for why the cache lives out here
 * rather than in the isolate. Module-level because both readers want the same answer
 * and both run per render: the binding, for an `image()` schema, and `compileProject`,
 * for an ESM-imported one. Without it a project with 200 images would re-read and
 * re-hash all 200 on every page.
 */
const probed = new WeakMap<Uint8Array, ImageInfo>();

/** What one asset is, whether the host handed bytes or the answer itself. */
export function assetInfo(asset: ProjectAsset, path: string): ImageInfo {
  return asset instanceof Uint8Array ? probeImage(asset, path) : asset;
}

/** Dimensions and content hash of one image, read once per distinct `Uint8Array`. */
export function probeImage(bytes: Uint8Array, path: string): ImageInfo {
  const cached = probed.get(bytes);
  if (cached) return cached;
  const info: ImageInfo = {
    ...readImageDimensions(bytes, path),
    hash: imageContentHash(bytes),
  };
  probed.set(bytes, info);
  return info;
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
