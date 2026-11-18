import { BoundedLru } from "./bounded-lru.ts";
import type { RenderedAsset } from "./render.ts";

export interface GeneratedAssetCacheOptions {
  maxEntries: number;
  maxBytes: number;
}

/**
 * Bounded per-asset LRU for browser follow-up requests. Batches are inserted one entry
 * at a time and every insertion restores both bounds before returning.
 */
export class GeneratedAssetCache {
  readonly #entries: BoundedLru<RenderedAsset>;

  constructor(options: GeneratedAssetCacheOptions) {
    assertBudget("maxEntries", options.maxEntries, true);
    assertBudget("maxBytes", options.maxBytes, false);
    this.#entries = new BoundedLru(options);
  }

  get(path: string): RenderedAsset | undefined {
    return this.#entries.get(path);
  }

  /** Inserts a batch and returns every asset absent after the complete batch. */
  putAll(assets: Iterable<RenderedAsset>): RenderedAsset[] {
    const batch: RenderedAsset[] = [];
    for (const asset of assets) {
      batch.push(asset);
      const bytes = typeof asset.body === "string" ? new TextEncoder().encode(asset.body).byteLength : asset.body.byteLength;
      this.#entries.set(asset.path, asset, bytes);
    }
    return batch.filter((asset) => this.#entries.peek(asset.path) !== asset);
  }
}

function assertBudget(name: string, value: number, integer: boolean): void {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`[pletivo-workers] ${name} must be a non-negative finite ${integer ? "integer" : "number"}`);
  }
}
