/**
 * Last-good HTML per route, for `dev.stale`.
 *
 * When a render throws and stale mode is on, the previous successful HTML for that path is
 * served instead of an error — so a typo in one component does not blank the page somebody
 * is looking at.
 *
 * Two properties the store owns, rather than its caller:
 *
 *  - **It only remembers when someone will read it.** The write and the read used to sit
 *    behind different conditions: every successful render was stored, but only `dev.stale`
 *    ever looked. A project without stale mode kept the full HTML of every path it had ever
 *    served and never used a byte of it. Making `enabled` a property of the store means the
 *    two cannot drift apart again.
 *  - **It is bounded.** Pages on a content site run to hundreds of KB — 423 KB average on the
 *    site this was measured against — so an unbounded map turns a crawl into a second copy of
 *    the site held in memory. Oldest write goes first once the budget is exceeded, which suits
 *    the purpose: the page being edited right now is the one worth keeping.
 */

/**
 * Budget in characters, not bytes: JSC stores a string as latin1 or UTF-16, so the real cost
 * is one to two bytes each. It is a bound, not an accounting — the point is that it stops
 * growing.
 */
const DEFAULT_BUDGET_CHARS = 16 * 1024 * 1024;

export interface SnapshotStore {
  /** Record the HTML last served for `pathname`. No-op when the store is disabled. */
  remember(pathname: string, html: string): void;
  /** Last-good HTML for `pathname`, if it is still held. */
  get(pathname: string): string | undefined;
  /** Entries currently held. */
  readonly size: number;
  /** Characters currently held. */
  readonly chars: number;
}

export interface SnapshotStoreOptions {
  /** Whether anything is stored at all — true only when `dev.stale` will read it back. */
  enabled: boolean;
  /** Characters to keep before evicting the oldest write. */
  budgetChars?: number;
}

export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStore {
  const budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  // Insertion order is the eviction order, and re-writing a path re-inserts it, so a path
  // that keeps being served keeps its place.
  const entries = new Map<string, string>();
  let chars = 0;

  return {
    remember(pathname, html) {
      if (!options.enabled) return;
      const previous = entries.get(pathname);
      if (previous !== undefined) {
        chars -= previous.length;
        entries.delete(pathname);
      }
      entries.set(pathname, html);
      chars += html.length;
      for (const key of entries.keys()) {
        if (chars <= budget) break;
        chars -= entries.get(key)!.length;
        entries.delete(key);
      }
    },
    get(pathname) {
      return entries.get(pathname);
    },
    get size() {
      return entries.size;
    },
    get chars() {
      return chars;
    },
  };
}
