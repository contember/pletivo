import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AstroRendererEntry } from "../../packages/core/src/astro-host/renderers";
import type { FrameworkCompileTarget, FrameworkCompiler } from "../../packages/core/src/framework-compile/types";
import { createIslandClientUrls } from "../../packages/core/src/island-urls";
import {
  bundleAstroIslands,
  type AstroIslandComponent,
  type VirtualModuleSource,
} from "../../packages/pletivo/src/astro-islands-bundle";

const root = path.resolve(import.meta.dir, "../fixture-astro-islands-bundle");
const components = path.join(root, "src/components");
const base = "/docs";

// Extensionless, as `client:component-path` arrives when the import had none.
const preactCounter = { componentPath: path.join(components, "PreactCounter"), exportName: "default" };
const reactCounter = { componentPath: path.join(components, "ReactCounter.jsx"), exportName: "Counter" };
const reactLabel = { componentPath: path.join(components, "ReactCounter.jsx"), exportName: "Label" };
const reactNamespace = { componentPath: path.join(components, "frameworks.js"), exportName: "react.Counter" };
const svelteCounter = { componentPath: path.join(components, "Counter.svelte"), exportName: "default" };
const vueCounter = { componentPath: path.join(components, "Counter.vue"), exportName: "default" };
// A bare import stays a package specifier, as Astro's `resolvePath` leaves it.
const packageExport = { componentPath: "preact", exportName: "h" };
const islands: AstroIslandComponent[] = [preactCounter, reactCounter, reactLabel, reactNamespace, svelteCounter, vueCounter, packageExport];

const renderers: AstroRendererEntry[] = [
  { name: "@astrojs/preact", serverEntrypoint: "@astrojs/preact/server.js", clientEntrypoint: "@astrojs/preact/client.js" },
  { name: "@astrojs/react", serverEntrypoint: "@astrojs/react/server.js", clientEntrypoint: "@astrojs/react/client.js" },
  { name: "@astrojs/solid-js", serverEntrypoint: "@astrojs/solid-js/server.js", clientEntrypoint: "@astrojs/solid-js/client.js" },
  { name: "@astrojs/svelte", serverEntrypoint: "@astrojs/svelte/server.js", clientEntrypoint: "@astrojs/svelte/client.js" },
  { name: "@astrojs/vue", serverEntrypoint: "@astrojs/vue/server.js", clientEntrypoint: "@astrojs/vue/client.js" },
];

// Astro's app module when the Vue integration has no `appEntrypoint`.
const virtualModules: Readonly<Record<string, string>> = { "virtual:@astrojs/vue/app": "export const setup = () => {};\n" };

/** Stands in for the host's Vite plugins. */
async function virtualModule(specifier: string): Promise<VirtualModuleSource | null> {
  const code = virtualModules[specifier];
  return code === undefined ? null : { code, loader: "js" };
}

const noVirtualModules = async (): Promise<VirtualModuleSource | null> => null;

/** Every chunk a built module in `dir` statically imports, directly or through other chunks. */
async function chunkClosure(dir: string, file: string): Promise<Set<string>> {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const seen = new Set<string>();
  const queue = [file];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    const imports = transpiler.scanImports(await Bun.file(path.join(dir, current)).text());
    for (const entry of imports) {
      if (entry.kind !== "import-statement" || !entry.path.startsWith("./")) continue;
      const chunk = entry.path.slice(2);
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      queue.push(chunk);
    }
  }
  return seen;
}

/** Stands in for the Svelte and Vue compilers and records the target each file was compiled for. */
function fakeCompiler(framework: string, extension: string, targets: FrameworkCompileTarget[]): FrameworkCompiler {
  return {
    framework,
    extensions: [extension],
    async compile(input) {
      targets.push(input.target);
      return {
        code: `export default function ${framework}Counter() { return ${JSON.stringify(framework)}; }\n`,
        loader: "js",
        css: `.${framework.toLowerCase()}{color:red}`,
      };
    },
  };
}

