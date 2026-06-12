import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "path";

// Regression: a custom `404.astro` whose component tree reads `Astro.url.pathname`
// used to crash the dev server, because render404 invoked the page with no
// pageContext (so `Astro.url` was `undefined`). render404 now builds the same
// Astro-style pageContext as the normal render path.
const fixtureRoot = path.join(import.meta.dir, "../fixture-404-astro");
const PORT = 5678 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  serverProcess = Bun.spawn(
    ["bun", "run", path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts"), "dev", String(PORT)],
    { cwd: fixtureRoot, stdout: "pipe", stderr: "pipe" },
  );

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

afterAll(() => {
  serverProcess.kill();
});

describe("dev server - custom 404.astro reading Astro.url", () => {
  test("renders the custom 404 page (not a fallback) with a real Astro.url", async () => {
    const res = await fetch(BASE + "/pripady/[slug]");
    expect(res.status).toBe(404);
    const html = await res.text();
    // Custom 404 rendered — not the plain "Not Found" fallback.
    expect(html).toContain("404 - Custom Not Found");
    // Astro.url was defined: the Seo component echoed the requested pathname.
    expect(html).toContain('content="/pripady/[slug]"');
  });

  test("the dev server is still alive after rendering the 404 (no crash)", async () => {
    // A second request only succeeds if the prior 404 render did not take the
    // process down.
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Home Page</h1>");
  });
});
