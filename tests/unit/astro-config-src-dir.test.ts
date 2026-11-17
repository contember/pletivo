import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { loadAstroConfig, srcDirMismatch } from "../../packages/pletivo/src/astro-host/config-loader";

const root = "/project";

describe("srcDirMismatch", () => {
  test("no error when astro.config sets no srcDir", () => {
    expect(srcDirMismatch(root, "app", undefined)).toBeNull();
  });

  test("spellings of the same directory match", () => {
    for (const [astro, pletivo] of [
      ["./src", "src"],
      ["src/", "src"],
      ["/project/app", "app"],
      ["app", "./app/"],
    ]) {
      expect(srcDirMismatch(root, pletivo!, astro)).toBeNull();
    }
  });

  test("a different directory quotes the astro.config value", () => {
    expect(srcDirMismatch(root, "src", "./app")).toBe(
      `astro.config sets srcDir "./app", but pletivo reads sources from "src". ` +
        `Set srcDir: "./app" in pletivo.config as well.`,
    );
  });
});

describe("loadAstroConfig directories", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function projectWith(config: string): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-astro-src-dir-")));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "astro.config.mjs"), config);
    return dir;
  }

  test("srcDir, publicDir and outDir end with a slash, as Astro resolves them", async () => {
    const dir = await projectWith(`export default { srcDir: "./app", publicDir: "static", outDir: "out" };\n`);
    const loaded = await loadAstroConfig(dir);
    expect(loaded?.configuredSrcDir).toBe("./app");
    expect(loaded?.config.srcDir.href).toBe(`file://${dir}/app/`);
    expect(new URL("pages/", loaded!.config.srcDir).href).toBe(`file://${dir}/app/pages/`);
    expect(loaded?.config.publicDir.href).toBe(`file://${dir}/static/`);
    expect(loaded?.config.outDir.href).toBe(`file://${dir}/out/`);
  });

  test("a srcDir that is not a string is rejected", async () => {
    const dir = await projectWith(`export default { srcDir: 42 };\n`);
    await expect(loadAstroConfig(dir)).rejects.toThrow("astro.config.mjs: srcDir must be a string");
  });
});
