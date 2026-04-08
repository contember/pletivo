import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import { dev } from "../../src/dev";

const fixtureRoot = path.join(import.meta.dir, "../fixture");
const PORT = 4567 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  // Start dev server as a subprocess to avoid blocking
  serverProcess = Bun.spawn(
    ["bun", "run", path.join(import.meta.dir, "../../src/cli.ts"), "dev", String(PORT)],
    { cwd: fixtureRoot, stdout: "pipe", stderr: "pipe" },
  );

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
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

describe("dev server - pages", () => {
  test("GET / returns 200 with home page", async () => {
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Home Page</h1>");
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("GET /about returns 200", async () => {
    const res = await fetch(BASE + "/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>About Page</h1>");
  });

  test("GET /blog returns 200 with post listing", async () => {
    const res = await fetch(BASE + "/blog");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Blog</h1>");
    expect(html).toContain("First Post");
  });

  test("GET /blog/post-one returns dynamic page", async () => {
    const res = await fetch(BASE + "/blog/post-one");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>First Post</h1>");
  });

  test("GET /nonexistent returns 404", async () => {
    const res = await fetch(BASE + "/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("dev server - static files", () => {
  test("GET /style.css returns CSS", async () => {
    const res = await fetch(BASE + "/style.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("font-family");
  });
});

describe("dev server - islands", () => {
  test("homepage contains island with SSR", async () => {
    const res = await fetch(BASE + "/");
    const html = await res.text();
    expect(html).toContain("<pavouk-island");
    expect(html).toContain('data-component="Counter"');
    expect(html).toContain("<button>Count: 5</button>");
  });

  test("GET /_islands/Counter.js returns island bundle", async () => {
    const res = await fetch(BASE + "/_islands/Counter.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const js = await res.text();
    expect(js).toContain("mount");
  });

  test("GET /_islands/NonExistent.js returns 404", async () => {
    const res = await fetch(BASE + "/_islands/NonExistent.js");
    expect(res.status).toBe(404);
  });
});

describe("dev server - HMR", () => {
  test("pages include HMR client script", async () => {
    const res = await fetch(BASE + "/");
    const html = await res.text();
    expect(html).toContain("/__hmr");
    expect(html).toContain("WebSocket");
  });

  test("WebSocket connection to /__hmr opens", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/__hmr`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(opened).toBe(true);
    ws.close();
  });
});

describe("dev server - hydration script", () => {
  test("pages with islands include hydration script", async () => {
    const res = await fetch(BASE + "/");
    const html = await res.text();
    expect(html).toContain("pavouk-island");
    expect(html).toContain("IntersectionObserver");
  });

  test("pages without islands do not include hydration script", async () => {
    const res = await fetch(BASE + "/about");
    const html = await res.text();
    expect(html).not.toContain("IntersectionObserver");
  });
});
