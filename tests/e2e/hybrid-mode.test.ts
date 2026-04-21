import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";

const fixtureRoot = path.join(import.meta.dir, "../fixture-hybrid");
const cliPath = path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const DEBUG_HEADER = "x-test-debug";
const MARKER = path.join(os.tmpdir(), `pletivo-hybrid-${process.pid}.marker`);

let serverProcess: ReturnType<typeof Bun.spawn>;
let PORT: number;
let BASE: string;

async function waitReady(base: string) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base);
      if (r.status === 200 || r.status === 404) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Dev server did not start in time");
}

beforeAll(async () => {
  PORT = 5567 + Math.floor(Math.random() * 1000);
  BASE = `http://localhost:${PORT}`;
  // Ensure marker is absent so first renders succeed
  try { fs.unlinkSync(MARKER); } catch {}

  serverProcess = Bun.spawn(
    [
      "bun", "run", cliPath, "dev",
      `--port=${PORT}`,
      "--404-page=./src/error-pages/404.tsx",
      "--error-page=./src/error-pages/building.tsx",
      "--stale",
      `--debug-header=${DEBUG_HEADER}`,
    ],
    {
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PLETIVO_TEST_BREAK_MARKER: MARKER },
    },
  );
  await waitReady(BASE);
});

afterAll(() => {
  serverProcess.kill();
  try { fs.unlinkSync(MARKER); } catch {}
});

describe("hybrid dev mode", () => {
  test("custom 404 page renders for unknown route", async () => {
    const res = await fetch(`${BASE}/nonexistent`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Custom 404 from error-pages");
  });

  test("normal page renders and seeds snapshot", async () => {
    const res = await fetch(`${BASE}/flakey`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Flakey OK");
    expect(html).toContain("stable-body");
  });

  test("user sees stale snapshot when render breaks", async () => {
    fs.writeFileSync(MARKER, "x");
    try {
      const res = await fetch(`${BASE}/flakey`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Snapshot from the earlier successful render — NOT the error page
      expect(html).toContain("Flakey OK");
      expect(html).toContain("stable-body");
      expect(html).not.toContain("Agent is working");
      expect(html).not.toContain("<pre data-pletivo-error");
    } finally {
      fs.unlinkSync(MARKER);
    }
  });

  test("agent sees raw error when render breaks", async () => {
    fs.writeFileSync(MARKER, "x");
    try {
      const res = await fetch(`${BASE}/flakey`, {
        headers: { [DEBUG_HEADER]: "1" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<pre data-pletivo-error");
      expect(html).toContain("intentional break");
    } finally {
      fs.unlinkSync(MARKER);
    }
  });

  test("user sees error-page when broken and no snapshot exists", async () => {
    // /always-broken throws on every render, so no snapshot is ever seeded
    // → stale lookup misses → falls through to the configured error page.
    const res = await fetch(`${BASE}/always-broken`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Agent is working on it");
    expect(html).not.toContain("<pre data-pletivo-error");
  });

  test("agent hitting always-broken sees raw error", async () => {
    const res = await fetch(`${BASE}/always-broken`, {
      headers: { [DEBUG_HEADER]: "1" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<pre data-pletivo-error");
    expect(html).toContain("always throws");
  });

  test("user sees live render again after marker cleared", async () => {
    const res = await fetch(`${BASE}/flakey`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Flakey OK");
    expect(html).not.toContain("Agent is working");
  });
});