/** A JSX compiler is offered `.js`; declining every file must still leave the entry modules alone. */
const decliningCompiler: FrameworkCompiler = {
  framework: "Declining",
  extensions: [".js", ".jsx"],
  async compile() {
    return null;
  },
};

const beforeHydrationScripts = [
  `import { version } from "react";\nglobalThis.pletivoBeforeHydration = [version];`,
  `globalThis.pletivoBeforeHydration.push("second");`,
];

describe("createIslandClientUrls", () => {
  const projectRoot = "/srv/site";

  test("names a component after its file and a renderer `client`, under the base's _astro/", () => {
    const urls = createIslandClientUrls({ projectRoot, base: "/docs" });
    expect(urls.component("/srv/site/src/Counter.jsx", "default")).toMatch(/^\/docs\/_astro\/Counter\.[\w-]{8}\.js$/);
    expect(urls.component("/srv/site/src/Counter", "default")).toMatch(/^\/docs\/_astro\/Counter\.[\w-]{8}\.js$/);
    expect(urls.renderer("@astrojs/react")).toMatch(/^\/docs\/_astro\/client\.[\w-]{8}\.js$/);
    expect(urls.renderer("@astrojs/svelte")).toMatch(/^\/docs\/_astro\/client\.svelte\.[\w-]{8}\.js$/);
    expect(createIslandClientUrls({ projectRoot, base: "/" }).renderer("@astrojs/react")).toMatch(/^\/_astro\/client\.[\w-]{8}\.js$/);
  });

  test("the same inputs give the same URLs", () => {
    const a = createIslandClientUrls({ projectRoot, base: "/docs" });
    const b = createIslandClientUrls({ projectRoot, base: "/docs/" });
    expect(a.component("/srv/site/src/Counter.jsx", "Counter")).toBe(b.component("/srv/site/src/Counter.jsx", "Counter"));
    expect(a.renderer("@astrojs/preact")).toBe(b.renderer("@astrojs/preact"));
  });

  test("gives a before-hydration URL only when there are scripts", () => {
    expect(createIslandClientUrls({ projectRoot, base: "/docs" }).beforeHydration).toBeNull();
    expect(createIslandClientUrls({ projectRoot, base: "/docs", beforeHydrationScripts: [] }).beforeHydration).toBeNull();
    const url = createIslandClientUrls({ projectRoot, base: "/docs", beforeHydrationScripts: ["a()"] }).beforeHydration;
    expect(url).toMatch(/^\/docs\/_astro\/before-hydration\.[\w-]{8}\.js$/);
    expect(createIslandClientUrls({ projectRoot, base: "/docs", beforeHydrationScripts: ["a()"] }).beforeHydration).toBe(url);
    expect(createIslandClientUrls({ projectRoot, base: "/docs", beforeHydrationScripts: ["b()"] }).beforeHydration).not.toBe(url);
  });

  test("different inputs give different URLs", () => {
    const urls = createIslandClientUrls({ projectRoot, base: "/" });
    const file = "/srv/site/src/Counter.jsx";
    expect(urls.component(file, "A")).not.toBe(urls.component(file, "B"));
    expect(urls.component(file, "default")).not.toBe(urls.component("/srv/site/other/Counter.jsx", "default"));
    expect(urls.renderer("@astrojs/preact")).not.toBe(urls.renderer("@astrojs/react"));
  });

  test("a component's URL does not depend on where the project is", () => {
    const a = createIslandClientUrls({ projectRoot, base: "/" });
    const b = createIslandClientUrls({ projectRoot: "/home/ci/checkouts/site-b", base: "/" });
    expect(a.component("/srv/site/src/Counter.jsx", "default")).toBe(
      b.component("/home/ci/checkouts/site-b/src/Counter.jsx", "default"),
    );
  });
});

