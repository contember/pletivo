// `Astro.url` in an Astro project built under a base, as Astro's `getUrlForPath` and
// `findRouteToRewrite` build it; mirrors Astro's `rewrite-with-base` fixture.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const root = path.join(import.meta.dir, "../fixture-astro-url-base");
const config: PletivoConfig = { host: "localhost", outDir: "dist", port: 3000, base: "/", srcDir: "src", publicDir: "public" };

beforeAll(async () => {
  await build(root, config);
});

afterAll(async () => {
  await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
});

const pathname = async (page: string) => (await Bun.file(path.join(root, "dist", page)).text()).match(/<p>(.*)<\/p>/)?.[1];

test("a page's URL is under the base; the root page's is the base as configured", async () => {
  expect(await pathname("index.html")).toBe("/base");
  expect(await pathname("page/index.html")).toBe("/base/page/");
});

test("a rewrite target under the base routes without it, and its URL is joined to the base", async () => {
  expect(await pathname("to-based-page/index.html")).toBe("/base/page/");
  expect(await pathname("to-index/index.html")).toBe("/base/");
});
