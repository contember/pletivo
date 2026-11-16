import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "path";

const fixtureRoot = path.join(import.meta.dir, "../fixture-endpoint-routes");
const cliPath = path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 7789 + Math.floor(Math.random() * 1000);
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

afterAll(() => {
  serverProcess.kill();
});

describe("dev server - endpoint routes", () => {
  test("an extensionless endpoint serves its handler's body and Content-Type", async () => {
    const res = await fetch(BASE + "/api");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ foo: "bar" });
  });

  test("a script page with a default export still serves HTML", async () => {
    const res = await fetch(BASE + "/plain");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>Plain page</h1>");
  });

  test("an endpoint with an extension serves its handler's body", async () => {
    const res = await fetch(BASE + "/data.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await res.json()).items).toEqual([1, 2, 3]);
  });

  test("a dynamic endpoint serves a listed id with its props", async () => {
    const res = await fetch(BASE + "/items/a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a", label: "Item A" });
  });

  test("a dynamic endpoint 404s an id its getStaticPaths does not list", async () => {
    const res = await fetch(BASE + "/items/zzz");
    expect(res.status).toBe(404);
  });
});
