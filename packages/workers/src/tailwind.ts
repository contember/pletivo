/**
 * Tailwind v4 inside a Worker isolate.
 *
 * The `tailwindcss` package itself is pure JS with no dependencies, so the engine
 * runs unchanged. What does not run is everything around it: `@tailwindcss/node`
 * resolves `@import`s off disk, `@tailwindcss/oxide` is a native scanner that walks
 * the filesystem, and `optimize()` needs lightningcss. Only the scanner is load
 * bearing, so this module keeps `compile()` and replaces the rest — stylesheets are
 * resolved out of a virtual file map, and candidates are extracted from that same
 * map by `extractCandidates` below.
 */

/** The slice of `tailwindcss` this host uses. Validated at run time by `loadTailwind`. */
interface TailwindModule {
  compile(css: string, options: TailwindCompileOptions): Promise<TailwindCompiler>;
}

interface TailwindCompileOptions {
  base: string;
  from: string;
  loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }>;
  loadModule(
    id: string,
    base: string,
    hint: "plugin" | "config",
  ): Promise<{ path: string; base: string; module: unknown }>;
}

interface TailwindCompiler {
  /** Where Tailwind decided content lives: `"none"` disables scanning entirely. */
  root: null | "none" | { base: string; pattern: string };
  sources: { base: string; pattern: string; negated: boolean }[];
  build(candidates: string[]): string;
}

/**
 * Tailwind's own stylesheets, keyed by the specifier that reaches them. The package
 * exports them, but they are CSS — the host's bundler has to embed the text and hand
 * it over here.
 */
export interface TailwindStylesheets {
  tailwindcss: string;
  "tailwindcss/preflight": string;
  "tailwindcss/theme": string;
  "tailwindcss/utilities": string;
}

export interface CompileTailwindOptions {
  /** Key in `files` of the stylesheet that imports Tailwind. */
  entry: string;
  /** The whole project: stylesheets resolve `@import` against it, everything else is scanned. */
  files: ReadonlyMap<string, string>;
  stylesheets: TailwindStylesheets;
}

/** Extensions that only ever hold CSS, never class names. */
const NOT_SCANNED = [".css"];

async function loadTailwind(): Promise<TailwindModule> {
  const module: unknown = await import("tailwindcss");
  if (typeof module !== "object" || module === null) {
    throw new Error("[pletivo-workers] `tailwindcss` did not load");
  }
  const compile = Reflect.get(module, "compile");
  if (typeof compile !== "function") {
    throw new Error("[pletivo-workers] `tailwindcss` does not export compile()");
  }
  return { compile };
}

function isTailwindStylesheet(
  id: string,
  stylesheets: TailwindStylesheets,
): id is keyof TailwindStylesheets {
  return Object.hasOwn(stylesheets, id);
}

/** Directory part of a virtual path, `""` at the root. */
function dirname(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
}

