/**
 * Where generated assets (`?url` imports) outlive the render that produced them. A page
 * links to them by content-hashed URL, and the browser's follow-up GET may reach a host
 * that has evicted them, restarted, or never rendered the page. The host writes them
 * here before it returns the HTML, and reads them here on a cache miss.
 *
 * A `url()` target of a page's inlined CSS is not stored, only recorded: its URL, and the
 * project path and md5 it names. The host serves the bytes from the project.
 */

import type { CssAssetLink, CssAssetRecord } from "./css-assets.ts";
import type { RenderedAsset } from "./render.ts";

/** A durable store keyed by the URL path the HTML spells, e.g. R2 or Durable Object SQLite. */
export interface GeneratedAssetStore {
  /** The asset served at `path`, or `null` when none was ever stored there. */
  get(path: string): Promise<RenderedAsset | null>;
  /** Store every asset; resolves once all are durable. A path's content never changes. */
  put(assets: readonly RenderedAsset[]): Promise<void>;
  /** The record for the CSS asset URL `url`, or `null` when none was ever put. */
  getCssAsset(url: string): Promise<CssAssetRecord | null>;
  /**
   * Record each link under its `url`; resolves once all are durable. Every record of one
   * URL names the same bytes, so a later one may replace an earlier one.
   */
  putCssAssets(links: readonly CssAssetLink[]): Promise<void>;
}

/** `GeneratedAssetStore` in memory: for tests, and for a host that only needs the contract. */
export class MemoryGeneratedAssetStore implements GeneratedAssetStore {
  readonly #assets = new Map<string, RenderedAsset>();
  readonly #cssAssets = new Map<string, CssAssetRecord>();

  get size(): number {
    return this.#assets.size;
  }

  /** How many CSS asset records are held. */
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

  getCssAsset(url: string): Promise<CssAssetRecord | null> {
    const record = this.#cssAssets.get(url);
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  putCssAssets(links: readonly CssAssetLink[]): Promise<void> {
    for (const link of links) this.#cssAssets.set(link.url, { path: link.path, md5: link.md5 });
    return Promise.resolve();
  }
}
