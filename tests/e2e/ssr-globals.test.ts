import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

// End-to-end cover for the SSR-shaped Astro globals — `Astro.response`,
// `Astro.locals`, `Astro.cookies`, `Astro.redirect`, `Astro.clientAddress`.
// These have no meaning in a static build, but pages written for SSR use them
// constantly, so they must render rather than throw. In dev the values are
// served for real; a build folds a redirect into a meta-refresh page, drops
// headers/cookies (a file has neither), and warns that it did.
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

  test("a custom 404 gets the SSR globals too", async () => {
    const res = await fetch(BASE + "/no-such-page");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>Custom 404</h1>");
    expect(res.headers.get("x-from-404")).toBe("1");
    expect(res.headers.get("set-cookie")).toContain("seen-404=1");
  });

  test("the dev server survives all of the above", async () => {
    const res = await fetch(BASE + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Home Page</h1>");
  });
});

describe("build - SSR-shaped Astro globals", () => {
  test("pages using them build, a redirect becomes meta-refresh, and dropped writes are reported", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "build"], {
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);

    const distDir = path.join(fixtureRoot, "dist");
    const index = await fs.readFile(path.join(distDir, "index.html"), "utf-8");
    expect(index).toContain("<h1>Home Page</h1>");
    // No request during a build, so the cookie read falls back.
    expect(index).toContain(">none<");

    const redirected = await fs.readFile(path.join(distDir, "old/index.html"), "utf-8");
    expect(redirected).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(redirected).toContain('<meta name="robots" content="noindex">');

    // The whole point of the warning: a page whose cache headers silently
    // never ship should say so at build time.
    const out = stdout + stderr;
    expect(out).toContain("index.astro");
    expect(out).toContain("prerender = false");
    expect(out).toContain("cache-control");
    expect(out).toContain("Astro.cookies");
  });
});

// `Astro.clientAddress` resolves only in dev, and throws in a build the way
// Astro does — so its fixture is dev-only and its build is expected to fail.
describe("Astro.clientAddress", () => {
  const devRoot = path.join(import.meta.dir, "../fixture-ssr-globals-dev");
  const devPort = PORT + 1;
  const devBase = `http://localhost:${devPort}`;
  let devProcess: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    devProcess = Bun.spawn(["bun", "run", cliPath, "dev", String(devPort)], {
      cwd: devRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(devBase);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("Dev server did not start in time");
  });

  afterAll(async () => {
    devProcess.kill();
    await fs.rm(path.join(devRoot, "dist"), { recursive: true, force: true });
  });

  test("resolves to the requesting IP in dev", async () => {
    const html = await (await fetch(devBase + "/")).text();
    const ip = html.match(/<p id="ip">([^<]*)<\/p>/)?.[1];
    expect(ip).toBeTruthy();
  });

  test("honours x-forwarded-for", async () => {
    const res = await fetch(devBase + "/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(await res.text()).toContain('<p id="ip">203.0.113.7</p>');
  });

  test("reading it in a build fails, as it does in Astro", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "build"], {
      cwd: devRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain("`Astro.clientAddress` is not available in a static build");
  });
});
