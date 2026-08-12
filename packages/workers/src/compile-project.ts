/**
 * Turns a virtual file map into the module bundle a Worker Loader executes.
 *
 * This is the whole of the "no filesystem" problem in one place. The Bun host lets
 * Bun's loader compile `.astro` on import and resolve the rest off disk; here every
 * module the isolate will ever see has to be named up front, so the project is
 * compiled as a unit: `.astro` through `@astrojs/compiler`, `.js` verbatim, and the
 * import specifiers rewritten to point at each other by bundle name.
 *
 * The Loader takes JavaScript, and the compiler copies `.astro` frontmatter into its
 * output verbatim — `export interface Props` included. So every module goes through
 * `stripTypes` on the way out, which also compiles the JSX in a `.tsx` page. That
 * runs *here*, in the host worker, which is the only place it can: workerd has no
 * `eval`, so nothing in the isolate could do it.
 */

import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import { compileAstro, parseAstro, type AstroCompiler } from "./astro-compiler.ts";
import { collectSpecifiers, resolveSpecifier, rewriteImports } from "./rewrite-imports.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  JSX_RUNTIME_MODULE_NAME,
  RUNTIME_MODULES,
  RUNTIME_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import { isCollectableCss } from "./project-css.ts";
import { JSX_IMPORT_SPECIFIER, stripTypes, TranspileError } from "./transpile.ts";

/** One `<style>` block from a `.astro` file, in the order it was written. */
export interface StyleBlock {
  /** `<style is:global>`. Gated on the component rendering, not on its scope class. */
  global: boolean;
  css: string;
}

export interface AstroStyles {
  /** The compiler's scope hash — the page carries it as `class="astro-{scope}"`. */
  scope: string;
  blocks: StyleBlock[];
}

export interface CompiledProject {
  /** Module name -> JavaScript, ready for `env.LOADER`. Includes `@pletivo/runtime`. */
  modules: Record<string, string>;
  /** Project path -> its module name, for the files that produced one. */
  moduleNames: ReadonlyMap<string, string>;
  /** Project path -> the `<style>` blocks it declares. */
  styles: ReadonlyMap<string, AstroStyles>;
  /** Project path -> the project paths it imports, in execution order. */
  imports: ReadonlyMap<string, string[]>;
  /**
   * Project path -> the stylesheets it imports for their side effect.
   *
   * Kept apart from `imports` because they are not edges the isolate walks — a `.css`
   * module is empty in the bundle. They are what the project stylesheet is built from;
   * see `project-css.ts`.
   */
  cssImports: ReadonlyMap<string, string[]>;
  /**
   * Set when something in the project imports the content API, which is what puts
   * `pletivo-content.js` in the bundle. `null` otherwise, and then the bundle carries
   * none of it — the collection runtime is roughly a megabyte, and most projects have
   * no collections.
   */
  content: ProjectContent | null;
}

export interface ProjectContent {
  /**
   * Bundle name of the project's `content.config.*`, or `null` when it has none.
   * The isolate imports it to get the collection definitions — there is no other way
   * to obtain them, since `defineCollection` is a function call, not data.
   */
  configModule: string | null;
}

/**
 * The compiler bound to the `astro.wasm` the host worker's bundler embedded.
 *
 * Injectable because that binding only exists inside a real Worker — on Bun the
 * `.wasm` import resolves to a path, so tests hand in a compiler of their own.
 */
const bundled: AstroCompiler = { transform: compileAstro, parse: parseAstro };

/** Compiled to JavaScript by `@astrojs/compiler`. */
const COMPILED = ".astro";
/** Already JavaScript: carried into the bundle untouched. */
const VERBATIM = [".js", ".mjs"];
/**
 * Resolvable, but empty in the bundle.
 *
 * A frontmatter `import "./styles.css"` is a Vite side effect: the file is collected
 * into the project stylesheet (`cssImports` below, then `project-css.ts`) and the
 * module itself contributes nothing at run time. `.scss`/`.sass` resolve too, but
 * nothing compiles them yet — see `docs/todos/016`.
 */
