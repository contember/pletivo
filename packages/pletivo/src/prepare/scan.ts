/**
 * Which specifiers a project asks for, and which of them a Worker cannot answer.
 *
 * The Workers host resolves a specifier against a virtual file map. Relative paths
 * land on a key; a bare specifier lands on nothing, because there is no node_modules
 * in an isolate and no way to put one there. So before anything can be vendored, the
 * set has to be known — and known from the *sources*, not from `package.json`, since
 * a dependency that is never imported costs module-map bytes for nothing.
 */

const SCANNABLE = new Set([".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);

export class ImportScanError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`${file}: ${reason}`);
    this.name = "ImportScanError";
  }
}

/** Loader to read a file with, keyed by extension. `.astro` frontmatter is TypeScript. */
function loaderFor(file: string): "ts" | "tsx" {
  return file.endsWith(".tsx") || file.endsWith(".jsx") ? "tsx" : "ts";
}

const transpilers = new Map<string, Bun.Transpiler>();

function transpiler(loader: "ts" | "tsx"): Bun.Transpiler {
  let found = transpilers.get(loader);
  if (!found) {
    found = new Bun.Transpiler({ loader });
    transpilers.set(loader, found);
  }
  return found;
}

/**
 * The part of a file that can hold an import.
 *
 * For `.astro` that is the frontmatter and only the frontmatter: the template below
 * it may contain a code block showing an import, and reading that as one would send
 * prepare hunting for a package the project never uses.
 */
