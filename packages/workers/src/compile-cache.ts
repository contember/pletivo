/**
 * What one file compiled to, kept between renders: the work that depends only on
 * `(path, source, compiler)`. Freshness is `source ===`; see `docs/todos/023 §3–4`.
 * A cache is bound to the compiler that filled it; never share it between hosts.
 */

import type { ArtifactModuleKind } from "@pletivo/core/artifact";
import { BoundedLru } from "./bounded-lru.ts";
import type { AstroStyles } from "./compile/types.ts";

/** One file's compile, everything the file set decides left out. */
export interface CompiledFile {
  /** The source this was built from; comparing it is the whole freshness check. */
  source: string;
  /** Source interpretation; resolution is deliberately not cached with it. */
  kind: ArtifactModuleKind;
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
   */
  envNames: ReadonlyMap<string, readonly string[]> | null;
  /** The `<style>` blocks a `.astro` file declares, with its scope hash. Feeds `pageCss`. */
  styles: AstroStyles | null;
}

export interface CompileCache {
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
  for (const specifier of entry.specifiers) charge += specifier.length;
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
  return charge;
}

export function createCompileCache(options: CompileCacheOptions = {}): CompileCache {
  const held = new BoundedLru<CompiledFile>({
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  });
  return {
    get: (file) => held.get(file),
    set: (file, entry) => held.set(file, entry, chargeOf(entry)),
  };
}
