/**
 * Server-side hooks — noops that return initial values.
 * On the client, these are replaced by the reactive client runtime via Bun plugin.
 */

export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const value = typeof initial === "function" ? (initial as () => T)() : initial;
  return [value, () => {}];
}
