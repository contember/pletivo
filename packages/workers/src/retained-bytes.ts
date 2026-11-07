/**
 * Roughly what a value holds, in bytes, for a cache's budget: each distinct object once (a
 * YAML alias shares one, a merge key copies it), strings as UTF-16, cycles followed once.
 * Overestimates rather than under. Stops counting once past `limit`, so the walk of a value
 * too large to keep costs no more than the limit.
 */
export function retainedBytes(value: unknown, limit: number): number {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length > 0 && bytes <= limit) {
    const next = pending.pop();
    if (typeof next === "string") {
      bytes += 16 + next.length * 2;
      continue;
    }
    if (typeof next !== "object" || next === null || seen.has(next)) {
      bytes += 8;
      continue;
    }
    seen.add(next);
    if (ArrayBuffer.isView(next)) {
      bytes += 32 + next.byteLength;
      continue;
    }
    bytes += 32;
    for (const key in next) {
      if (!Object.hasOwn(next, key)) continue;
      bytes += 16 + key.length * 2;
      if (bytes > limit) return bytes;
      pending.push(Reflect.get(next, key));
    }
  }
  return bytes;
}