export function importableSource(file: string, source: string): string | null {
  if (!SCANNABLE.has(extensionOf(file))) return null;
  if (!file.endsWith(".astro")) return source;
  // Frontmatter opens the file or there is none — Astro's own rule, and the reason
  // this cannot be a search: `---` inside the template is a horizontal rule.
  const opened = source.length - source.trimStart().length;
  if (!source.startsWith("---", opened)) return "";
  const start = source.indexOf("\n", opened + 3);
  if (start === -1) return "";
  const end = source.indexOf("\n---", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/** Every module specifier a source names, type-only imports already elided. */
export function specifiersOf(file: string, source: string): string[] {
  const extension = extensionOf(file);
  if (extension === ".cjs" || extension === ".cts") {
    throw new ImportScanError(
      file,
      `CommonJS ${extension} modules cannot run in the Workers module graph`,
    );
  }
  if (extension === ".css") return cssImports(source);
  const code = importableSource(file, source);
  if (code === null) return [];
  try {
    const imports = transpiler(loaderFor(file)).scanImports(code);
    if (usesCommonJsRequire(code)) {
      throw new ImportScanError(
        file,
        "CommonJS require() cannot run in the Workers module graph",
      );
    }
    if (usesCommonJsExports(code)) {
      throw new ImportScanError(
        file,
        "CommonJS module.exports/exports assignments cannot run in the Workers module graph",
      );
    }
    // Bun reports its own JSX lowering helpers as require-call entries. Source-level
    // require() was rejected above, so no real project edge is lost by dropping them.
    return imports
      .filter((entry) => entry.kind !== "require-call")
      .map((entry) => entry.path);
  } catch (error) {
    if (error instanceof ImportScanError) throw error;
    throw new ImportScanError(
      file,
      `could not parse imports: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Static CSS imports are module edges; url() assets stay with the asset pipeline. */
function cssImports(source: string): string[] {
  const imports: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipCssTrivia(source, cursor);
    if (cursor >= source.length) break;
    if (source[cursor] !== "@" || source.slice(cursor + 1, cursor + 7).toLowerCase() !== "import") {
      cursor = skipCssToken(source, cursor);
      continue;
    }
    const boundary = source[cursor + 7];
    if (boundary !== undefined && /[A-Za-z0-9_-]/.test(boundary)) {
      cursor += 7;
      continue;
    }
    cursor = skipCssTrivia(source, cursor + 7);
    const parsed = readCssImportTarget(source, cursor);
    if (parsed) {
      imports.push(parsed.value);
      cursor = parsed.end;
    } else {
      cursor = skipCssToken(source, cursor);
    }
  }
  return imports;
}

interface CssValue {
  value: string;
  end: number;
}

function readCssImportTarget(source: string, cursor: number): CssValue | null {
  const quote = source[cursor];
  if (quote === "\"" || quote === "'") return readCssString(source, cursor, quote);
  if (source.slice(cursor, cursor + 3).toLowerCase() !== "url") return null;
  let at = skipCssTrivia(source, cursor + 3);
  if (source[at] !== "(") return null;
  at = skipCssTrivia(source, at + 1);
  const innerQuote = source[at];
  if (innerQuote === "\"" || innerQuote === "'") {
    const parsed = readCssString(source, at, innerQuote);
    if (!parsed) return null;
    const closing = skipCssTrivia(source, parsed.end);
    return source[closing] === ")" ? { value: parsed.value, end: closing + 1 } : null;
  }
  let raw = "";
  while (at < source.length && source[at] !== ")") {
    if (source.startsWith("/*", at)) return null;
    if (/\s/.test(source[at])) {
      const closing = skipCssTrivia(source, at);
      return source[closing] === ")"
        ? { value: decodeCssEscapes(raw), end: closing + 1 }
        : null;
    }
    if (source[at] === "\\" && at + 1 < source.length) {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(source.slice(at + 1));
      if (!hex) {
        raw += source.slice(at, at + 2);
        at += 2;
        continue;
      }
      const whitespace = /\s/.test(source[at + 1 + hex[0].length] ?? "") ? 1 : 0;
      const end = at + 1 + hex[0].length + whitespace;
      raw += source.slice(at, end);
      at = end;
      continue;
    }
    raw += source[at];
    at++;
  }
  return source[at] === ")" && raw.length > 0
    ? { value: decodeCssEscapes(raw), end: at + 1 }
    : null;
}

function readCssString(source: string, cursor: number, quote: string): CssValue | null {
  let raw = "";
  for (let at = cursor + 1; at < source.length; at++) {
    const char = source[at];
    if (char === quote) return { value: decodeCssEscapes(raw), end: at + 1 };
    if (char === "\n" || char === "\r") return null;
    if (char === "\\" && at + 1 < source.length) {
      raw += source.slice(at, at + 2);
      at++;
      continue;
    }
    raw += char;
  }
  return null;
}

function skipCssTrivia(source: string, cursor: number): number {
  let at = cursor;
  while (at < source.length) {
    if (/\s/.test(source[at])) {
      at++;
      continue;
    }
    if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      return end === -1 ? source.length : skipCssTrivia(source, end + 2);
    }
    break;
  }
  return at;
}

function skipCssToken(source: string, cursor: number): number {
  if (source.startsWith("/*", cursor)) return skipCssTrivia(source, cursor);
  const quote = source[cursor];
  if (quote === "\"" || quote === "'") return readCssString(source, cursor, quote)?.end ?? source.length;
  if (source[cursor] === "\\") return Math.min(cursor + 2, source.length);
  return cursor + 1;
}

function decodeCssEscapes(value: string): string {
  let decoded = "";
  for (let at = 0; at < value.length; at++) {
    if (value[at] !== "\\") {
      decoded += value[at];
      continue;
    }
    at++;
    if (at >= value.length) break;
    if (value[at] === "\n") continue;
    if (value[at] === "\r") {
      if (value[at + 1] === "\n") at++;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(at));
    if (!hex) {
      decoded += value[at];
      continue;
    }
    const codePoint = Number.parseInt(hex[0], 16);
    decoded += String.fromCodePoint(codePoint === 0 || codePoint > 0x10ffff ? 0xfffd : codePoint);
    at += hex[0].length - 1;
    if (/\s/.test(value[at + 1] ?? "")) at++;
  }
  return decoded;
}

function usesCommonJsExports(source: string): boolean {
  const tokens = javascriptTokens(source);
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index] === "module" && tokens[index + 1] === "." && tokens[index + 2] === "exports") {
      return true;
    }
    if (tokens[index] === "exports" && tokens[index + 1] === ".") return true;
  }
  return false;
}

function usesCommonJsRequire(source: string): boolean {
  const tokens = javascriptTokens(source);
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] === "require" && tokens[index + 1] === "(") return true;
  }
  return false;
}

function javascriptTokens(source: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (source.startsWith("//", at)) {
      const end = source.indexOf("\n", at + 2);
      at = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "/" && canStartRegularExpression(tokens[tokens.length - 1])) {
      at = skipJavascriptRegularExpression(source, at);
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      at = skipJavascriptQuoted(source, at, char);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = at + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++;
      tokens.push(source.slice(at, end));
      at = end;
      continue;
    }
    tokens.push(char);
    at++;
  }
  return tokens;
}

function canStartRegularExpression(previous: string | undefined): boolean {
  return previous === undefined || ["(", "[", "{", "=", ":", ",", ";", "!", "?", "return", "throw"].includes(previous);
}

function skipJavascriptRegularExpression(source: string, cursor: number): number {
  let inClass = false;
  for (let at = cursor + 1; at < source.length; at++) {
    if (source[at] === "\\") {
      at++;
      continue;
    }
    if (source[at] === "[") {
      inClass = true;
      continue;
    }
    if (source[at] === "]") {
      inClass = false;
      continue;
    }
    if (source[at] !== "/" || inClass) continue;
    at++;
    while (at < source.length && /[A-Za-z]/.test(source[at])) at++;
    return at;
  }
  return source.length;
}

function skipJavascriptQuoted(source: string, cursor: number, quote: string): number {
  for (let at = cursor + 1; at < source.length; at++) {
    if (source[at] === "\\") {
      at++;
      continue;
    }
    if (source[at] === quote) return at + 1;
  }
  return source.length;
}

/**
 * What one specifier is asked for: the export names, or everything.
 *
 * A bundler that is told which names a package is imported for can drop the rest —
 * which is not only smaller but *correct*: `Bun.build` on `@iconify/utils`' own entry
 * emits an export list naming 83 functions and defines a handful of them, and the
 * Loader then refuses the bundle with "Export 'buildParsedSVG' is not defined in
 * module". Bundling `export { getIconData, iconToSVG } from "…"` instead does not
 * reach that path, and is 3 kB smaller besides.
 */
export interface SpecifierUse {
  names: Set<string>;
  /** A namespace import, a dynamic `import()` or an `export *`: nothing may be dropped. */
  whole: boolean;
}

/** `import <clause> from "x"` / `export <clause> from "x"`. Clause may be empty. */
const FROM_STATEMENT = /(?:^|[\s;}])(?:import|export)\s+([^'"]*?)\s*from\s*(["'])([^"']+)\2/g;
/** `import "x"` — a side-effect import, which the `from` form cannot match. */
const BARE_STATEMENT = /(?:^|[\s;}])import\s*(["'])([^"']+)\1/g;
/** `import("x")` — no clause to read, so the whole module is in play. */
const DYNAMIC_STATEMENT = /\bimport\s*\(\s*(["'])([^"']+)\1/g;
/** What a name has to look like for a generated re-export to name it. */
const EXPORT_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|default)$/;

/**
 * The export names each specifier is imported for, across one source file.
 *
 * Read from the same slice `specifiersOf` reads, so a code block in an `.astro`
 * template cannot contribute a name.
 */
export function specifierUses(file: string, source: string): Map<string, SpecifierUse> {
  const uses = new Map<string, SpecifierUse>();
  const code = importableSource(file, source);
  if (code === null) return uses;

  const record = (specifier: string): SpecifierUse => {
    let use = uses.get(specifier);
    if (!use) {
      use = { names: new Set<string>(), whole: false };
      uses.set(specifier, use);
    }
    return use;
  };

  for (const match of code.matchAll(FROM_STATEMENT)) {
    const clause = match[1].trim();
    const use = record(match[3]);
    if (clause.includes("*")) {
      use.whole = true;
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    // Anything before the braces (or a clause with none) is a default import.
    const outside = braces ? clause.slice(0, braces.index).replace(/,\s*$/, "").trim() : clause;
    if (outside.length > 0 && !outside.startsWith("type ")) use.names.add("default");
    for (const entry of braces ? braces[1].split(",") : []) {
      const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (EXPORT_NAME.test(name)) use.names.add(name);
    }
  }
  // A side-effect import asks for no name at all — a stylesheet, or a module whose
  // point is what running it does. Recorded so it is still vendored.
  for (const match of code.matchAll(BARE_STATEMENT)) record(match[2]);
  for (const match of code.matchAll(DYNAMIC_STATEMENT)) record(match[2]).whole = true;

  return uses;
}

export function extensionOf(file: string): string {
  const at = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  return at === -1 || at < slash ? "" : file.slice(at).toLowerCase();
}

/** What the Workers host answers on its own — `compile-project.ts` names every one. */
const HOST_SPECIFIERS = new Set([
  "astro:content",
  "astro/loaders",
  "pletivo/content",
  "pletivo/jsx-runtime",
  "pletivo/astro-shim",
  "@pletivo/runtime/jsx-runtime",
  "@pletivo/runtime/astro-shim",
  "pletivo:image",
  "astro:env/client",
  "astro:env/server",
  // `getImage()` needs an image's dimensions, and the host worker reads them off the
  // bytes it holds. See `packages/workers/src/astro-assets.ts`.
  "astro:assets",
]);

/** Astro virtual modules that only exist where a build pipeline does. */
const UNSUPPORTED_SPECIFIERS = new Set([
  "astro:transitions",
  "astro:transitions/client",
  "astro:middleware",
  "astro:actions",
  "astro:i18n",
  "astro:components",
  "astro:schema",
]);

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "console", "crypto", "diagnostics_channel",
  "dns", "events", "fs", "http", "https", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "stream", "string_decoder",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

/** How prepare has to treat one specifier. */
export type SpecifierKind =
  | "relative"
  | "host"
  | "builtin"
  | "virtual"
  | "unsupported"
  | "vendor";

export function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "relative";
  if (HOST_SPECIFIERS.has(specifier)) return "host";
  // Built-ins are distinct so prepare can reject them instead of claiming a host
  // external the Workers compiler does not expose.
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return "builtin";
  if (isVirtual(specifier)) return "virtual";
  if (UNSUPPORTED_SPECIFIERS.has(specifier) || specifier.startsWith("astro:")) {
    return "unsupported";
  }
  return "vendor";
}

/** The prefixes a Vite plugin claims. Same test `vite-plugins.ts` uses. */
export function isVirtual(specifier: string): boolean {
  return (
    specifier.startsWith("virtual:") ||
    specifier.startsWith("\0virtual:") ||
    specifier.startsWith("/@") ||
    specifier.startsWith("@id/")
  );
}
