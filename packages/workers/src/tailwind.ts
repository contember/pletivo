/**
 * Tailwind v4 inside a Worker isolate.
 *
 * The `tailwindcss` package itself is pure JS with no dependencies, so the engine
 * runs unchanged. What does not run is everything around it: `@tailwindcss/node`
 * resolves `@import`s off disk, `@tailwindcss/oxide` is a native scanner that walks
 * the filesystem, and `optimize()` needs lightningcss. Only the scanner is load
 * bearing, so this module keeps `compile()` and replaces the rest — stylesheets are
 * resolved out of a virtual file map, and candidates are extracted with
 * `extractCandidates` below, from whatever the caller decides the content is.
 *
 * ## `compiler.build()` accumulates, so a compiler cannot be shared across renders
 *
 * Verified in `tailwindcss/dist/lib.mjs`: the compiler closes over one `Set`, every
 * `build(candidates)` call adds into it, and the CSS returned is compiled from the
 * *union* of everything that instance has ever been handed — a call that adds nothing
 * new even returns the previous result memoized. (`--custom-property` candidates go
 * the same way, through `theme.markUsedVariable`.)
 *
 * Nothing here caches a compiler today, so nothing here is wrong. It is written down
 * because the obvious optimisation is: reuse the compiler and skip the parse. Do that
 * and page A's utilities appear in page B's stylesheet, which is the exact thing
 * per-page CSS exists to stop. A cache has to be keyed by the candidate set, or it has
 * to re-create the compiler.
 */

import type { ModuleId } from "@pletivo/core/artifact";

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
  build(candidates: readonly string[]): string;
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
  /** Where `@import` resolves. Also the default content, when `candidates` is absent. */
  files: ReadonlyMap<string, string>;
  stylesheets: TailwindStylesheets;
  /**
   * What to build, when the caller knows the content better than a scan of `files` does
   * — the Workers host hands over the candidates of the page it just rendered.
   *
   * Defaulting to the scan keeps `files` doing the one job it always did for callers
   * that have no better answer, and keeps `scanCandidates` as the reference input the
   * `@tailwindcss/oxide` comparison in `docs/todos/016 §7` is stated against.
   */
  candidates?: readonly string[];
  /** Canonical CSS targets, in source import order for each logical importer. */
  styleTargets?: ReadonlyMap<ModuleId, readonly ModuleId[]>;
  /** Canonical target identities for the four host-embedded Tailwind stylesheets. */
  embeddedTargets?: ReadonlyMap<ModuleId, keyof TailwindStylesheets>;
}

