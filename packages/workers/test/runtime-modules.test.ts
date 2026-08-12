import { describe, expect, test } from "bun:test";
import { generateRuntimeModules } from "../scripts/build-runtime.ts";
import {
  JSX_RUNTIME_MODULE_NAME,
  RUNTIME_MODULES,
  RUNTIME_MODULE_NAME,
} from "../src/generated/runtime-modules.ts";

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

  test("hold the modules compiled .astro and compiled JSX import", () => {
    expect(Object.keys(RUNTIME_MODULES)).toEqual([RUNTIME_MODULE_NAME, JSX_RUNTIME_MODULE_NAME]);
  });

  test("export what the generated entry module calls", () => {
    const source = RUNTIME_MODULES[RUNTIME_MODULE_NAME];
    expect(source).toContain("renderAstroPage");
    expect(source).toContain("runWithRenderTracking");
    expect(source).toContain("isAstroComponent");
    expect(source).toContain("redirectPageHtml");
  });

  test("give the isolate one render-tracking store, not one per half", () => {
    // Two bundles would mean two AsyncLocalStorage instances, and a .tsx page's
    // <style> blocks would be pushed into a store the host never reads.
    const source = RUNTIME_MODULES[RUNTIME_MODULE_NAME];
    expect(source.match(/new AsyncLocalStorage/g)).toHaveLength(1);
  });

  test("rename the JSX Fragment rather than shipping a second copy of the runtime", () => {
    // Both halves export `Fragment` and they are different functions: the Astro
    // shim's honours `set:html`, the JSX one renders children.
    const shim = RUNTIME_MODULES[JSX_RUNTIME_MODULE_NAME];
    expect(shim).toBe(
      'export { jsx, jsxs, jsxDEV, jsxFragment as Fragment } from "./pletivo-runtime.js";\n',
    );
    expect(RUNTIME_MODULES[RUNTIME_MODULE_NAME]).toContain("jsxFragment");
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