const EMPTY = [".css", ".scss", ".sass"];
/** Compiled by sucrase rather than by `@astrojs/compiler`. */
const TRANSPILED = [".ts", ".tsx", ".jsx", ".mts", ".cts"];
/** Of those, the ones whose `<` is an element and not a type assertion. */
const WITH_JSX = [".tsx", ".jsx"];

/** Every extension that becomes a module in the bundle. */
const MODULE_EXTENSIONS = [COMPILED, ...VERBATIM, ...TRANSPILED, ...EMPTY];

/** Extensions that carry executable code, as opposed to a resolvable stub. */
const EXECUTABLE = [COMPILED, ...VERBATIM, ...TRANSPILED];

/** Whether a project path becomes a module the isolate can run. */
export function isExecutableModule(file: string): boolean {
  return EXECUTABLE.includes(extensionOf(file));
}

/**
 * Specifiers that name pletivo's content API rather than a project file.
 *
 * The bare ones are what a project writes. `astro:content` and `astro/loaders` are
 * Astro's own and the Bun host already answers to both — `astro-plugin.ts` registers
 * them as Bun virtual modules, for `.tsx` as much as for `.astro` — and
 * `pletivo/content` is the package's own `exports` entry. A project written against
 * either renders on both hosts with nothing changed.
 */
const CONTENT_API_MODULES = new Set(["astro:content", "astro/loaders", "pletivo/content"]);

/**
 * …and this is the shape *this repo* writes.
 *
 * Its fixtures predate the published package, so they reach into
 * `packages/pletivo/src/content/collection` by relative path — which
 * `resolveSpecifier` lands on the same project-root-relative key from every one of
 * them, however deep the importer sits. A path is not a package, so it can never be
 * in a virtual file map; matching it is what lets a fixture written for the Bun host
 * be previewed without being rewritten first.
 */
const PLETIVO_CONTENT_PATH = /(?:^|\/)pletivo\/src\/content\/(?:collection|index)(?:\.ts)?$/;

/** Whether a resolved specifier is the content API. */
export function isContentApi(resolved: string): boolean {
  return CONTENT_API_MODULES.has(resolved) || PLETIVO_CONTENT_PATH.test(resolved);
}

/**
 * Where a project's collection definitions live, in the order the Bun host looks —
 * `initCollections` takes the first that exists, so a project with both gets the same
 * one on either host.
 *
 * Matched as a suffix rather than resolved against a root, because `compileProject`
 * is handed the file map alone and the root only arrives with the request.
 */
const CONTENT_CONFIG_CANDIDATES = [
  "src/content.config.ts",
  "src/content.config.mts",
  "src/content.config.mjs",
  "src/content.config.js",
  "src/content/config.ts",
  "src/content/config.mts",
  "src/content/config.mjs",
  "src/content/config.js",
];

function findContentConfig(files: ReadonlyMap<string, string>): string | null {
  for (const candidate of CONTENT_CONFIG_CANDIDATES) {
    for (const file of files.keys()) {
      if (file === candidate || file.endsWith(`/${candidate}`)) return file;
    }
  }
  return null;
}

function extensionOf(file: string): string {
  const at = file.lastIndexOf(".");
  return at === -1 ? "" : file.slice(at).toLowerCase();
}

/**
 * The name a project file takes in the bundle.
 *
 * Every module sits at the bundle root, so a relative specifier is always
 * `./<name>` no matter how deep the importer was — the isolate never has to
 * resolve a path. `seen` keeps two project paths that flatten to the same name
 * apart.
 */
function bundleName(file: string, seen: Map<string, string>): string {
  const base = file.replace(/[^A-Za-z0-9._-]/g, "_") + ".js";
  let name = base;
  for (let n = 2; seen.has(name) && seen.get(name) !== file; n++) {
    name = `${base.slice(0, -3)}.${n}.js`;
  }
  seen.set(name, file);
  return name;
}

