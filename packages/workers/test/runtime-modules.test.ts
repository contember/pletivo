import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  JSX_RUNTIME_MODULE_NAME,
  RUNTIME_MODULES,
  RUNTIME_MODULE_NAME,
} from "../src/generated/runtime-modules.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Re-derive the generated file, in a subprocess.
 *
 * Not in-process: `Bun.build` under `bun test` resolves bare specifiers from the test
 * runner's view of the tree, and the content bundle's markdown pipeline reaches
 * `packages/core/node_modules`, which that view does not include. Run as a script it
 * resolves normally — and from the repo root, which the embedded module comments are
 * relative to.
 */
async function regenerate(): Promise<string> {
  const child = Bun.spawn(
    ["bun", path.join(import.meta.dir, "../scripts/build-runtime.ts"), "--stdout"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`build-runtime.ts failed:\n${stderr}`);
  return stdout;
}

/**
 * `src/generated/runtime-modules.ts` is @pletivo/runtime, transpiled. The Worker
 * Loader takes JavaScript and workerd has no `eval`, so the TS→JS step has to
 * happen here rather than at request time — which means the committed copy can go
 * stale behind a change to the runtime. Re-derive it and say so when it has.
 */
describe("generated runtime modules", () => {
  test("match the current @pletivo/runtime source", async () => {
    const generated = await regenerate();
    const committed = await Bun.file(
      new URL("../src/generated/runtime-modules.ts", import.meta.url),
    ).text();
    expect(committed).toBe(generated);
  }, 60_000);

  test("hold the modules compiled .astro and compiled JSX import", () => {
    expect(Object.keys(RUNTIME_MODULES)).toEqual([RUNTIME_MODULE_NAME, JSX_RUNTIME_MODULE_NAME]);
  });

  test("keep the content runtime out of every bundle that does not ask for it", () => {
    // It is an order of magnitude larger than the runtime — Zod plus the whole
    // unified/remark pipeline — so `compileProject` adds it only for a project that
    // imports the content API.
    expect(RUNTIME_MODULES[CONTENT_MODULE_NAME]).toBeUndefined();
    expect(GENERATED_MODULES[CONTENT_MODULE_NAME].length).toBeGreaterThan(
      GENERATED_MODULES[RUNTIME_MODULE_NAME].length,
    );
  });

  test("give the content runtime the exports a page and a config module import", () => {
    const source = GENERATED_MODULES[CONTENT_MODULE_NAME];
    const clause = source.slice(source.lastIndexOf("export {"));
    const exported = new Set(
      clause.matchAll(/(?:^|\s)(?:\w+ as )?(\w+)[,\n}]/g).map((match) => match[1]),
    );
    // The query API a page uses, the definition API a `content.config.*` uses, `z`
    // because that config imports it from here too, and the two the generated entry
    // module wires the host up with.
    for (const name of [
      "getCollection",
      "getEntry",
      "defineCollection",
      "glob",
      "reference",
      "render",
      "z",
      "initCollections",
      "setContentHost",
    ]) {
      expect([name, exported.has(name)]).toEqual([name, true]);
    }
  });

  test("export what the generated entry module calls", () => {
    const source = RUNTIME_MODULES[RUNTIME_MODULE_NAME];
    expect(source).toContain("renderAstroPage");
    expect(source).toContain("runWithRenderTracking");
    expect(source).toContain("isAstroComponent");
    expect(source).toContain("redirectPageHtml");
  });

  test("carry paginate, which only runs where the page module runs", () => {
    // `getStaticPaths({ paginate })` is called inside the isolate, because the props
    // it returns hold functions and cannot cross back out.
    const source = RUNTIME_MODULES[RUNTIME_MODULE_NAME];
    expect(source).toContain("createPaginate");
    expect(source).toContain('but the route has no "[page]" or "[...page]" parameter.');
  });

  test("pull no host module in behind paginate", () => {
    // @pletivo/core/paginate imports nothing but types. If that ever changes, the
    // router (node:path) would ride along into a bundle that has no filesystem.
    expect(RUNTIME_MODULES[RUNTIME_MODULE_NAME]).not.toContain("node:path");
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
