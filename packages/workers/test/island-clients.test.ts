import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIslandClientUrls } from "@pletivo/core/island-urls";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { loadProjectArtifact, type ProjectArtifact } from "../src/artifact.ts";
import { MissingIslandClientError, pageIslandClients } from "../src/island-clients.ts";
import { createProjectHost } from "../src/project-host.ts";
import { createMapProjectStore } from "../src/project-store.ts";
import { renderPage, type RenderedPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";
import { readSources } from "./sources.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

/**
 * A React project prepared for real, then rendered with `.astro` edits made after prepare:
 * which island client modules the artifact carries is fixed at prepare (docs/todos/027).
 * Prepare runs in a CLI process, as an islands `Bun.build` is process-global.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CLI = path.join(REPO_ROOT, "packages/pletivo/src/cli.ts");
const HAS_TAILWIND = tailwindDir() !== null;

/** Applied only after the island opens, so the server render never writes it. */
const CLIENT_ONLY_CLASS = "text-pink-600";
const CLIENT_ONLY_RULE = /\.text-pink-600\s*\{/;

const PAGE_HEAD = `<html lang="en"><head><title>Islands</title></head><body>`;

function page(imports: string, body: string): string {
  return `---\nimport "../styles/global.css";\n${imports}\n---\n${PAGE_HEAD}${body}</body></html>\n`;
}

function notes(imports: string, body: string): string {
  return `${imports}\n\n# Notes\n\n${body}\n`;
}

const COUNTER_IMPORT = 'import { Counter } from "../components/Counter";';

const FILES: Readonly<Record<string, string>> = {
  "astro.config.mjs": 'import react from "@astrojs/react";\nexport default { integrations: [react()] };\n',
  "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" } }\n',
  "src/styles/global.css": '@import "tailwindcss";\n',
  "src/components/Counter.jsx": `import { useState } from "react";
export function Counter() {
  const [open, setOpen] = useState(false);
  return <div><button onClick={() => setOpen(!open)}>toggle</button>{open ? <p className="${CLIENT_ONLY_CLASS}">open</p> : null}</div>;
}
export function Badge() {
  return <span>badge</span>;
}
`,
  "src/components/Other.jsx": "export default function Other() {\n  return <em>other</em>;\n}\n",
  // Named like Bun's chunks, but an entry: its URL keeps its name across prepares.
  "src/components/chunk-list.jsx": "export default function ChunkList() {\n  return <ul />;\n}\n",
  "src/components/Footer.jsx": "export default function Footer() {\n  return <footer>footer</footer>;\n}\n",
  "src/components/Note.jsx": "export default function Note() {\n  return <aside>note</aside>;\n}\n",
  // Outside `srcDir`: prepare reads its hydrations all the same.
  "layouts/Base.astro": '---\nimport Footer from "../src/components/Footer";\n---\n<html lang="en"><head><title>Layout</title></head><body><slot /><Footer client:idle /></body></html>\n',
  "src/pages/index.astro": page(
    `${COUNTER_IMPORT}\nimport Other from "../components/Other";\nimport ChunkList from "../components/chunk-list";`,
    "<Counter client:load /><Other /><ChunkList client:idle />",
  ),
  "src/pages/plain.astro": page("", "<p>plain</p>"),
  "src/pages/notes.mdx": notes('import Note from "../components/Note";', "<Note client:load />"),
  "src/pages/layout.astro": '---\nimport Base from "../../layouts/Base.astro";\n---\n<Base><p>in a layout</p></Base>\n',
};

let root = "";
let artifactValue: unknown;
let artifact: ProjectArtifact;
let files: Map<string, string>;
const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-island-clients-"));
  await fs.mkdir(path.join(root, ".git"));
  await linkPackages(root);
  for (const [file, source] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  const child = Bun.spawn(["bun", CLI, "prepare", "--out", ".pletivo"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`prepare failed:\n${stdout}${stderr}`);
  artifactValue = JSON.parse(await fs.readFile(path.join(root, ".pletivo/pletivo-artifact.json"), "utf8"));
  artifact = loadProjectArtifact(artifactValue);
  files = (await readSources(root)).text;
}, 120_000);