/**
 * The compiler emits one `import '<file>?astro&type=style&index=N&lang.css'` per
 * `<style>` block, and nothing in the bundle answers to that specifier. The Bun
 * host strips the same imports for the same reason — the CSS is already in
 * `result.css`.
 */
function stripStyleImports(code: string): string {
  return code.replace(/import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?/g, "");
}

/**
 * Pair each `result.css[]` entry with the `<style>` block that produced it, so the
 * `is:global` ones can be told apart.
 *
 * Reading `is:global` off the source rather than looking for a `:where(.astro-…)`
 * marker in the compiled CSS is the same choice `classifyCompilerCss` makes on the
 * Bun host, for the same reason: the compiler cannot scope `body`, `html` or
 * `:root`, so a scoped block holding only those rules looks global but is not.
 */
export async function classifyStyles(
  css: string[],
  source: string,
  compiler: AstroCompiler = bundled,
): Promise<StyleBlock[]> {
  const { ast } = await compiler.parse(source);
  const blocks: StyleBlock[] = [];
  let index = 0;

  const visit = (node: Node): void => {
    if (is.element(node) && node.name === "style") {
      // The compiler drops blocks that compile to nothing, so skip them here too or
      // the 1:1 pairing with `css[index]` slips by one.
      const text = node.children.filter(is.text).map((child) => child.value).join("");
      if (text.replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0) return;
      if (index >= css.length) {
        throw new Error(
          "[pletivo-workers] more non-empty <style> blocks than css entries " +
            `(${css.length}); the @astrojs/compiler output contract may have changed`,
        );
      }
      blocks.push({
        global: node.attributes.some((attribute) => attribute.name === "is:global"),
        css: css[index++],
      });
      return;
    }
    if (is.parent(node)) for (const child of node.children) visit(child);
  };
  visit(ast);

  if (index !== css.length) {
    throw new Error(
      `[pletivo-workers] ${index} non-empty <style> block(s) but ${css.length} css entries; ` +
        "the @astrojs/compiler output contract may have changed",
    );
  }
  return blocks;
}

/** A project file the isolate cannot be given, and why. */
export class UnsupportedFileError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot compile ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedFileError";
  }
}

/**
 * Compile every module-shaped file in the map.
 *
 * Files the bundle has no use for (`.md`, images, `astro.config.mjs` outside the
 * graph) are simply not modules and are skipped; a file that *is* reachable but
 * needs a transpiler throws, because silently omitting it turns into an
 * unresolved import inside the isolate, which is much harder to read.
 */
