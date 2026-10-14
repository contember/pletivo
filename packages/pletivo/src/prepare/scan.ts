/**
 * Which specifiers a project asks for, and which of them a Worker cannot answer.
 *
 * The Workers host resolves a specifier against a virtual file map. Relative paths
 * land on a key; a bare specifier lands on nothing, because there is no node_modules
 * in an isolate and no way to put one there. So before anything can be vendored, the
 * set has to be known — and known from the *sources*, not from `package.json`, since
 * a dependency that is never imported costs module-map bytes for nothing.
 */

import type { ArtifactModuleKind } from "@pletivo/core/artifact";
import { cssImports } from "@pletivo/core/css-imports";

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
function loaderFor(extension: string): "ts" | "tsx" {
  return extension === ".tsx" || extension === ".jsx" ? "tsx" : "ts";
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
export function importableSource(
  file: string,
  source: string,
  kind?: ArtifactModuleKind,
): string | null {
  const extension = kind === undefined ? extensionOf(file) : `.${kind}`;
  if (!SCANNABLE.has(extension)) return null;
  if (extension !== ".astro") return source;
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
export function specifiersOf(file: string, source: string, kind?: ArtifactModuleKind): string[] {
  const extension = kind === undefined ? extensionOf(file) : `.${kind}`;
  if (extension === ".cjs" || extension === ".cts") {
    throw new ImportScanError(
      file,
      `CommonJS ${extension} modules cannot run in the Workers module graph`,
    );
  }
  if (extension === ".css") return cssImports(source);
  const code = importableSource(file, source, kind);
  if (code === null) return [];
  try {
    const imports = transpiler(loaderFor(extension)).scanImports(code);
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
  // Locale helpers over the `i18n` config the artifact carries.
  "astro:i18n",
]);

/** Astro virtual modules that only exist where a build pipeline does. */
const UNSUPPORTED_SPECIFIERS = new Set([
  "astro:transitions",
  "astro:transitions/client",
  "astro:middleware",
  "astro:actions",
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

/** The prefixes a Vite plugin claims; `/@` is handled as relative by `classifySpecifier`. */
function isVirtual(specifier: string): boolean {
  return (
    specifier.startsWith("virtual:") ||
    specifier.startsWith("\0virtual:") ||
    specifier.startsWith("@id/")
  );
}
