/**
 * Where generated assets (`?url` imports) outlive the render that produced them. A page
 * links to them by content-hashed URL, and the browser's follow-up GET may reach a host
 * that has evicted them, restarted, or never rendered the page. The host writes them
 * here before it returns the HTML, and reads them here on a cache miss.
 */

import type { RenderedAsset } from "./render.ts";

/** A durable store keyed by the URL path the HTML spells, e.g. R2 or Durable Object SQLite. */
export interface GeneratedAssetStore {
  /** The asset served at `path`, or `null` when none was ever stored there. */
  get(path: string): Promise<RenderedAsset | null>;
  /** Store every asset; resolves once all are durable. A path's content never changes. */
  put(assets: readonly RenderedAsset[]): Promise<void>;
}

/** `GeneratedAssetStore` in memory: for tests, and for a host that only needs the contract. */
export class MemoryGeneratedAssetStore implements GeneratedAssetStore {
  readonly #assets = new Map<string, RenderedAsset>();

  get size(): number {
    return this.#assets.size;
  }

  get(path: string): Promise<RenderedAsset | null> {
    return Promise.resolve(this.#assets.get(path) ?? null);
  }

  put(assets: readonly RenderedAsset[]): Promise<void> {
    for (const asset of assets) this.#assets.set(asset.path, { ...asset });
    return Promise.resolve();
  }
}
