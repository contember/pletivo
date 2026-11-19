import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { createProjectHost } from "../src/project-host.ts";
import { detectProjectFeatures } from "../src/project-features.ts";
import { createMapProjectStore } from "../src/project-store.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

const compiler = createAstroCompiler(await astroWasmModule());

describe("detectProjectFeatures", () => {
  test("names the files that use each unsupported feature", async () => {
    const files = new Map([
      ["src/pages/index.astro", `---\nimport Counter from "../components/Counter.tsx";\n---\n<Counter client:load />\n`],
      ["src/pages/docs.mdx", "# Docs\n"],
      ["src/content/blog/post.mdx", "# Post\n"],
      ["src/pages/rss.xml.ts", "export function GET() { return new Response(''); }\n"],
      ["src/pages/live.astro", "---\nexport const prerender = false;\n---\n<p>live</p>\n"],
      ["src/components/Counter.tsx", "export default function Counter() { return <button />; }\n"],
    ]);
    expect(await detectProjectFeatures(files, { compiler })).toEqual({
      mdx: ["src/content/blog/post.mdx", "src/pages/docs.mdx"],
      islands: ["src/pages/index.astro"],
      endpoints: ["src/pages/rss.xml.ts"],
      onDemand: ["src/pages/live.astro"],
    });
  });

  test("ignores a directive that is only text, and a prerender flag that is true", async () => {
    const files = new Map([
      ["src/pages/index.astro", "<pre>use client:load to hydrate</pre>\n<!-- client:visible -->\n"],
      ["src/pages/static.astro", "---\nexport const prerender = true;\n---\n<p>static</p>\n"],
    ]);
    expect(await detectProjectFeatures(files, { compiler })).toEqual({
      mdx: [],
      islands: [],
      endpoints: [],
      onDemand: [],
    });
  });

  test("reads every file it scans in one batch where the store can batch it", async () => {
    const sources = new Map([
      ["src/pages/index.astro", "<p>home</p>\n"],
      ["src/pages/live.md", "---\nexport const prerender = false;\n---\n"],
      ["src/components/Card.astro", "<div />\n"],
      ["src/styles/site.css", "p {}\n"],
    ]);
    const batches: string[][] = [];
    const singles: string[] = [];
    const files = {
      keys: () => sources.keys(),
      has: (path: string) => sources.has(path),
      get: (path: string) => {
        singles.push(path);
        return sources.get(path);
      },
      getMany: (paths: readonly string[]) => {
        batches.push([...paths]);
        return paths.map((path) => sources.get(path));
      },
    };
    const features = await detectProjectFeatures(files, { compiler });
    expect(features.onDemand).toEqual(["src/pages/live.md"]);
    expect(batches).toEqual([["src/pages/index.astro", "src/components/Card.astro", "src/pages/live.md"]]);
    expect(singles).toEqual([]);
  });

  test("is what ProjectHost.features reports for the current snapshot", async () => {
    const host = createProjectHost({
      store: createMapProjectStore(new Map([["src/pages/index.mdx", "# hi\n"]])),
      loader: new FileLoader(),
      compiler,
    });
    expect((await host.features()).mdx).toEqual(["src/pages/index.mdx"]);
  });
});
