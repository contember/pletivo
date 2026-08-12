/**
 * Which specifiers a project asks for, and which of them a Worker cannot answer.
 *
 * The Workers host resolves a specifier against a virtual file map. Relative paths
 * land on a key; a bare specifier lands on nothing, because there is no node_modules
 * in an isolate and no way to put one there. So before anything can be vendored, the
 * set has to be known — and known from the *sources*, not from `package.json`, since
 * a dependency that is never imported costs module-map bytes for nothing.
 */

const SCANNABLE = new Set([".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts"]);

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
  const code = importableSource(file, source);
  if (code === null) return [];
  try {
    return transpiler(loaderFor(file)).scanImports(code).map((entry) => entry.path);
  } catch {
    // A file this host cannot parse is a build failure elsewhere, with a much better
    // message than anything prepare could invent. Contribute nothing and move on.
    return [];
  }
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

/** What the Workers host answers on its own — `compile-project.ts` names all three. */
const HOST_SPECIFIERS = new Set([
  "astro:content",
  "astro/loaders",
  "pletivo/content",
  "pletivo/jsx-runtime",
  "pletivo/jsx-dev-runtime",
  "astro:env/client",
  "astro:env/server",
]);

/**
 * Astro virtual modules that only exist where a build pipeline does.
 *
 * `astro:assets` is the one that matters: `getImage()` probes an image file for its
 * dimensions and registers an output path, and an isolate has neither the bytes nor
 * anywhere to write. Vendoring the module body would produce a component that renders
 * a broken `src` instead of failing, which is strictly worse.
 */
const UNSUPPORTED_SPECIFIERS = new Set([
  "astro:assets",
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
  // `nodejs_compat` is on in the render isolate, so the Loader answers these itself.
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
