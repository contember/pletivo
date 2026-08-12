/**
 * Adapter registry. Add a runtime here and the whole corpus runs against it
 * with `CONFORMANCE_ADAPTER=<name> bun test tests/conformance` — compared
 * against the same committed snapshots, since a snapshot describes what pletivo
 * renders, not how.
 */
import type { ConformanceAdapter } from "../adapter";
import { bunBuildAdapter } from "./bun-build";

export const adapters: Record<string, ConformanceAdapter> = {
  [bunBuildAdapter.name]: bunBuildAdapter,
};

export const DEFAULT_ADAPTER = bunBuildAdapter.name;

export function resolveAdapter(name = process.env.CONFORMANCE_ADAPTER ?? DEFAULT_ADAPTER): ConformanceAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`unknown conformance adapter "${name}" (have: ${Object.keys(adapters).join(", ")})`);
  }
  return adapter;
}
