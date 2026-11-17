import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { bundlePageScripts } from "../../packages/pletivo/src/astro-host/page-scripts";
import { __resetForTests, addVitePlugins } from "../../packages/pletivo/src/astro-host/vite-plugins";

/** Has `page-script-lib` installed, and sits under this repo's tsconfig, which maps `preact/hooks`. */
const projectRoot = path.join(import.meta.dir, "../fixture-astro-page-scripts");

beforeAll(() => {
  // Bun < 1.4.2: `bun test <dir>` caches this directory's listing with an exhausted fd, and the
  // first Bun.build re-lists through it, finds no node_modules here, and fails to resolve.
  Bun.resolveSync("page-script-lib", projectRoot);
});

afterEach(() => {
  __resetForTests();
});

function virtualModule(id: string, code: string): void {
  addVitePlugins([
    {
      name: `test:${id}`,
      resolveId: (source: string) => (source === id ? `\0${id}` : undefined),
      load: (resolved: string) => (resolved === `\0${id}` ? code : undefined),
    },
  ]);
}

describe("bundlePageScripts", () => {
  test("no scripts, no module", async () => {
    expect(await bundlePageScripts([], projectRoot)).toBeNull();
  });

  test("a missing package fails with the resolver's message", async () => {
    await expect(bundlePageScripts(['import "missing-page-script-pkg";'], projectRoot))
      .rejects.toThrow(/missing-page-script-pkg/);
  });

  test("a stylesheet import fails: an inline module cannot load it", async () => {
    const css = path.join(import.meta.dir, "../fixture-astro-hoisted-imports/vendor/hoisted-entry.css");
    await expect(bundlePageScripts([`import ${JSON.stringify(css)};`], projectRoot))
      .rejects.toThrow(/must bundle to one JavaScript module/);
  });

  test("an unresolvable virtual module is refused by name", async () => {
    await expect(bundlePageScripts(['import "virtual:nobody-serves-this";'], projectRoot))
      .rejects.toThrow(/virtual:nobody-serves-this/);
  });

  test("a plugin load() error is the reported cause", async () => {
    addVitePlugins([
      {
        name: "test:exploding",
        resolveId: (source: string) => (source === "virtual:test/explodes" ? "\0virtual:test/explodes" : undefined),
        load: () => {
          throw new Error("load exploded");
        },
      },
    ]);
    await expect(bundlePageScripts(['import "virtual:test/explodes";'], projectRoot))
      .rejects.toThrow(/test:exploding\.load failed for \0virtual:test\/explodes: load exploded/);
  });

  test("escapes </script so the inline tag holds", async () => {
    const code = await bundlePageScripts(['document.title = "a</script><SCRIPT>b</Script>";'], projectRoot);
    expect(code).not.toMatch(/<\/script/i);
    expect(code).toContain("a<\\/script><SCRIPT>b<\\/Script>");
  });

  test("refuses <!-- with <script, which an inline tag cannot hold", async () => {
    await expect(bundlePageScripts(['document.title = "<!--" + "<script>";'], projectRoot))
      .rejects.toThrow(/<!--/);
  });

  test("a virtual module's package import resolves from the project", async () => {
    virtualModule("virtual:test/uses-package", 'import { mark } from "page-script-lib";\nexport const run = () => mark("v");');
    const code = await bundlePageScripts(['import { run } from "virtual:test/uses-package";\nrun();'], projectRoot);
    expect(code).toContain("page-script-lib-marker");
  });

  test("a virtual module's root-relative id names a project file", async () => {
    virtualModule("virtual:test/root-relative", 'import entry from "/src/scripts/root-entry.js";\nentry();');
    const code = await bundlePageScripts(['import "virtual:test/root-relative";'], projectRoot);
    expect(code).toContain("root-relative-marker");
  });

  test("preact comes from its package, not the SSR stub tsconfig maps it to", async () => {
    const code = await bundlePageScripts(['import { useState } from "preact/hooks";\nwindow.x = useState;'], projectRoot);
    // `__H` is preact's hook state; the stub (packages/runtime/src/hooks.ts) has none.
    expect(code).toContain("__H");
  });
});
