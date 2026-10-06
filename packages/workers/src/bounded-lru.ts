/**
 * An insertion-ordered `Map` as an LRU bounded by entry count and a byte budget.
 * The front is the least recently used end.
 */
export class BoundedLru<V> {
  readonly #entries = new Map<string, { value: V; bytes: number }>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(bounds: { maxEntries: number; maxBytes: number }) {
    this.#maxEntries = bounds.maxEntries;
    this.#maxBytes = bounds.maxBytes;
  }

  get(key: string): V | undefined {
    const found = this.#entries.get(key);
    if (found === undefined) return undefined;
    // Re-insert to move it to the most recently used end.
    this.#entries.delete(key);
    this.#entries.set(key, found);
    return found.value;
  }

  /** `get` without making the entry the most recently used. */
  peek(key: string): V | undefined {
    return this.#entries.get(key)?.value;
  }

  /**
   * Replace whatever `key` held. A value that alone exceeds a bound is not retained:
   * it would flush the whole cache and then evict itself.
   */
  set(key: string, value: V, bytes: number): void {
    this.#delete(key);
    if (this.#maxEntries === 0 || bytes > this.#maxBytes) return;
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.#maxBytes || this.#entries.size > this.#maxEntries) {
      const oldest: IteratorResult<string> = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#delete(oldest.value);
    }
  }

  #delete(key: string): void {
    const found = this.#entries.get(key);
    if (found === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= found.bytes;
  }
}
