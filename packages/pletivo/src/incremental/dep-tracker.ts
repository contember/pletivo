import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Runtime file-read capture. Static ESM deps live in `import-graph.ts`
 * (built by parsing source via Bun.Transpiler.scanImports) — this
 * module only handles the second layer: data reads that happen during
 * a render and aren't visible to the static walker (markdown content
 * collections, image probes, etc.).
 *
 * `runWithRuntimeDepCapture` scopes the capture via AsyncLocalStorage
 * so concurrent renders stay isolated. Centralized call sites
 * (`getCollection`, `probeAndRegisterImage`, …) invoke
 * `recordRuntimeDep(absPath)` unconditionally — outside a capture
 * scope it's a no-op, so dev mode and tooling paths pay no cost.
 *
 * Known limitation: only the wrapped APIs feed this tracker. A user
 * component that calls `Bun.file()` / `fs.readFile()` / `import()`
 * directly on a data file (e.g. `await Bun.file("data/foo.json").text()`)
 * will NOT be tracked, and edits to that file won't invalidate the
 * page. There is no general-purpose way to intercept arbitrary FS
 * reads without monkey-patching globals, so the user must either
 *   1. read the data through a tracked API (e.g. wrap it in a content
 *      collection's `loader`, which is captured),
 *   2. import it via ESM `import` (covered by the static graph), or
 *   3. accept the staleness and run a full build — plain `pletivo build`
 *      (incremental is opt-in) or `--clean` — when the external data
 *      changes.
 */

let projectRoot: string | null = null;

const runtimeDepStorage = new AsyncLocalStorage<Set<string>>();

export function configureDepTracker(rootDir: string): void {
  projectRoot = rootDir;
}

export async function runWithRuntimeDepCapture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; runtimeDeps: Set<string> }> {
  const runtimeDeps = new Set<string>();
  const value = await runtimeDepStorage.run(runtimeDeps, fn);
  return { value, runtimeDeps };
}

export function recordRuntimeDep(filePath: string): void {
  if (!filePath) return;
  if (!path.isAbsolute(filePath)) return;
  if (filePath.includes("/node_modules/")) return;
  if (projectRoot && !filePath.startsWith(projectRoot)) return;
  const store = runtimeDepStorage.getStore();
  if (store) store.add(filePath);
}
