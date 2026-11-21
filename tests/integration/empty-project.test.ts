import { afterAll, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-empty-project-"));

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("a project without a source directory builds no pages, as Astro does", async () => {
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "empty", private: true }));
  await build(root, config);
  const written = await fs.readdir(path.join(root, "dist"));
  expect(written.filter((file) => file.endsWith(".html"))).toEqual([]);
});