export async function compileProject(
  files: ReadonlyMap<string, string>,
  compiler: AstroCompiler = bundled,
): Promise<CompiledProject> {
  const modules: Record<string, string> = { ...RUNTIME_MODULES };
  const moduleNames = new Map<string, string>();
  const styles = new Map<string, AstroStyles>();
  const imports = new Map<string, string[]>();
  const cssImports = new Map<string, string[]>();
  const takenNames = new Map<string, string>();

  /** Both edge sets a module contributes, read from the one specifier list. */
  const recordEdges = (file: string, code: string): void => {
    const specifiers = collectSpecifiers(code);
    imports.set(file, resolveEdges(file, specifiers, files, isExecutableModule));
    cssImports.set(file, resolveEdges(file, specifiers, files, isCollectableCss));
  };

  // Names first: rewriting an import needs the target's name, whichever order the
  // files come in.
  for (const file of files.keys()) {
    if (MODULE_EXTENSIONS.includes(extensionOf(file))) {
      moduleNames.set(file, bundleName(file, takenNames));
    }
  }

  let usesContent = false;

  const resolve = (resolved: string): string | null => {
    // The one bare specifier the bundle answers to on its own: sucrase writes it into
    // every module that holds JSX, and it names a package, not a project file.
    if (resolved === JSX_IMPORT_SPECIFIER) return `./${JSX_RUNTIME_MODULE_NAME}`;
    // The content API is the other. Everything that reaches for it — the config
    // module and every page that queries a collection — has to land on the *same*
    // module, or `initCollections` would fill a store the page never reads.
    if (isContentApi(resolved)) {
      usesContent = true;
      return `./${CONTENT_MODULE_NAME}`;
    }
    const name = moduleNames.get(resolved);
    return name === undefined ? null : `./${name}`;
  };

  for (const [file, source] of files) {
    const extension = extensionOf(file);
    const name = moduleNames.get(file);
    if (name === undefined) continue;

    if (EMPTY.includes(extension)) {
      modules[name] = "export {};\n";
      continue;
    }

    if (VERBATIM.includes(extension)) {
      modules[name] = rewriteImports(source, { importer: file, resolve });
      recordEdges(file, source);
      continue;
    }

    if (TRANSPILED.includes(extension)) {
      const code = transpile(source, { file, jsx: WITH_JSX.includes(extension) });
      // The JSX import sucrase prepends is not a project edge, and `resolveEdges`
      // drops it for the same reason it drops any specifier outside the file map.
      recordEdges(file, code);
      modules[name] = rewriteImports(code, { importer: file, resolve });
      continue;
    }

    const result = await compiler.transform(source, {
      filename: file,
      internalURL: `./${RUNTIME_MODULE_NAME}`,
      sourcemap: false,
      resolvePath: async (specifier) => specifier,
    });
    const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 1);
    if (errors.length > 0) {
      throw new UnsupportedFileError(
        file,
        `the Astro compiler reported\n${errors.map((error) => `  ${error.text}`).join("\n")}`,
      );
    }

    if (result.css.length > 0) {
      const blocks = await classifyStyles(result.css, source, compiler);
      if (blocks.length > 0) styles.set(file, { scope: result.scope, blocks });
    }

    // Types out before the graph is read: `import type` is not an edge, and with
    // `keepUnusedImports` nothing else in the prologue moves.
    const code = transpile(stripStyleImports(result.code), { file });
    recordEdges(file, code);
    modules[name] = rewriteImports(code, { importer: file, resolve });
  }

  let content: ProjectContent | null = null;
  if (usesContent) {
    modules[CONTENT_MODULE_NAME] = GENERATED_MODULES[CONTENT_MODULE_NAME];
    const configFile = findContentConfig(files);
    content = { configModule: configFile === null ? null : (moduleNames.get(configFile) ?? null) };
  }

  return { modules, moduleNames, styles, imports, cssImports, content };
}

/**
 * `stripTypes`, reported as an unsupported file.
 *
 * For `.astro` the position sucrase reports counts lines in the *compiled* module,
 * not in the source the author wrote — and the compiler puts the whole template on
 * one line — so an unqualified "(3:14)" points at a file nobody has. Say so.
 */
function transpile(code: string, options: { file: string; jsx?: boolean }): string {
  try {
    return stripTypes(code, options);
  } catch (error) {
    if (!(error instanceof TranspileError)) throw error;
    const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
    const where = options.file.endsWith(COMPILED)
      ? " (position is in the compiled output, not the .astro source)"
      : "";
    throw new UnsupportedFileError(options.file, detail + where);
  }
}

/**
 * Project paths an importer reaches that `keep` accepts, deduped, in order.
 *
 * The compiler emits both `import X from './X.astro'` and
 * `import * as $$module1 from './X.astro'` for the same component — one edge, not
 * two. Anything outside the file map is dropped: there is nothing to walk to.
 */
function resolveEdges(
  importer: string,
  specifiers: string[],
  files: ReadonlyMap<string, string>,
  keep: (file: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const edges: string[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(importer, specifier);
    if (seen.has(resolved) || !files.has(resolved)) continue;
    if (!keep(resolved)) continue;
    seen.add(resolved);
    edges.push(resolved);
  }
  return edges;
}