/** The workspace's packages, and this package's own Tailwind, which the workspace root does not hoist. */
async function linkPackages(directory: string): Promise<void> {
  const target = path.join(directory, "node_modules");
  await fs.mkdir(target);
  const sources = [path.join(REPO_ROOT, "node_modules"), path.join(import.meta.dir, "../node_modules")];
  for (const source of sources) {
    for (const entry of await fs.readdir(source)) {
      await fs.symlink(path.join(source, entry), path.join(target, entry)).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
    }
  }
}

afterAll(async () => {
  await loader.cleanup();
  if (root !== "") await fs.rm(root, { recursive: true, force: true });
});

async function render(pathname: string, edits: Readonly<Record<string, string>> = {}): Promise<RenderedPage> {
  return renderPage({
    files: new Map([...files, ...Object.entries(edits)]),
    pathname,
    loader,
    compiler,
    pagesDir: "src/pages",
    artifact,
    executionNamespace: { tenant: "island-clients", capabilityGeneration: "test" },
    tailwind: HAS_TAILWIND ? await tailwindStylesheets() : undefined,
  });
}

/** The URL a render names for this import spelling and export, as both hosts compute it. */
function componentUrl(specifier: string, exportName: string): string {
  const projectRoot = artifact.islands?.projectRoot ?? "";
  return createIslandClientUrls({ projectRoot, base: "/" }).component(`${projectRoot}/src/${specifier.replace("../", "")}`, exportName);
}

async function missingUrl(edits: Readonly<Record<string, string>>, pathname = "/"): Promise<MissingIslandClientError> {
  try {
    await render(pathname, edits);
  } catch (error) {
    if (error instanceof MissingIslandClientError) return error;
    throw error;
  }
  throw new Error("the render hydrated an island without a client module and did not fail");
}

