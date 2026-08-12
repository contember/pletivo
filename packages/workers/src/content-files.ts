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
}

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
  open(files: ReadonlyMap<string, string>): ContentHandle;
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
  #next = 0;

  /** How many renders currently hold a handle. A leak shows up here. */
  get openCount(): number {
    return this.#open.size;
  }

  open(files: ReadonlyMap<string, string>): ContentHandle {
    const ref = `r${++this.#next}`;
    this.#open.set(ref, files);
    return { ref, close: () => void this.#open.delete(ref) };
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
