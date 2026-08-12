/**
 * Turns a virtual file map into the module bundle a Worker Loader executes.
 *
 * This is the whole of the "no filesystem" problem in one place. The Bun host lets
 * Bun's loader compile `.astro` on import and resolve the rest off disk; here every
 * module the isolate will ever see has to be named up front, so the project is
 * compiled as a unit: `.astro` through `@astrojs/compiler`, `.js` verbatim, and the
 * import specifiers rewritten to point at each other by bundle name.
 *
 * What is deliberately *not* here: any TypeScript. The Loader takes JavaScript and
 * workerd has no `eval`, so `.ts` / `.tsx` — including TypeScript inside `.astro`
 * frontmatter — cannot be compiled at request time. `compileProject` reports those
 * files rather than emitting something that will fail to parse inside the isolate.
 */

import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import { compileAstro, parseAstro, type AstroCompiler } from "./astro-compiler.ts";
import { collectSpecifiers, resolveSpecifier, rewriteImports } from "./rewrite-imports.ts";
import { RUNTIME_MODULES, RUNTIME_MODULE_NAME } from "./generated/runtime-modules.ts";

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
 * A frontmatter `import "./styles.css"` is a Vite side effect: the Bun host collects
 * the file into the page's stylesheet and the module itself contributes nothing at
 * run time. There is no stylesheet pipeline here, so the import resolves to an empty
 * module and the CSS is dropped — see `docs/todos/016`.
 */
const EMPTY = [".css", ".scss", ".sass"];
/** Needs a transpiler in the isolate, which there is not one of. */
const NEEDS_TRANSPILER = [".ts", ".tsx", ".jsx", ".mts", ".cts"];

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
  const takenNames = new Map<string, string>();

  // Names first: rewriting an import needs the target's name, whichever order the
  // files come in.
  for (const file of files.keys()) {
    const extension = extensionOf(file);
    if (extension === COMPILED || VERBATIM.includes(extension) || EMPTY.includes(extension)) {
      moduleNames.set(file, bundleName(file, takenNames));
    }
  }

  const resolve = (resolved: string): string | null => {
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
      imports.set(file, resolveEdges(file, collectSpecifiers(source), files));
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

    const code = stripStyleImports(result.code);
    imports.set(file, resolveEdges(file, collectSpecifiers(code), files));
    modules[name] = rewriteImports(code, { importer: file, resolve });
  }

  return { modules, moduleNames, styles, imports };
}

/**
 * Project paths an importer reaches, deduped, in order.
 *
 * The compiler emits both `import X from './X.astro'` and
 * `import * as $$module1 from './X.astro'` for the same component — one edge, not
 * two. Files with no module (`.css`, and anything outside the map) are dropped:
 * they contribute nothing the cascade order can walk through.
 */
function resolveEdges(
  importer: string,
  specifiers: string[],
  files: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  const edges: string[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(importer, specifier);
    if (seen.has(resolved) || !files.has(resolved)) continue;
    const extension = extensionOf(resolved);
    if (!(extension === COMPILED || VERBATIM.includes(extension))) continue;
    seen.add(resolved);
    edges.push(resolved);
  }
  return edges;
}

/** Whether `file` needs a transpiler the isolate does not have. */
export function needsTranspiler(file: string): boolean {
  return NEEDS_TRANSPILER.includes(extensionOf(file));
}