export interface TailwindCompilation {
  css: string;
  /** Entry and project/artifact stylesheets compiled through its @import closure. */
  consumedStylesheets: readonly ModuleId[];
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
 * Otherwise the caller's `candidates` are built, or every non-CSS file in `files` is
 * scanned for them; the `@source` globs Tailwind reports in `sources` are not applied
 * yet, so a project that narrows its content with `@source` gets a superset — extra
 * candidates, never missing ones.
 */
export async function compileTailwind(options: CompileTailwindOptions): Promise<TailwindCompilation> {
  const { entry, files, stylesheets } = options;
  const source = sourceFor(entry, files);
  if (source === undefined) {
    throw new Error(
      `[pletivo-workers] tailwind entry ${JSON.stringify(entry)} is not in the file map`,
    );
  }

  const consumed = new Set<ModuleId>([entry]);
  const targetCursors = new Map<ModuleId, number>();

  const { compile } = await loadTailwind();
  const compiler = await compile(source, {
    // The value is opaque to Tailwind and comes back to loadStylesheet as importer identity.
    base: entry,
    from: entry,
    async loadStylesheet(id, base) {
      const targets = options.styleTargets?.get(base);
      let resolved: ModuleId;
      if (targets) {
        const cursor = targetCursors.get(base) ?? 0;
        const target = targets[cursor];
        if (target === undefined) {
          throw new Error(
            `[pletivo-workers] canonical CSS graph has no remaining target for ` +
              `${JSON.stringify(id)} from ${JSON.stringify(base)}`,
          );
        }
        targetCursors.set(base, cursor + 1);
        resolved = target;
      } else {
        // Retained for the standalone parity harness; page assembly always supplies C1 targets.
        resolved = id.startsWith(".") ? join(dirname(base), id) : id;
      }
      const embedded = options.embeddedTargets?.get(resolved);
      if (embedded !== undefined) {
        if (!isTailwindStylesheet(id, stylesheets) || embedded !== id) {
          throw new Error(
            `[pletivo-workers] canonical CSS target ${JSON.stringify(resolved)} does not match ` +
              `embedded stylesheet ${JSON.stringify(id)}`,
          );
        }
        consumed.add(resolved);
        return { path: resolved, base: resolved, content: stylesheets[embedded] };
      }
      if (isTailwindStylesheet(id, stylesheets)) {
        if (options.styleTargets) {
          throw new Error(
            `[pletivo-workers] canonical CSS target ${JSON.stringify(resolved)} is not registered ` +
              `for embedded stylesheet ${JSON.stringify(id)}`,
          );
        }
        return { path: `virtual:${id}`, base, content: stylesheets[id] };
      }
      if (isProjectCssModule(resolved)) {
        throw new Error(
          `[pletivo-workers] CSS module ${JSON.stringify(resolved)} cannot be loaded by Tailwind; ` +
            "the Workers CSS-modules pipeline is not implemented",
        );
      }
      const content = sourceFor(resolved, files);
      if (content === undefined) {
        throw new Error(
          `[pletivo-workers] cannot resolve stylesheet ${JSON.stringify(id)} ` +
            `from ${JSON.stringify(base)}`,
        );
      }
      consumed.add(resolved);
      return { path: resolved, base: resolved, content };
    },
    async loadModule(id) {
      throw new Error(
        `[pletivo-workers] cannot load ${JSON.stringify(id)}: the worker host has no ` +
          `module loader, so Tailwind JS plugins and configs are not supported`,
      );
    },
  });

  for (const importer of consumed) {
    const targets = options.styleTargets?.get(importer);
    if (targets === undefined) continue;
    const consumedCount = targetCursors.get(importer) ?? 0;
    if (consumedCount !== targets.length) {
      throw new Error(
        `[pletivo-workers] Tailwind consumed ${consumedCount} of ${targets.length} canonical ` +
          `stylesheet target(s) from ${JSON.stringify(importer)}`,
      );
    }
  }

  return {
    css: compiler.build(
      compiler.root === "none" ? [] : (options.candidates ?? scanCandidates(files)),
    ),
    consumedStylesheets: [...consumed],
  };
}

function isProjectCssModule(moduleId: ModuleId): boolean {
  return moduleId.startsWith("project:") && moduleId.endsWith(".module.css");
}

function sourceFor(moduleId: ModuleId, files: ReadonlyMap<string, string>): string | undefined {
  if (moduleId.startsWith("project:")) return files.get(moduleId.slice("project:".length));
  return files.get(moduleId);
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

/** Candidates from decoded HTML `class` attributes only. */
export function extractHtmlClassCandidates(html: string): string[] {
  const candidates = new Set<string>();
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening === -1) break;
    if (html.startsWith("<!--", opening)) {
      const end = html.indexOf("-->", opening + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    const tag = readHtmlTag(html, opening);
    if (!tag) {
      cursor = opening + 1;
      continue;
    }
    if (!tag.closing) collectClassAttributes(tag.source, candidates);
    cursor = tag.end;
    if (!tag.closing && (tag.name === "style" || tag.name === "script")) {
      const close = findRawTextClose(lower, tag.name, cursor);
      cursor = close === -1 ? html.length : close;
    }
  }
  return [...candidates];
}

function findRawTextClose(html: string, name: "style" | "script", from: number): number {
  const prefix = `</${name}`;
  let cursor = from;
  while (cursor < html.length) {
    const found = html.indexOf(prefix, cursor);
    if (found === -1) return -1;
    const delimiter = html[found + prefix.length];
    if (delimiter === ">" || delimiter === "/" || /\s/.test(delimiter ?? "")) return found;
    cursor = found + prefix.length;
  }
  return -1;
}

interface HtmlTag {
  name: string;
  source: string;
  end: number;
  closing: boolean;
}

function readHtmlTag(html: string, opening: number): HtmlTag | null {
  let cursor = opening + 1;
  const closing = html[cursor] === "/";
  if (closing) cursor++;
  while (/\s/.test(html[cursor] ?? "")) cursor++;
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/.test(html[cursor] ?? "")) cursor++;
  if (cursor === nameStart) return null;
  const name = html.slice(nameStart, cursor).toLowerCase();
  let quote = "";
  for (; cursor < html.length; cursor++) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return { name, source: html.slice(nameStart + name.length, cursor), end: cursor + 1, closing };
    }
  }
  return null;
}

function collectClassAttributes(source: string, candidates: Set<string>): void {
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s|\//.test(source[cursor] ?? "")) cursor++;
    const nameStart = cursor;
    while (!/[\s=/>]/.test(source[cursor] ?? ">")) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] !== "=") continue;
    cursor++;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    const quote = source[cursor] === "\"" || source[cursor] === "'" ? source[cursor++] : "";
    const valueStart = cursor;
    if (quote) while (cursor < source.length && source[cursor] !== quote) cursor++;
    else while (cursor < source.length && !/[\s>]/.test(source[cursor])) cursor++;
    const value = source.slice(valueStart, cursor);
    if (quote && source[cursor] === quote) cursor++;
    if (name !== "class") continue;
    for (const candidate of extractCandidates(decodeHtmlEntities(value))) candidates.add(candidate);
  }
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  ast: "*",
  colon: ":",
  comma: ",",
  commat: "@",
  dollar: "$",
  equals: "=",
  excl: "!",
  gt: ">",
  hat: "^",
  lbrack: "[",
  lt: "<",
  num: "#",
  percnt: "%",
  period: ".",
  plus: "+",
  quest: "?",
  quot: "\"",
  rbrack: "]",
  semi: ";",
  sol: "/",
  vert: "|",
};

function decodeHtmlEntities(value: string): string {
  // This intentionally covers numeric references and the punctuation subset Tailwind
  // class syntax can contain; it is not a complete WHATWG named-entity table.
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]+;)/gi, (entity, body: string) => {
    if (body[0] !== "#") return HTML_ENTITIES[body.slice(0, -1).toLowerCase()] ?? entity;
    const numeric = body.endsWith(";") ? body.slice(0, -1) : body;
    const hexadecimal = numeric[1]?.toLowerCase() === "x";
    const digits = numeric.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "�";
    return String.fromCodePoint(codePoint);
  });
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
