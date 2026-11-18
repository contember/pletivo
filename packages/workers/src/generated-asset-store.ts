/**
 * Where generated assets (`?url` imports) outlive the render that produced them. A page
 * links to them by content-hashed URL, and the browser's follow-up GET may reach a host
 * that has evicted them, restarted, or never rendered the page. The host writes them
 * here before it returns the HTML, and reads them here on a cache miss.
 *
 * A `url()` target of a page's inlined CSS is not stored, only recorded: its URL, and the
 * project paths and md5 it names. The host serves the bytes from the project. A store
 * holds one project's records: a path means a file of that project.
 */

import { withCssAssetTarget, type CssAssetLink, type CssAssetTarget } from "./css-assets.ts";
import type { RenderedAsset } from "./render.ts";

/** A durable store keyed by the URL path the HTML spells, e.g. R2 or Durable Object SQLite. */
export interface GeneratedAssetStore {
  /** The asset served at `path`, or `null` when none was ever stored there. */
  get(path: string): Promise<RenderedAsset | null>;
  /** Store every asset; resolves once all are durable. A path's content never changes. */
  put(assets: readonly RenderedAsset[]): Promise<void>;
  /** The targets recorded under the CSS asset URL `url`, oldest first; empty when none. */
  getCssAsset(url: string): Promise<readonly CssAssetTarget[]>;
  /**
   * Add each link's path and md5 to the targets of its `url`, as `withCssAssetTarget`
   * does: an entry for the same path is replaced, and past `MAX_CSS_ASSET_TARGETS` the
   * oldest goes. Resolves once all are durable.
   */
  putCssAssets(links: readonly CssAssetLink[]): Promise<void>;
}

/** `GeneratedAssetStore` in memory: for tests, and for a host that only needs the contract. */
export class MemoryGeneratedAssetStore implements GeneratedAssetStore {
  readonly #assets = new Map<string, RenderedAsset>();
  readonly #cssAssets = new Map<string, CssAssetTarget[]>();

  get size(): number {
    return this.#assets.size;
  }

  /** How many CSS asset URLs have targets recorded. */
  get cssAssetCount(): number {
    return this.#cssAssets.size;
  }

  get(path: string): Promise<RenderedAsset | null> {
    return Promise.resolve(this.#assets.get(path) ?? null);
  }

  put(assets: readonly RenderedAsset[]): Promise<void> {
    for (const asset of assets) this.#assets.set(asset.path, { ...asset });
    return Promise.resolve();
  }

  getCssAsset(url: string): Promise<readonly CssAssetTarget[]> {
    return Promise.resolve((this.#cssAssets.get(url) ?? []).map((target) => ({ ...target })));
  }

  putCssAssets(links: readonly CssAssetLink[]): Promise<void> {
    for (const link of links) {
      this.#cssAssets.set(link.url, withCssAssetTarget(this.#cssAssets.get(link.url) ?? [], link));
    }
    return Promise.resolve();
  }
}