describe("island client modules fixed at prepare", () => {
  test("the page prepare saw loads modules the artifact carries", async () => {
    const rendered = await render("/");
    const loaded = pageIslandClients(rendered.html, artifact.islands ?? fail());
    expect(loaded.map((client) => client.url)).toContain(componentUrl("../components/Counter", "Counter"));
  }, 60_000);

  test("a layout outside srcDir hydrates a component prepare built", async () => {
    const rendered = await render("/layout/");
    const url = componentUrl("../components/Footer", "default");
    expect(rendered.html).toContain(`component-url="${url}"`);
    expect(artifact.islands?.clients.has(url)).toBe(true);
  }, 60_000);

  test("an .mdx page hydrates a component prepare built", async () => {
    const rendered = await render("/notes/");
    const url = componentUrl("../components/Note", "default");
    expect(rendered.html).toContain(`component-url="${url}"`);
    expect(artifact.islands?.clients.has(url)).toBe(true);
  }, 60_000);

  test("a new hydration in an .mdx page fails the render, naming the URL and the fix", async () => {
    const error = await missingUrl(
      { "src/pages/notes.mdx": notes('import Other from "../components/Other";', "<Other client:load />") },
      "/notes/",
    );
    const url = componentUrl("../components/Other", "default");
    expect(error.url).toBe(url);
    expect(error.message).toContain("Re-run `pletivo prepare`");
  }, 60_000);

  test("the host serves each client module as JavaScript, caching only a content-named chunk", async () => {
    const host = createProjectHost({ store: createMapProjectStore(files), artifact: artifactValue, loader, compiler, pagesDir: "src/pages" });
    const clients = [...(artifact.islands?.clients.values() ?? [])];
    const entry = clients.find((client) => client.url === componentUrl("../components/Counter", "Counter"));
    const chunk = clients.find((client) => client.chunk);
    if (entry === undefined || chunk === undefined) throw new Error("no entry or no chunk");
    const served = await host.fetch(new Request(`http://localhost${entry.url}`));
    expect(served.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(served.headers.get("cache-control")).toBe("no-cache");
    expect(await served.text()).toBe(entry.source);
    const cached = await host.fetch(new Request(`http://localhost${chunk.url}`, { method: "HEAD" }));
    expect(cached.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(cached.headers.get("etag")).toBeNull();
    expect(await cached.text()).toBe("");
  }, 60_000);

  test("a component named like a chunk is revalidated, not cached as one", async () => {
    const host = createProjectHost({ store: createMapProjectStore(files), artifact: artifactValue, loader, compiler, pagesDir: "src/pages" });
    const url = componentUrl("../components/chunk-list", "default");
    expect(url.startsWith("/_astro/chunk-list.")).toBe(true);
    const served = await host.fetch(new Request(`http://localhost${url}`));
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("no-cache");
  }, 60_000);

  test("an unchanged client module revalidates with 304", async () => {
    const host = createProjectHost({ store: createMapProjectStore(files), artifact: artifactValue, loader, compiler, pagesDir: "src/pages" });
    const url = componentUrl("../components/Counter", "Counter");
    const etag = (await host.fetch(new Request(`http://localhost${url}`))).headers.get("etag");
    if (etag === null) throw new Error("no ETag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const revalidated = await host.fetch(new Request(`http://localhost${url}`, { headers: { "if-none-match": ifNoneMatch } }));
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(etag);
      expect(await revalidated.text()).toBe("");
    }
    const changed = await host.fetch(new Request(`http://localhost${url}`, { headers: { "if-none-match": '"other"' } }));
    expect(changed.status).toBe(200);
  }, 60_000);

  test("moving a hydrated island to another page stays live", async () => {
    const rendered = await render("/plain/", {
      "src/pages/index.astro": page("", "<p>moved</p>"),
      "src/pages/plain.astro": page(COUNTER_IMPORT, "<p>plain</p><Counter client:visible />"),
    });
    const url = componentUrl("../components/Counter", "Counter");
    expect(rendered.html).toContain(`component-url="${url}"`);
    expect(artifact.islands?.clients.has(url)).toBe(true);
  }, 60_000);

  const unprepared: { name: string; specifier: string; exportName: string; imports: string; body: string }[] = [
    {
      name: "a claimed component no .astro hydrated",
      specifier: "../components/Other",
      exportName: "default",
      imports: 'import Other from "../components/Other";',
      body: "<Other client:load />",
    },
    {
      name: "another export of a hydrated component",
      specifier: "../components/Counter",
      exportName: "Badge",
      imports: 'import { Badge } from "../components/Counter";',
      body: "<Badge client:load />",
    },
    {
      name: "another spelling of a hydrated import",
      specifier: "../components/Counter.jsx",
      exportName: "Counter",
      imports: 'import { Counter } from "../components/Counter.jsx";',
      body: "<Counter client:load />",
    },
  ];
  for (const scenario of unprepared) {
    test(`hydrating ${scenario.name} fails the render, naming the URL and the fix`, async () => {
      const error = await missingUrl({ "src/pages/index.astro": page(scenario.imports, scenario.body) });
      const url = componentUrl(scenario.specifier, scenario.exportName);
      expect(error.url).toBe(url);
      expect(error.message).toContain(url);
      expect(error.message).toContain("Re-run `pletivo prepare`");
    }, 60_000);
  }

  test.skipIf(!HAS_TAILWIND)("a Tailwind class only an island's source applies reaches the page CSS", async () => {
    const island = await render("/");
    expect(island.html).not.toContain(`class="${CLIENT_ONLY_CLASS}"`);
    expect(island.html).toMatch(CLIENT_ONLY_RULE);
    // Not every page's: one without the island does not get it.
    expect((await render("/plain/")).html).not.toMatch(CLIENT_ONLY_RULE);
  }, 60_000);
});

function fail(): never {
  throw new Error("the artifact has no islands");
}
