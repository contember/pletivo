import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import type { HookIdFilter } from "../../packages/core/src/astro-host/types";
import { __resetForTests, addVitePlugins, resolveViteId, tryLoadViteId } from "../../packages/pletivo/src/astro-host/vite-plugins";

afterEach(() => {
  __resetForTests();
});

/** A plugin whose object-form hooks answer every id they are called with, and record it. */
function objectHookPlugin(filter: HookIdFilter | undefined): { resolved: string[]; loaded: string[] } {
  const calls: { resolved: string[]; loaded: string[] } = { resolved: [], loaded: [] };
  addVitePlugins([
    {
      name: "test:object-hooks",
      resolveId: {
        filter: filter === undefined ? undefined : { id: filter },
        handler(id: string) {
          calls.resolved.push(id);
          return `\0resolved:${id}`;
        },
      },
      load: {
        filter: filter === undefined ? undefined : { id: filter },
        handler(id: string) {
          calls.loaded.push(id);
          return { code: `export default ${JSON.stringify(id)};` };
        },
      },
    },
  ]);
  return calls;
}

describe("Vite plugin hooks in object form", () => {
  test("run their handler, as Vite does", async () => {
    const calls = objectHookPlugin(undefined);
    expect(await resolveViteId("/@react-refresh")).toBe("\0resolved:/@react-refresh");
    const { loaded, errors } = await tryLoadViteId("/@react-refresh");
    expect(errors).toEqual([]);
    expect(loaded?.code).toBe('export default "/@react-refresh";');
    expect(calls).toEqual({ resolved: ["/@react-refresh"], loaded: ["/@react-refresh"] });
  });

  test("skip an id their RegExp filter does not match, and leave it to the next plugin", async () => {
    const calls = objectHookPlugin(/^\/@react-refresh$/);
    addVitePlugins([{ name: "test:next", resolveId: (id: string) => `\0next:${id}`, load: (id: string) => `export default ${JSON.stringify(id)};` }]);
    expect(await resolveViteId("/@react-refresh")).toBe("\0resolved:/@react-refresh");
    expect(await resolveViteId("virtual:other")).toBe("\0next:virtual:other");
    expect((await tryLoadViteId("virtual:other")).loaded?.code).toBe('export default "virtual:other";');
    expect(calls).toEqual({ resolved: ["/@react-refresh"], loaded: [] });
  });

  test("apply include and exclude, with globs relative to the working directory unless they start with **", async () => {
    const calls = objectHookPlugin({ include: ["**/*.vue", "src/**/*.svelte"], exclude: /skip/ });
    const inSrc = path.join(process.cwd(), "src/A.svelte");
    expect(await resolveViteId("/x/Counter.vue")).toBe("\0resolved:/x/Counter.vue");
    expect(await resolveViteId(inSrc)).toBe(`\0resolved:${inSrc}`);
    expect(await resolveViteId("/elsewhere/src/A.svelte")).toBeNull();
    expect(await resolveViteId("/x/skip.vue")).toBeNull();
    expect(await resolveViteId("/x/Counter.ts")).toBeNull();
    expect(calls.resolved).toEqual(["/x/Counter.vue", inSrc]);
  });

  test("an empty include list matches every id an exclude lets through", async () => {
    const calls = objectHookPlugin({ include: [], exclude: ["**/node_modules/**"] });
    expect(await resolveViteId("virtual:a")).toBe("\0resolved:virtual:a");
    expect(await resolveViteId("/p/node_modules/x/index.js")).toBeNull();
    expect(calls.resolved).toEqual(["virtual:a"]);
  });
});