describe("bundleAstroIslands", () => {
  const urls = createIslandClientUrls({ projectRoot: root, base, beforeHydrationScripts });
  const compileTargets: FrameworkCompileTarget[] = [];
  let distDir: string;

  /** The dist file a URL names: the base is not part of the output layout. */
  const distFile = (url: string) => path.join(distDir, url.slice(`${base}/`.length));
  const load = (url: string): Promise<Record<string, unknown>> => import(distFile(url));

  beforeAll(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-astro-islands-bundle-"));
    await bundleAstroIslands({
      projectRoot: root,
      distDir,
      base,
      beforeHydrationScripts,
      components: islands,
      renderers,
      virtualModule,
      compilers: [
        decliningCompiler,
        fakeCompiler("Svelte", ".svelte", compileTargets),
        fakeCompiler("Vue", ".vue", compileTargets),
      ],
    });
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("emits a file at every URL the render can ask for", async () => {
    const expected = [
      ...islands.map((island) => urls.component(island.componentPath, island.exportName)),
      ...renderers.map((renderer) => urls.renderer(renderer.name)),
      urls.beforeHydration,
    ].filter((url) => url !== null);
    expect(new Set(expected).size).toBe(expected.length);
    for (const url of expected) {
      expect(await Bun.file(distFile(url)).exists()).toBe(true);
    }
  });

  test("each component module exports the component at its export path", async () => {
    for (const island of [preactCounter, reactCounter, reactLabel, svelteCounter, vueCounter]) {
      const mod = await load(urls.component(island.componentPath, island.exportName));
      expect(typeof mod[island.exportName]).toBe("function");
    }
    const namespaced = await load(urls.component(reactNamespace.componentPath, reactNamespace.exportName));
    const react = namespaced.react;
    expect(typeof react === "object" && react !== null && "Counter" in react && typeof react.Counter).toBe("function");
  });

  test("a component imported from a package resolves from the project's packages", async () => {
    const mod = await load(urls.component(packageExport.componentPath, packageExport.exportName));
    expect(typeof mod.h).toBe("function");
  });

  test("each renderer module default-exports its client hydrator", async () => {
    for (const renderer of renderers) {
      const mod = await load(urls.renderer(renderer.name));
      expect(typeof mod.default).toBe("function");
    }
  });

  test("the before-hydration module runs every script, with bare imports resolved from the project root", async () => {
    if (urls.beforeHydration === null) throw new Error("no before-hydration URL");
    await load(urls.beforeHydration);
    const manifest: unknown = JSON.parse(await Bun.file(require.resolve("react/package.json", { paths: [root] })).text());
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : null;
    expect(Reflect.get(globalThis, "pletivoBeforeHydration")).toEqual([version, "second"]);
  });

  // The fixture sits under the repo's tsconfig, which maps `preact/hooks` onto the SSR stub
  // (docs/todos/013). The stub's `useState` works outside a render; the real one has no
  // current component there and throws on its `__H` hook state.
  test("Preact components get the real preact/hooks, not the SSR stub", async () => {
    const mod = await load(urls.component(preactCounter.componentPath, preactCounter.exportName));
    const Counter = mod.default;
    if (typeof Counter !== "function") throw new Error("PreactCounter is not a function");
    expect(() => Counter({})).toThrow(/__H/);
  });

  test("Svelte and Vue files compile through the framework compilers for the client", async () => {
    expect(compileTargets).toEqual(["client", "client"]);
    const svelte = await load(urls.component(svelteCounter.componentPath, "default"));
    const vue = await load(urls.component(vueCounter.componentPath, "default"));
    expect(typeof svelte.default === "function" && svelte.default()).toBe("Svelte");
    expect(typeof vue.default === "function" && vue.default()).toBe("Vue");
  });

  test("two exports of one file get two modules, each with its own export", async () => {
    const counter = await load(urls.component(reactCounter.componentPath, "Counter"));
    const label = await load(urls.component(reactLabel.componentPath, "Label"));
    expect(Object.keys(counter)).toEqual(["Counter"]);
    expect(Object.keys(label)).toEqual(["Label"]);
  });

  test("two files with one base name get two modules", async () => {
    const svelteUrl = urls.component(svelteCounter.componentPath, "default");
    const vueUrl = urls.component(vueCounter.componentPath, "default");
    expect(path.basename(svelteUrl)).toStartWith("Counter.");
    expect(path.basename(vueUrl)).toStartWith("Counter.");
    expect(svelteUrl).not.toBe(vueUrl);
    const svelte = await load(svelteUrl);
    const vue = await load(vueUrl);
    expect(svelte.default).not.toBe(vue.default);
  });

  test("a renderer's client and its components share one framework chunk", async () => {
    const pairs: Array<[AstroIslandComponent, string]> = [
      [preactCounter, "@astrojs/preact"],
      [reactCounter, "@astrojs/react"],
    ];
    for (const [island, rendererName] of pairs) {
      const astroDir = path.join(distDir, "_astro");
      const component = await chunkClosure(astroDir, path.basename(urls.component(island.componentPath, island.exportName)));
      const client = await chunkClosure(astroDir, path.basename(urls.renderer(rendererName)));
      expect([...component].filter((chunk) => client.has(chunk))).not.toEqual([]);
    }
  });

  test("drops client-side CSS, which the server render already put on the page", async () => {
    const files = await fs.readdir(path.join(distDir, "_astro"));
    expect(files.filter((file) => file.endsWith(".css"))).toEqual([]);
  });

  test("bundles the production build of React", async () => {
    const client = await Bun.file(distFile(urls.renderer("@astrojs/react"))).text();
    expect(client).not.toContain("development");
  });
});

describe("bundleAstroIslands failures", () => {
  let distDir: string;

  beforeAll(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-astro-islands-bundle-fail-"));
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("names the island whose component does not resolve", async () => {
    const missing = path.join(components, "Missing.jsx");
    const bundle = bundleAstroIslands({
      projectRoot: root,
      distDir,
      base: "/",
      components: [preactCounter, { componentPath: missing, exportName: "default" }],
      renderers: [],
      compilers: [],
      virtualModule: noVirtualModules,
    });
    await expect(bundle).rejects.toThrow(`island entry for export "default" of ${missing}`);
  });

  test("a virtual module no plugin loads fails, naming it", async () => {
    const bundle = bundleAstroIslands({
      projectRoot: root,
      distDir,
      base: "/",
      components: [],
      renderers: renderers.filter((renderer) => renderer.name === "@astrojs/vue"),
      compilers: [],
      virtualModule: noVirtualModules,
    });
    await expect(bundle).rejects.toThrow("virtual:@astrojs/vue/app");
  });
});

describe("bundleAstroIslands, a binary file an island imports", () => {
  let project: string;

  beforeAll(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-astro-islands-bundle-asset-"));
  });

  afterAll(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  test("is written byte for byte", async () => {
    // Not valid UTF-8, so a text round trip would change it.
    const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00]);
    await fs.mkdir(path.join(project, "src"));
    await fs.writeFile(path.join(project, "src/font.woff2"), font);
    await fs.writeFile(path.join(project, "src/Logo.js"), 'import font from "./font.woff2";\nexport default () => font;\n');
    const distDir = path.join(project, "dist");
    await bundleAstroIslands({
      projectRoot: project,
      distDir,
      base: "/",
      components: [{ componentPath: path.join(project, "src/Logo.js"), exportName: "default" }],
      renderers: [],
      compilers: [],
      virtualModule: noVirtualModules,
    });
    const written = (await fs.readdir(path.join(distDir, "_astro"))).filter((file) => file.endsWith(".woff2"));
    expect(written).toHaveLength(1);
    expect(new Uint8Array(await fs.readFile(path.join(distDir, "_astro", written[0] ?? "")))).toEqual(font);
  });
});
