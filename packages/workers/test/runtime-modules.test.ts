import { describe, expect, test } from "bun:test";
import { generateRuntimeModules } from "../scripts/build-runtime.ts";
import { RUNTIME_MODULES, RUNTIME_MODULE_NAME } from "../src/generated/runtime-modules.ts";

/**
 * `src/generated/runtime-modules.ts` is @pletivo/runtime, transpiled. The Worker
 * Loader takes JavaScript and workerd has no `eval`, so the TS→JS step has to
 * happen here rather than at request time — which means the committed copy can go
 * stale behind a change to the runtime. Re-derive it and say so when it has.
 */
describe("generated runtime modules", () => {
  test("match the current @pletivo/runtime source", async () => {
    const generated = await generateRuntimeModules();
    const committed = await Bun.file(
      new URL("../src/generated/runtime-modules.ts", import.meta.url),
    ).text();
    expect(committed).toBe(generated);
  });

  test("hold the module compiled .astro output imports", () => {
    expect(Object.keys(RUNTIME_MODULES)).toEqual([RUNTIME_MODULE_NAME]);
  });

  test("export what the generated entry module calls", () => {
    const source = RUNTIME_MODULES[RUNTIME_MODULE_NAME];
    expect(source).toContain("renderAstroPage");
    expect(source).toContain("runWithRenderTracking");
  });

  test("keep node:async_hooks external, since workerd provides it", () => {
    // Bundled as `browser` it would be stubbed to `{}`, and the render-tracking
    // store would silently stop tracking.
    expect(RUNTIME_MODULES[RUNTIME_MODULE_NAME]).toContain('from "node:async_hooks"');
  });

  test("carry no TypeScript into the bundle", () => {
    expect(RUNTIME_MODULES[RUNTIME_MODULE_NAME]).not.toContain("interface ");
  });
});
