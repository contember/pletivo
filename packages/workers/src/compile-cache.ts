/**
 * What one file compiled to, kept between renders: the work that depends only on
 * `(path, source, compiler)`. Freshness is `source ===`; see `docs/todos/023 §3–4`.
 * The check does not compare the compiler: an in-memory cache is bound to the one that
 * filled it, and a cache that outlives the process keys by `COMPILED_FILE_FORMAT` and the
 * host's compilers, see `CompileCache`.
 */

import type { ScopedStyleStrategy } from "@pletivo/core/astro-host/scoped-style";
import type { ArtifactTrailingSlash } from "@pletivo/core/artifact";
import { BoundedLru } from "./bounded-lru.ts";
import type { ImportMetaGlob } from "./compile/import-meta-glob.ts";
import type { ModuleKind } from "./compile/module-kind.ts";
import type { AstroStyles } from "./compile/types.ts";

/**
 * The version of `CompiledFile`'s shape and meaning. Bump it whenever a field of
 * `CompiledFile` changes, or what a compile produces for the same input does: a change to
 * `@pletivo/core`'s `markdownModule` (the `.md` output), or to this package's exact
 * `sucrase` and `acorn` pins in `package.json`.
 */
export const COMPILED_FILE_FORMAT = "1";

/** One file's compile, everything the file set decides left out. */
export interface CompiledFile {
  /** The source this was built from; comparing it is the whole freshness check. */
  source: string;
  /** Source interpretation; resolution is deliberately not cached with it. */
  kind: ModuleKind;
  /**
   * The JavaScript `rewriteImports` runs over, after `import.meta.env` substitution.
   * `null` means "the source itself", so an unchanged module is not stored twice.
   */
  code: string | null;
  /** Whether the substitution fired, so the isolate must install the global it rewrote to. */
  importMetaEnv: boolean;
  /** Every specifier the file imports, read off the pre-substitution text, not `code`. */
  specifiers: readonly string[];
  /**
   * Per raw specifier, the statically imported names; `null` when there are none.
   * Resolution maps them to `astro:env` aliases, so the resolved result is not cached.
   * A `Map`, which JSON does not round-trip: a store that serialises entries converts it and
   * parses the stored record back, or a hit loses the `astro:env` imports.
   */
  envNames: ReadonlyMap<string, readonly string[]> | null;
  /** The `<style>` blocks a `.astro` file declares, with its scope hash. Feeds `pageCss`. */
  styles: AstroStyles | null;
  /**
   * A `.astro` file's processed `<script>` bodies, by the index `$$renderScript` names;
   * `null` for one that loads an external `src`. Served to the browser, never executed here.
   */
  scripts: readonly (string | null)[];
  /** Compiled with source annotations; only `.astro` output differs, so only it is `true`. */
  annotated: boolean;
  /** The `.astro` scoped-style strategy it compiled with; `undefined` for every other kind. */
  scopedStyleStrategy: ScopedStyleStrategy | undefined;
  /** The `.astro` `compact` it compiled with; `undefined` for every other kind. */
  compressHTML: boolean | undefined;
  /** The `trailingSlash` a `.md` module's `url` was built with; `undefined` for every other kind. */
  trailingSlash: ArtifactTrailingSlash | undefined;
  /** `import.meta.glob` calls, replaced by placeholders in `code`; linking expands them. */
  globs: readonly ImportMetaGlob[];
  /** The `MdxCompiler` identity an `.mdx` module compiled under; `undefined` for every other kind. */
  mdx: string | undefined;
  /** An `.mdx` module's `client:component-path` values as spelled; linking rewrites them. */
  componentPaths: readonly string[];
}

/**
 * Where compiled files are kept between renders. Either answer may be a promise, so a cache
 * can sit over an async store; the compile awaits both.
 *
 * A store answers a miss for an entry it cannot read and drops one it cannot hold. A rejection
 * is a failure of the host's store, and it fails the compile, whether from `get` or from `set`.
 *
 * `compileCached` reads and writes file by file, one round trip each, so a host keeps an
 * in-memory cache such as `createCompileCache` in front of a slow store.
 *
 * A cache that outlives the process keys its entries by `COMPILED_FILE_FORMAT` plus the
 * identity of the compilers the host runs: the Astro compiler's version for `.astro`, the
 * `MdxCompiler` identity for `.mdx`. Sucrase and acorn are pinned exactly; the format covers them.
 */
export interface CompileCache {
  get(file: string): CompiledFile | undefined | Promise<CompiledFile | undefined>;
  set(file: string, entry: CompiledFile): void | Promise<void>;
}

/** A cache that answers at once, as the in-memory one does. */
export interface SyncCompileCache extends CompileCache {
  get(file: string): CompiledFile | undefined;
  set(file: string, entry: CompiledFile): void;
}

export interface CompileCacheOptions {
  maxBytes?: number;
}

/** 32 MiB of a Worker's 128 MiB heap: sized to hold one large project (`023 §1`), evicting beyond it. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Bounds a project of thousands of tiny modules by count too. */
const DEFAULT_MAX_ENTRIES = 4096;

/** An entry's charge, in string length: the byte count for ASCII source, near enough otherwise. */
function chargeOf(entry: CompiledFile): number {
  let charge = entry.source.length + (entry.code?.length ?? 0);
  for (const specifier of [...entry.specifiers, ...entry.componentPaths]) charge += specifier.length;
  if (entry.envNames !== null) {
    for (const [specifier, names] of entry.envNames) {
      charge += specifier.length;
      for (const name of names) charge += name.length;
    }
  }
  if (entry.styles !== null) {
    charge += entry.styles.scope.length;
    for (const block of entry.styles.blocks) charge += block.css.length;
  }
  for (const script of entry.scripts) charge += script?.length ?? 0;
  return charge;
}

export function createCompileCache(options: CompileCacheOptions = {}): SyncCompileCache {
  const held = new BoundedLru<CompiledFile>({
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  });
  return {
    get: (file) => held.get(file),
    set: (file, entry) => held.set(file, entry, chargeOf(entry)),
  };
}
