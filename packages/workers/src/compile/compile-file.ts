import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import type { ArtifactModuleKind } from "@pletivo/core/artifact";
import { compileAstro, parseAstro, type AstroCompiler } from "../astro-compiler.ts";
import type { CompileCache, CompiledFile } from "../compile-cache.ts";
import { IMPORT_META_ENV_GLOBAL } from "../env.ts";
import { collectImportedNames, collectSpecifiers } from "../rewrite-imports.ts";
import { stripTypes, TranspileError } from "../transpile.ts";
import { COMPILED } from "./module-kind.ts";
import { UnsupportedFileError, type SourceModule } from "./source-module.ts";
import type { AstroStyles, StyleBlock } from "./types.ts";

/**
 * The compiler bound to the `astro.wasm` the host worker's bundler embedded.
 *
 * Injectable because that binding only exists inside a real Worker — on Bun the
 * `.wasm` import resolves to a path, so tests hand in a compiler of their own.
 */
export const bundled: AstroCompiler = { transform: compileAstro, parse: parseAstro };

/**
 * One module's compile, from the cache when it holds this exact source and kind.
 *
 * Written to the cache only once the file has fully compiled, so a compiler diagnostic
 * or a sucrase failure never poisons an entry.
 */
export async function compileCached(
  module: SourceModule,
  compiler: AstroCompiler,
  cache: CompileCache | undefined,
): Promise<CompiledFile> {
  const held = cache?.get(module.compilePath);
  if (held !== undefined && held.source === module.source && held.kind === module.kind) return held;
  const entry = await compileFile(module, compiler);
  cache?.set(module.compilePath, entry);
  return entry;
}

/**
 * Everything about one file that depends only on its path, its bytes and the
 * compiler — which is all of the expensive work, and therefore all a cache holds.
 * What the file *set* decides is `linkModule`.
 */
async function compileFile(module: SourceModule, compiler: AstroCompiler): Promise<CompiledFile> {
  const { source, compilePath, kind } = module;
  if (kind === "js") return fileEntry(source, source, null, kind);
  if (kind === "json") {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new UnsupportedFileError(
        compilePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return fileEntry(source, `export default ${JSON.stringify(value)};\n`, null, kind);
  }
  if (kind === "ts" || kind === "tsx" || kind === "jsx") {
    return fileEntry(
      source,
      transpile(source, { file: compilePath, jsx: kind === "tsx" || kind === "jsx" }),
      null,
      kind,
    );
  }

  const result = await compiler.transform(source, {
    filename: compilePath,
    internalURL: "pletivo/astro-shim",
    sourcemap: false,
    resolvePath: async (specifier) => specifier,
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 1);
  if (errors.length > 0) {
    throw new UnsupportedFileError(
      compilePath,
      `the Astro compiler reported\n${errors.map((error) => `  ${error.text}`).join("\n")}`,
    );
  }

  let declared: AstroStyles | null = null;
  if (result.css.length > 0) {
    const blocks = await classifyStyles(result.css, source, compiler);
    if (blocks.length > 0) declared = { scope: result.scope, blocks };
  }

  // Types out before the graph is read: `import type` is not an edge, and with
  // `keepUnusedImports` nothing else in the prologue moves.
  return fileEntry(
    source,
    transpile(stripStyleImports(result.code), { file: compilePath }),
    declared,
    kind,
  );
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
 * `import.meta.env`, which a Worker Loader module does not have.
 *
 * V8 hands `import.meta` to the *host*, so nothing a generated module could assign
 * would be visible to another module's `import.meta`. The only way to answer it is the
 * way Vite does — substitution — with the values behind a global so a rotated secret
 * does not recompile the project.
 *
 * A textual replacement, and it says so: the same three tokens inside a string literal
 * are rewritten too. That is Vite's own failure mode with `define`. It runs after
 * sucrase, on generated JavaScript, so `.astro` frontmatter and `.tsx` are covered by
 * one pass.
 */
const IMPORT_META_ENV = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;

function substituteImportMetaEnv(code: string): { code: string; used: boolean } {
  if (!IMPORT_META_ENV.test(code)) return { code, used: false };
  IMPORT_META_ENV.lastIndex = 0;
  return { code: code.replace(IMPORT_META_ENV, `globalThis.${IMPORT_META_ENV_GLOBAL}`), used: true };
}

/**
 * One cache entry, from the two texts the rest of the compile needs.
 *
 * `text` is the file's JavaScript *before* substitution — the raw source for `.js`, the
 * transpiled code for the rest — and it is what the specifiers and the `astro:env`
 * names are read off. `code` is the substituted one, which is what `rewriteImports`
 * runs over. Two texts, not one: the specifier collection must not see
 * `import.meta.env` rewritten. `code` is `null` when substitution did not fire and the
 * text *is* the source, so a plain `.js` module costs a pointer.
 */
function fileEntry(
  source: string,
  text: string,
  styles: AstroStyles | null,
  kind: ArtifactModuleKind,
): CompiledFile {
  const substituted = substituteImportMetaEnv(text);
  const specifiers = collectSpecifiers(text);
  return {
    source,
    kind,
    code: substituted.code === source ? null : substituted.code,
    importMetaEnv: substituted.used,
    specifiers,
    envNames: envNamesOf(text, specifiers),
    styles,
  };
}

/**
 * The names one file takes from `astro:env/client` and `astro:env/server`.
 *
 * Carried per file rather than accumulated in the walk, because the walk is what a
 * cache hit skips — and these are the generated module's export list, so a dropped
 * name is the isolate refusing to start rather than an undefined value.
 */
function envNamesOf(
  text: string,
  specifiers: readonly string[],
): ReadonlyMap<string, readonly string[]> | null {
  let names: Map<string, readonly string[]> | null = null;
  for (const specifier of new Set(specifiers)) {
    const imported = collectImportedNames(text, specifier);
    if (imported.length === 0) continue;
    (names ??= new Map()).set(specifier, imported);
  }
  return names;
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
