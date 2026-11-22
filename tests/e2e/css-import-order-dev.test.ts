import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

// `pletivo dev` serves source CSS in the page's import order, as `pletivo build` does.
// The page imports z.css, then a component that imports a.css: path order would be a, z.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-css-import-order");

let server: DevServer | undefined;
let BASE: string;

beforeAll(async () => {
  server = await startDevServer({ cwd: fixtureRoot, args: ["--no-restart"] });
  BASE = server.url;
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

test("dev serves source CSS in import order once the page rendered", async () => {
  expect((await fetch(`${BASE}/`)).status).toBe(200);
  const css = await (await fetch(`${BASE}/__styles.css`)).text();
  const z = css.indexOf("/* styles/z.css */");
  const a = css.indexOf("/* styles/a.css */");
  expect(z).toBeGreaterThanOrEqual(0);
  expect(a).toBeGreaterThan(z);
});
