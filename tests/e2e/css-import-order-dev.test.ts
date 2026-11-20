import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "path";

// `pletivo dev` serves source CSS in the page's import order, as `pletivo build` does.
// The page imports z.css, then a component that imports a.css: path order would be a, z.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-css-import-order");
const PORT = 7900 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  server = Bun.spawn(
    ["bun", path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts"), "dev", String(PORT), "--no-restart"],
    { cwd: fixtureRoot, stdout: "pipe", stderr: "pipe" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/__hmr_ping`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("Dev server did not start in time");
}, 30_000);

afterAll(async () => {
  server.kill();
  await server.exited;
});

test("dev serves source CSS in import order once the page rendered", async () => {
  expect((await fetch(`${BASE}/`)).status).toBe(200);
  const css = await (await fetch(`${BASE}/__styles.css`)).text();
  const z = css.indexOf("/* styles/z.css */");
  const a = css.indexOf("/* styles/a.css */");
  expect(z).toBeGreaterThanOrEqual(0);
  expect(a).toBeGreaterThan(z);
});
