import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

// A dynamic route that opts out of prerendering (`export const prerender =
// false`) has no `getStaticPaths` — there is no path list to enumerate,
// the params come from the URL. Pletivo used to treat that as unresolvable
// and 404, which makes the dev server useless for previewing exactly the
// pages an SSR site cares about most: CMS-backed detail pages.
//
// Dev now renders them, the way a server would. A static build still cannot
// emit them, and already says so.
const fixtureRoot = path.join(import.meta.dir, "../fixture-on-demand-routes");
const cliPath = path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 6789 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  serverProcess = Bun.spawn(["bun", "run", cliPath, "dev", String(PORT)], {
    cwd: fixtureRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Dev server did not start in time");
});

afterAll(async () => {
  serverProcess.kill();
  await fs.rm(path.join(fixtureRoot, "dist"), { recursive: true, force: true });
});

describe("dev server - on-demand dynamic routes", () => {
  test("renders a prerender=false dynamic route with params from the URL", async () => {
    const res = await fetch(BASE + "/on-demand/hello-world");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>On Demand</h1>");
    expect(html).toContain('<p id="slug">hello-world</p>');
  });

  test("any slug resolves — there is no path list to match against", async () => {
    for (const slug of ["a", "another-one", "with-123-digits"]) {
      const res = await fetch(BASE + `/on-demand/${slug}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`<p id="slug">${slug}</p>`);
    }
  });

  test("Astro.url.pathname reflects the requested URL", async () => {
    const html = await (await fetch(BASE + "/on-demand/some-slug")).text();
    expect(html).toContain('<p id="pathname">/on-demand/some-slug</p>');
  });

  test("the SSR globals still work on the route", async () => {
    const res = await fetch(BASE + "/on-demand/headers");
    expect(res.headers.get("cache-control")).toBe("s-maxage=300");
  });

  test("a dynamic route with neither getStaticPaths nor the opt-out stays a 404", async () => {
    const res = await fetch(BASE + "/unresolvable/anything");
    expect(res.status).toBe(404);
  });

  test("static pages are unaffected", async () => {
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Home Page</h1>");
  });
});

describe("build - on-demand dynamic routes", () => {
  test("builds the static pages and emits no on-demand route", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "build"], {
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const distDir = path.join(fixtureRoot, "dist");
    const index = await fs.readFile(path.join(distDir, "index.html"), "utf-8");
    expect(index).toContain("<h1>Home Page</h1>");

    // Nothing to enumerate means nothing on disk — the route belongs to a
    // server, and dev is where it can be previewed.
    const onDemand = await fs
      .stat(path.join(distDir, "on-demand"))
      .then(() => true)
      .catch(() => false);
    expect(onDemand).toBe(false);
  });
});
