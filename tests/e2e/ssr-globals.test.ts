import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

// End-to-end cover for the SSR-shaped Astro globals — `Astro.response`,
// `Astro.cookies`, `Astro.redirect`. These have no meaning in a static build,
// but pages written for SSR use them constantly, so they must render rather
// than throw. In dev the values are served for real; a build folds a redirect
// into a meta-refresh page and drops headers/cookies (a file has neither).
const fixtureRoot = path.join(import.meta.dir, "../fixture-ssr-globals");
const cliPath = path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 5678 + Math.floor(Math.random() * 1000);
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

describe("dev server - SSR-shaped Astro globals", () => {
  test("Astro.response.headers reaches the wire", async () => {
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("s-maxage=60");
    // Our own Content-Type is not clobbered.
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("Astro.cookies writes become Set-Cookie", async () => {
    const res = await fetch(BASE + "/");
    expect(res.headers.get("set-cookie")).toContain("visited=1");
  });

  test("Astro.cookies reads the request's Cookie header", async () => {
    const res = await fetch(BASE + "/", { headers: { cookie: "seen=yesterday" } });
    expect(await res.text()).toContain(">yesterday<");
  });

  test("a returned Astro.redirect is served as a real redirect", async () => {
    const res = await fetch(BASE + "/old", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("redirected=1");
  });

  test("Astro.clientAddress is the requesting IP", async () => {
    const html = await (await fetch(BASE + "/")).text();
    const ip = html.match(/<p id="ip">([^<]*)<\/p>/)?.[1];
    expect(ip).toBeTruthy();
    expect(ip).not.toBe("none");
  });

  test("Astro.clientAddress honours x-forwarded-for", async () => {
    const res = await fetch(BASE + "/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(await res.text()).toContain('<p id="ip">203.0.113.7</p>');
  });

  test("a returned Astro.rewrite serves the target's content at this URL", async () => {
    const res = await fetch(BASE + "/rewritten");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Rewrite Target</h1>");
    // Routing re-ran for the target, so the rendered route sees its own path.
    expect(html).toContain('<p id="pathname">/target</p>');
  });

  test("the dev server survives all of the above", async () => {
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Home Page</h1>");
  });
});

describe("build - SSR-shaped Astro globals", () => {
  test("pages using them build, and a redirect becomes a meta-refresh page", async () => {
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
    // No request during a build, so the cookie read falls back.
    expect(index).toContain(">none<");

    // No request during a build, so `Astro.clientAddress` falls back too.
    expect(index).toContain('<p id="ip">none</p>');

    const redirected = await fs.readFile(path.join(distDir, "old/index.html"), "utf-8");
    expect(redirected).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(redirected).toContain('<meta name="robots" content="noindex">');

    // A rewrite writes the target's HTML at the rewriting route's path.
    const rewritten = await fs.readFile(
      path.join(distDir, "rewritten/index.html"),
      "utf-8",
    );
    expect(rewritten).toContain("<h1>Rewrite Target</h1>");
    expect(rewritten).toContain('<p id="pathname">/target</p>');
  });
});

// A bad rewrite must fail loudly. Own fixture + dev server: a cycle or an
// unmatched target would otherwise hang the build used above.
describe("dev server - bad Astro.rewrite targets", () => {
  const loopRoot = path.join(import.meta.dir, "../fixture-ssr-globals-loop");
  const loopPort = PORT + 1;
  const loopBase = `http://localhost:${loopPort}`;
  let loopProcess: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    loopProcess = Bun.spawn(["bun", "run", cliPath, "dev", String(loopPort)], {
      cwd: loopRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(loopBase);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("Dev server did not start in time");
  });

  afterAll(() => loopProcess.kill());

  test("a rewrite cycle stops at the hop limit instead of hanging", async () => {
    const html = await (await fetch(loopBase + "/loop")).text();
    expect(html).toContain("hops");
  });

  test("a rewrite to an unmatched route errors", async () => {
    const html = await (await fetch(loopBase + "/missing")).text();
    expect(html).toContain("matched no route");
  });
});
