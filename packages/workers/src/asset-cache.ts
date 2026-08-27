/** A generated file whose content contributes to the cache byte budget. */
export interface CacheableGeneratedAsset {
  path: string;
  body: string | Uint8Array;
}

export interface GeneratedAssetCacheOptions {
  maxEntries: number;
  maxBytes: number;
}

interface CachedAsset<T> {
  value: T;
  bytes: number;
}

/**
 * Bounded per-asset LRU for browser follow-up requests.
 *
 * `put` always returns its input, so a caller can serve an oversized generated asset
 * once. Such an asset is not retained. Batches are inserted one entry at a time and
 * every insertion restores both bounds before returning.
 */
export class GeneratedAssetCache<T extends CacheableGeneratedAsset> {
  readonly #entries = new Map<string, CachedAsset<T>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: GeneratedAssetCacheOptions) {
    assertBudget("maxEntries", options.maxEntries, true);
    assertBudget("maxBytes", options.maxBytes, false);
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
  }

  get count(): number {
    return this.#entries.size;
  }

  get byteSize(): number {
    return this.#bytes;
  }

  /** Oldest to newest, useful for observability and deterministic tests. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  get(path: string): T | undefined {
    const cached = this.#entries.get(path);
    if (!cached) return undefined;
    this.#entries.delete(path);
    this.#entries.set(path, cached);
    return cached.value;
  }

  put(asset: T): T {
    this.#retain(asset);
    return asset;
  }

  /** Inserts a batch and returns every value absent after the complete batch. */
  putAll(assets: Iterable<T>): T[] {
    const batch: T[] = [];
    for (const asset of assets) {
      batch.push(asset);
      this.#retain(asset);
    }
    return batch.filter((asset) => this.#entries.get(asset.path)?.value !== asset);
  }

  #retain(asset: T): void {
    const bytes = bodySize(asset.body);
    this.#delete(asset.path);
    if (
      this.#maxEntries === 0 ||
      bytes > this.#maxBytes
    ) {
      return;
    }

    while (
      this.#entries.size >= this.#maxEntries ||
      this.#bytes + bytes > this.#maxBytes
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }

    this.#entries.set(asset.path, { value: asset, bytes });
    this.#bytes += bytes;
  }

  #delete(path: string): void {
    const previous = this.#entries.get(path);
    if (!previous) return;
    this.#entries.delete(path);
    this.#bytes -= previous.bytes;
  }
}

function bodySize(body: string | Uint8Array): number {
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

function assertBudget(name: string, value: number, integer: boolean): void {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`[pletivo-workers] ${name} must be a non-negative finite ${integer ? "integer" : "number"}`);
  }
}
