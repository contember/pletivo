// A pletivo-native project's Astro.url stays the page path without the base; the base in a
// built page's URL is an Astro project's (getUrlForPath), see astro-url-base.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const root = path.join(import.meta.dir, "../fixture-native-url-base");
const config: PletivoConfig = { host: "localhost", outDir: "dist", port: 3000, base: "/docs", srcDir: "src", publicDir: "public" };

beforeAll(async () => {
  await build(root, config);
});

afterAll(async () => {
  await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
});

test("a native page's Astro.url has no base", async () => {
  const html = await Bun.file(path.join(root, "dist/about/index.html")).text();
  expect(html).toContain('<p id="url">/about/</p>');
});
