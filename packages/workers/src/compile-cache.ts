/**
 * What one file compiled to, kept between renders.
 *
 * Everything in `compileProject` that costs anything depends only on `(path, source,
 * compiler)`: the Astro wasm transform is 72 % of the per-file work, sucrase 26 %,
 * `collectSpecifiers` 2 % (`docs/todos/023 §4`). `rewriteImports` and the edge
 * resolution depend on the whole file *set* and were measured at 2 ms for a whole
 * project, so they stay outside — which is also the correctness argument. A hit still
 * runs `rewriteImports`, so every side effect that lives inside `resolve` is reproduced
 * for free: `usesContent` and the content-config seed, `usesImages`, `usedEnv`, the
 * image metadata modules, the `?raw`/`?url` modules and `urlAssets`, and the artifact
 * binder's used set. Only the three effects that happen *outside* `resolve` have to be
 * carried, and they are the three fields below `code`.
 *
 * **Freshness is `source ===`, and nothing else.** `===` compares two strings by their
 * contents, so an unchanged file hits whether or not the store handed back the same
 * object; a store that can answer "nothing changed" (`project-store.ts`) hands back the
 * same strings, which every engine short-circuits to a pointer compare. Content hashing
 * was priced at 24 ms per request for 700 files and rejected (`023 §3`).
 *
 * A store with no revision source therefore still *hits* — it re-reads the project and
 * pays a full compare per file, rather than missing. What it loses is the read it did
 * not have to do, not the cache.
 *
 * An entry's `.astro` output is bound to the compiler that produced it, so a cache
 * belongs to one host and must not be shared between two that compile differently.
 */

import type { ArtifactModuleKind } from "@pletivo/core/artifact";
import type { AstroStyles } from "./compile-project.ts";

/** One file's compile, everything the file set decides left out. */
export interface CompiledFile {
  /** The source this was built from, by identity — the whole freshness check. */
  source: string;
  /** Source interpretation; resolution is deliberately not cached with it. */
  kind?: ArtifactModuleKind;
  /**
   * The JavaScript `rewriteImports` runs over, after `import.meta.env` substitution.
   * `null` means "the source itself": substitution returns its argument unchanged when
   * the pattern does not fire, so a plain `.js` module costs a pointer rather than a
   * second copy of the file.
   */
  code: string | null;
  /**
   * Whether the substitution fired, and therefore whether the isolate's entry has to
   * install the global it rewrote to. Missed on a hit, every page reading
   * `import.meta.env` throws at frontmatter.
   */
  importMetaEnv: boolean;
  /**
   * Every specifier the file imports, read off the *pre-substitution* text. Kept rather
   * than re-derived from `code`, which is the post-substitution one.
   */
  specifiers: readonly string[];
  /**
   * Per raw specifier, the statically imported names. Resolution later assigns them to
   * `astro:env` aliases; caching only the final external would freeze artifact semantics.
   *
   * `null` when the file has no named imports.
   */
  envNames: ReadonlyMap<string, readonly string[]> | null;
  /** The `<style>` blocks a `.astro` file declares, with its scope hash. Feeds `pageCss`. */
  styles: AstroStyles | null;
}

export interface CompileCache {
  get(file: string): CompiledFile | undefined;
  set(file: string, entry: CompiledFile): void;
  /**
   * Forget one file.
   *
   * Unused, deliberately. The store is read-only and a Durable Object writes through
   * the workspace rather than through it, so an explicit invalidation path would be a
   * seam every writer has to remember to call — and a *missed* delete is a stale
   * bundle, which `source ===` can never produce. Here for a host that has a reason of
   * its own to drop an entry.
   */
  delete(file: string): void;
  /** What the held entries charge, by the measure `maxBytes` bounds. */
  readonly bytes: number;
}

export interface CompileCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
}

/**
 * 32 MiB, against a Worker's 128 MiB heap.
 *
 * The largest project measured carries 12.4 MB of compiled module source (`023 §1`), so
 * a fully warm cache of it charges roughly 25 MB — its sources plus that compiled code.
 * One whole project therefore fits, and anything larger evicts rather than dying.
 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** …and a count, so a project of thousands of tiny modules is bounded by number too. */
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

/** An insertion-ordered `Map` as an LRU: the front is the least recently used end. */
export function createCompileCache(options: CompileCacheOptions = {}): CompileCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const held = new Map<string, { entry: CompiledFile; charge: number }>();
  let bytes = 0;

  const drop = (file: string): void => {
    const found = held.get(file);
    if (found === undefined) return;
    held.delete(file);
    bytes -= found.charge;
  };

  return {
    get(file) {
      const found = held.get(file);
      if (found === undefined) return undefined;
      // Re-inserted, which moves it to the back: recency is the map's own order.
      held.delete(file);
      held.set(file, found);
      return found.entry;
    },

    set(file, entry) {
      drop(file);
      const charge = chargeOf(entry);
      // Refused rather than stored: one enormous vendored bundle must not flush the
      // whole cache and then evict itself.
      if (charge > maxBytes) return;
      held.set(file, { entry, charge });
      bytes += charge;
      while (bytes > maxBytes || held.size > maxEntries) {
        const oldest: IteratorResult<string> = held.keys().next();
        if (oldest.done === true) break;
        drop(oldest.value);
      }
    },

    delete: drop,

    get bytes() {
      return bytes;
    },
  };
}
