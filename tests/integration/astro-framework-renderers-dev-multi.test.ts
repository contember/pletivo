/**
 * `pletivo dev` with every framework renderer: each island's modules load in the browser,
 * including the before-hydration scripts, which in dev carry React's Fast Refresh preamble.
 * Runs on a copy of the fixture inside `tests/`, so the repo's `node_modules` resolve.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

const template = path.join(import.meta.dir, "../fixture-astro-renderers-multi");

let root = "";
let downloads = "";
let base = "";
let server: DevServer | null = null;

beforeAll(async () => {
  try {
    await startServer();
  } catch (error) {
    // Bun skips afterAll when beforeAll throws.
    await cleanup();
    throw error;
  }
}, 60_000);

afterAll(cleanup);

async function startServer(): Promise<void> {
  root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-dev-multi-"));
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-renderers-dev-multi-"));
  await fs.cp(template, root, { recursive: true });
  server = await startDevServer({ cwd: root, args: ["--host", "127.0.0.1", "--no-restart"], timeoutMs: 45_000 });
  base = server.url;
}

async function cleanup(): Promise<void> {
  if (server) {
    await server.stop();
    server = null;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
  if (downloads) await fs.rm(downloads, { recursive: true, force: true });
}

interface Island {
  componentUrl: string;
  rendererUrl: string;
  beforeHydrationUrl: string | null;
}

function islands(html: string): Island[] {
  return [...html.matchAll(/<astro-island [^>]*>/g)].map(([tag]) => {
    const attribute = (name: string) => tag.match(new RegExp(` ${name}="([^"]+)"`))?.[1] ?? null;
    const componentUrl = attribute("component-url");
    const rendererUrl = attribute("renderer-url");
    if (componentUrl === null || rendererUrl === null) throw new Error(`island without its module URLs: ${tag}`);
    return { componentUrl, rendererUrl, beforeHydrationUrl: attribute("before-hydration-url") };
  });
}

const transpiler = new Bun.Transpiler({ loader: "js" });

/**
 * Fetches `url` and every module it statically imports, as a browser would, into `downloads`
 * at the same path. Each must answer 200 with JavaScript, and import nothing a browser cannot resolve.
 */
async function fetchModuleGraph(url: string, seen = new Set<string>()): Promise<void> {
  if (seen.has(url)) return;
  seen.add(url);
  const response = await fetch(`${base}${url}`);
  const code = await response.text();
  expect({ url, status: response.status, body: response.status === 200 ? "" : code }).toEqual({ url, status: 200, body: "" });
  expect(response.headers.get("content-type")).toContain("javascript");
  const file = path.join(downloads, url);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, code);
  for (const entry of transpiler.scanImports(code)) {
    if (entry.kind !== "import-statement" && entry.kind !== "dynamic-import") continue;
    expect({ url, specifier: entry.path, browserResolvable: /^(\.{1,2})?\//.test(entry.path) }).toMatchObject({ browserResolvable: true });
    await fetchModuleGraph(new URL(entry.path, `${base}${url}`).pathname, seen);
  }
}

/** Evaluates downloaded modules in a fresh process with `window` as the global, and reports what each exports. */
async function evaluate(urls: readonly string[]): Promise<unknown> {
  const script = [
    "globalThis.window = globalThis;",
    "const exports = {};",
    "for (const url of JSON.parse(process.env.MODULE_URLS)) {",
    "  const mod = await import(process.env.DOWNLOADS + url);",
    "  exports[url] = Object.fromEntries(Object.entries(mod).map(([name, value]) => [name, typeof value]));",
    "}",
    "console.log(JSON.stringify({ exports, refreshHook: typeof globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ }));",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: downloads,
    env: { ...process.env, MODULE_URLS: JSON.stringify(urls), DOWNLOADS: downloads },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const result: unknown = JSON.parse(stdout);
  return result;
}

test("every island's component, renderer and before-hydration modules load, and its client entry and the preamble run", async () => {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  expect({ status: response.status, output: server?.output() }).toMatchObject({ status: 200 });

  const found = islands(html);
  expect(found).toHaveLength(5);
  const beforeHydration = new Set(found.map((island) => island.beforeHydrationUrl));
  // `@astrojs/react` injects its Fast Refresh preamble as a before-hydration script in dev.
  expect(beforeHydration.size).toBe(1);
  const [beforeHydrationUrl] = beforeHydration;
  if (beforeHydrationUrl == null) throw new Error("the islands carry no before-hydration-url");

  const renderers = [...new Set(found.map((island) => island.rendererUrl))];
  expect(renderers).toHaveLength(5);
  for (const url of [beforeHydrationUrl, ...renderers, ...found.map((island) => island.componentUrl)]) {
    await fetchModuleGraph(url);
  }

  // Astro's island imports the before-hydration module, then the component and renderer modules.
  expect(await evaluate([beforeHydrationUrl, ...renderers])).toMatchObject({
    exports: Object.fromEntries(renderers.map((url) => [url, { default: "function" }])),
    refreshHook: "object",
  });
}, 120_000);

test("the React Refresh runtime the preamble imports is served at its Vite URL", async () => {
  const response = await fetch(`${base}/@react-refresh`);
  const code = await response.text();
  expect({ status: response.status, body: response.status === 200 ? "" : code }).toEqual({ status: 200, body: "" });
  expect(response.headers.get("content-type")).toContain("javascript");
  expect(code).toContain("injectIntoGlobalHook");
}, 30_000);
