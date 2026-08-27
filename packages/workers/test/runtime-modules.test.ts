import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundleRuntimeModule } from "../scripts/build-runtime.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  ISOLATE_PROTOCOL_MODULE_NAME,
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

  test("hold the runtime, isolate protocol, and compiled JSX import", () => {
    expect(Object.keys(RUNTIME_MODULES)).toEqual([
      RUNTIME_MODULE_NAME,
      ISOLATE_PROTOCOL_MODULE_NAME,
      JSX_RUNTIME_MODULE_NAME,
    ]);
  });

  test("carry the source request parser as a stateless Loader module", () => {
    const source = GENERATED_MODULES[ISOLATE_PROTOCOL_MODULE_NAME];
    expect(source).toContain("function parseIsolateRequest");
    expect(source).toContain("ISOLATE_PROTOCOL_VERSION");
    expect(source.slice(source.lastIndexOf("export {"))).toContain("parseIsolateRequest");
    expect(source.slice(source.lastIndexOf("export {"))).toContain("ISOLATE_PROTOCOL_VERSION");
    expect(source).not.toMatch(/(?:node:|node\/fs|Bun\.)/);
  });

  test("rejects a Node built-in before it can enter the protocol bundle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pletivo-protocol-builtin-"));
    const entry = path.join(directory, "entry.ts");
    try {
      await writeFile(entry, 'import path from "node:path"; export default path.sep;\n');
      await expect(bundleRuntimeModule({ specifier: entry, target: "browser" })).resolves.toBeString();
      await expect(
        bundleRuntimeModule({ specifier: entry, target: "browser", forbidNodeBuiltins: true }),
      ).rejects.toThrow("Bundle failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    // because that config imports it from here too, and the runtime scope API the
    // generated entry module uses at the request boundary.
    for (const name of [
      "getCollection",
      "getEntry",
      "defineCollection",
      "glob",
      "reference",
      "render",
      "z",
      "initCollections",
      "createContentRuntime",
      "runWithContentRuntime",
    ]) {
      expect([name, exported.has(name)]).toEqual([name, true]);
    }
  });

  test("loads the generated content runtime and executes its Zod API", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pletivo-content-runtime-"));
    const moduleFile = path.join(directory, "pletivo-content.mjs");
    try {
      await writeFile(moduleFile, GENERATED_MODULES[CONTENT_MODULE_NAME]);
      const loaded: unknown = await import(pathToFileURL(moduleFile).href);
      if (typeof loaded !== "object" || loaded === null) {
        throw new Error("content runtime did not load as a module");
      }
      const z: unknown = Reflect.get(loaded, "z");
      if (typeof z !== "object" || z === null) {
        throw new Error("content runtime did not export z");
      }
      const stringFactory: unknown = Reflect.get(z, "string");
      const objectFactory: unknown = Reflect.get(z, "object");
      if (typeof stringFactory !== "function" || typeof objectFactory !== "function") {
        throw new Error("content runtime exported an incomplete Zod API");
      }
      const titleSchema: unknown = Reflect.apply(stringFactory, z, []);
      const schema: unknown = Reflect.apply(objectFactory, z, [{ title: titleSchema }]);
      if (typeof schema !== "object" || schema === null) {
        throw new Error("z.object did not return a schema");
      }
      const parse: unknown = Reflect.get(schema, "parse");
      if (typeof parse !== "function") throw new Error("Zod schema did not expose parse");
      expect(Reflect.apply(parse, schema, [{ title: "ok" }])).toEqual({ title: "ok" });
    } finally {
      await rm(directory, { recursive: true, force: true });
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
    expect(GENERATED_MODULES[CONTENT_MODULE_NAME]).toContain('from "node:async_hooks"');
  });

  test("carry no TypeScript into the bundle", () => {
    expect(RUNTIME_MODULES[RUNTIME_MODULE_NAME]).not.toContain("interface ");
  });
});