function join(base: string, id: string): string {
  const out: string[] = [];
  for (const segment of `${base}/${id}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Compile the entry stylesheet against the virtual project.
 *
 * `root === "none"` (`@source not inline` / an explicit opt-out) disables scanning.
 * Otherwise every non-CSS file in `files` is scanned; the `@source` globs Tailwind
 * reports in `sources` are not applied yet, so a project that narrows its content
 * with `@source` gets a superset — extra candidates, never missing ones.
 */
export async function compileTailwind(options: CompileTailwindOptions): Promise<string> {
  const { entry, files, stylesheets } = options;
  const source = files.get(entry);
  if (source === undefined) {
    throw new Error(
      `[pletivo-workers] tailwind entry ${JSON.stringify(entry)} is not in the file map`,
    );
  }

  const { compile } = await loadTailwind();
  const compiler = await compile(source, {
    base: dirname(entry),
    from: entry,
    async loadStylesheet(id, base) {
      if (isTailwindStylesheet(id, stylesheets)) {
        return { path: `virtual:${id}`, base, content: stylesheets[id] };
      }
      const resolved = id.startsWith(".") ? join(base, id) : id;
      const content = files.get(resolved);
      if (content === undefined) {
        throw new Error(
          `[pletivo-workers] cannot resolve stylesheet ${JSON.stringify(id)} ` +
            `from ${JSON.stringify(base)}`,
        );
      }
      return { path: resolved, base: dirname(resolved), content };
    },
    async loadModule(id) {
      throw new Error(
        `[pletivo-workers] cannot load ${JSON.stringify(id)}: the worker host has no ` +
          `module loader, so Tailwind JS plugins and configs are not supported`,
      );
    },
  });

  return compiler.build(compiler.root === "none" ? [] : scanCandidates(files));
}

/** Every candidate in the project, from the virtual file map rather than a filesystem walk. */
export function scanCandidates(files: ReadonlyMap<string, string>): string[] {
  const all = new Set<string>();
  for (const [file, content] of files) {
    if (NOT_SCANNED.some((extension) => file.endsWith(extension))) continue;
    for (const candidate of extractCandidates(content)) all.add(candidate);
  }
  return [...all].sort();
}

// Character tables modelled on oxide's boundary rules
// (crates/oxide/src/extractor/boundary.rs). Over-extraction is safe: Tailwind's own
// parseCandidate() throws away anything that is not a utility, so recall matters and
// precision does not.
//
// Measured against @tailwindcss/oxide 4.3.3 over 7569 files from this repo: of the
// 1039 candidates oxide reports, 80 are missed and 2 of those compile to CSS under
// the default design system (`border`, from CSS text inside a `<style>` block, and
// `table`, from the word in markdown prose — neither is a class the page uses). Of
// the 7178 extra spans this finds, 0 compile to CSS.
const WORD = new Uint8Array(128);
const BEFORE = new Uint8Array(128);
const AFTER = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@!%-./:*&<>~+?#$^|") {
  WORD[c.charCodeAt(0)] = 1;
}
for (const c of "\t\n\f\r \"'`.}>") BEFORE[c.charCodeAt(0)] = 1;
for (const c of "\t\n\f\r \"'`]{=\\<") AFTER[c.charCodeAt(0)] = 1;

const OPEN_SQUARE = 91;
const CLOSE_SQUARE = 93;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const SINGLE_QUOTE = 39;
const DOUBLE_QUOTE = 34;
/** `.`, `,`, `:`, `;`, `!`, `?` — punctuation that can never end a candidate. */
const TRAILING = new Set([46, 44, 58, 59, 33, 63]);
/** Depth limit for re-scanning inside bracket and quote groups. */
const MAX_DEPTH = 6;
/**
 * How long a bracket group may run before it stops being a candidate.
 *
 * Nothing in the boundary rules ends a `[`, so an unmatched or merely distant `]`
 * makes one span out of everything between them — in a 626 kB JSON file, the whole
 * file. That span is not a utility and never could be, but the nested re-scan below
 * then launches one sub-scan per bracket and quote inside it, each covering the
 * remainder: 449 seconds for that one file, measured on the static dogfood site's `asset-manifest.json`.
 *
 * Past this length the opening bracket is treated as ordinary punctuation, so the
 * scan walks into the group instead of swallowing it and the interior is still read.
 * 2 KiB leaves room for the longest real candidate — an arbitrary value holding a
 * `data:` URI — with an order of magnitude to spare.
 */
const MAX_SPAN = 2048;

function isWord(code: number): boolean {
  return code < 128 && WORD[code] === 1;
}

function isTableHit(table: Uint8Array, source: string, at: number): boolean {
  const code = source.charCodeAt(at);
  return code < 128 && table[code] === 1;
}

/** Pull every possible utility class out of one source file. */
export function extractCandidates(source: string): string[] {
  const out = new Set<string>();
  scan(source, 0, source.length, out, 0);
  return [...out];
}

function scan(source: string, from: number, to: number, out: Set<string>, depth: number): void {
  let i = from;
  while (i < to) {
    if (!isWord(source.charCodeAt(i)) && source.charCodeAt(i) !== OPEN_SQUARE) {
      i++;
      continue;
    }

    const start = i;
    const stack: number[] = [];
    const limit = Math.min(to, start + MAX_SPAN);
    while (i < to) {
      // A group that runs this long is not a candidate. Give the opener back to the
      // outer walk, which then reads the interior as ordinary text.
      if (i >= limit) {
        i = start + 1;
        break;
      }
      const code = source.charCodeAt(i);
      if (code === OPEN_SQUARE || code === OPEN_PAREN) {
        stack.push(code === OPEN_SQUARE ? CLOSE_SQUARE : CLOSE_PAREN);
        i++;
      } else if (stack.length > 0) {
        if (code === stack[stack.length - 1]) stack.pop();
        else if (code === CLOSE_SQUARE || code === CLOSE_PAREN) break; // unbalanced
        i++;
      } else if (isWord(code)) {
        i++;
      } else {
        break;
      }
    }

    let end = i;
    while (end > start && TRAILING.has(source.charCodeAt(end - 1))) end--;

    if (end > start) {
      const beforeOk = start === 0 || isTableHit(BEFORE, source, start - 1);
      const afterOk = end >= source.length || isTableHit(AFTER, source, end);
      if (beforeOk && afterOk) out.add(source.slice(start, end));

      // `class={["gap-y-4"]}`, `classList.add('line-through')` — the candidates are
      // inside the group, where the outer span's boundaries do not reach.
      if (depth < MAX_DEPTH) {
        for (let k = start; k < end; k++) {
          const code = source.charCodeAt(k);
          if (
            code === OPEN_SQUARE ||
            code === OPEN_PAREN ||
            code === SINGLE_QUOTE ||
            code === DOUBLE_QUOTE
          ) {
            scan(source, k + 1, end, out, depth + 1);
          }
        }
      }
    }

    if (i === start) i++;
  }
}
