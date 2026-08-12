/**
 * Lightweight build profiler, gated on `PLETIVO_PROFILE=1`.
 *
 * Two shapes:
 *   - `phase(name, t0)` — one-shot timing of a top-level build phase.
 *   - `timeSync` / `timeAsync` — accumulate wall time under a named
 *     bucket across many calls (e.g. a per-page step that runs 1000×
 *     inside a `Promise.all`), then `flushProfile()` prints the totals
 *     sorted by cost. Per-call logging would be noise at that scale;
 *     the aggregate is what pinpoints an O(pages × assets) hot spot.
 *
 * All output goes to stderr so it never pollutes piped build output.
 */

export const profileEnabled = process.env.PLETIVO_PROFILE === "1";

const buckets = new Map<string, { total: number; count: number }>();

/** One-shot: log the elapsed time since `t0` for a named phase. */
export function phase(name: string, t0: number): void {
  if (!profileEnabled) return;
  console.error(`[PROFILE] ${name}: ${(performance.now() - t0).toFixed(0)}ms`);
}

function accum(name: string, ms: number): void {
  const b = buckets.get(name);
  if (b) {
    b.total += ms;
    b.count += 1;
  } else {
    buckets.set(name, { total: ms, count: 1 });
  }
}

/** Time a synchronous section and accumulate it under `name`. */
export function timeSync<T>(name: string, fn: () => T): T {
  if (!profileEnabled) return fn();
  const t = performance.now();
  try {
    return fn();
  } finally {
    accum(name, performance.now() - t);
  }
}

/** Time an async section and accumulate it under `name`. */
export async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!profileEnabled) return fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    accum(name, performance.now() - t);
  }
}

/**
 * Print the accumulated buckets under a header, sorted most-expensive
 * first, then reset them. Totals are summed across all calls, so under
 * concurrency they can exceed the phase's wall-clock — the ranking and
 * per-call averages are what matter for attribution.
 */
export function flushProfile(label: string): void {
  if (!profileEnabled || buckets.size === 0) return;
  console.error(`[PROFILE] ${label} breakdown (summed across calls):`);
  const rows = [...buckets.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [name, { total, count }] of rows) {
    console.error(
      `  ${name}: ${total.toFixed(0)}ms / ${count} calls (${(total / count).toFixed(2)}ms avg)`,
    );
  }
  buckets.clear();
}
