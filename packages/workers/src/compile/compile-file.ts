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

/** The compiler bound to the embedded `astro.wasm`; only works inside a real Worker, so tests inject their own. */
export const bundled: AstroCompiler = { transform: compileAstro, parse: parseAstro };

/**
 * One module's compile, from the cache when it holds this exact source and kind.
 * Cached only after a full compile, so a failure never poisons an entry.
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

/** What depends only on the file's path, bytes and the compiler; the file set's part is `linkModule`. */
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
 * Pair each `result.css[]` entry with its `<style>` block to tell `is:global` apart.
 * Read off the source, not the compiled CSS: a scoped block of only `body`/`html`/`:root`
 * rules compiles unscoped yet is not global.
 */
async function classifyStyles(
  css: string[],
  source: string,
  compiler: AstroCompiler,
): Promise<StyleBlock[]> {
  const { ast } = await compiler.parse(source);
  const blocks: StyleBlock[] = [];
  let index = 0;

  const visit = (node: Node): void => {
    if (is.element(node) && node.name === "style") {
      // The compiler drops empty blocks; skip them too or the pairing slips by one.
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

/** Drops the compiler's per-`<style>` `?astro&type=style` imports; the CSS is already in `result.css`. */
function stripStyleImports(code: string): string {
  return code.replace(/import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?/g, "");
}

/**
 * `import.meta.env`, which a Loader module cannot be given, substituted with a global
 * so a rotated secret does not recompile. Textual: it rewrites inside strings too.
 */
const IMPORT_META_ENV = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;

function substituteImportMetaEnv(code: string): { code: string; used: boolean } {
  if (!IMPORT_META_ENV.test(code)) return { code, used: false };
  IMPORT_META_ENV.lastIndex = 0;
  return { code: code.replace(IMPORT_META_ENV, `globalThis.${IMPORT_META_ENV_GLOBAL}`), used: true };
}

/**
 * One cache entry. Specifiers and `astro:env` names are read off `text`, the JavaScript
 * before `import.meta.env` substitution, which must not see the rewrite.
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
 * The names one file imports, per specifier. Carried per file so a cache hit keeps
 * them: a dropped `astro:env` export stops the isolate from starting.
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

/** `stripTypes`, reported as an unsupported file; for `.astro` the position is in the compiled output. */
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
