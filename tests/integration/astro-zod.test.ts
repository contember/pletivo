import { describe, test, expect, afterAll } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";

const fixture = path.join(import.meta.dir, "../fixture-astro-zod");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const temporaryDirs: string[] = [];

/**
 * Build a copy of the fixture in its own process: `astro/zod` is resolved once per
 * process. `astroZod` is the Zod module the project's (stand-in) Astro ships as
 * `astro/zod`; null means astro is not installed.
 */
async function buildWith(astroZod: string | null): Promise<string> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-astro-zod-"));
  temporaryDirs.push(project);
  await fs.cp(fixture, project, { recursive: true });
  if (astroZod) {
    const astroDir = path.join(project, "node_modules/astro");
    await fs.mkdir(astroDir, { recursive: true });
    await fs.writeFile(
      path.join(astroDir, "package.json"),
      JSON.stringify({ name: "astro", type: "module", exports: { "./zod": "./zod.js" } }),
    );
    await fs.writeFile(
      path.join(astroDir, "zod.js"),
      `export * from ${JSON.stringify(astroZod)};\n` +
        `export { z, default } from ${JSON.stringify(astroZod)};\n` +
        `export const projectZodMarker = true;\n`,
    );
  }
  const child = Bun.spawn(["bun", cli, "build"], { cwd: project, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit: await child.exited, output: stdout + stderr }).toMatchObject({ exit: 0 });
  return Bun.file(path.join(project, "dist/index.html")).text();
}

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("astro/zod and astro:content's z come from the project's Astro", () => {
  test("Astro 5 (Zod 3): z, image() and reference() are Zod 3 and a schema mixing them validates", async () => {
    const html = await buildWith(Bun.resolveSync("zod/v3", import.meta.dir));
    expect(html).toContain("astro:content 3, astro/zod 3, same true, project true");
    // The API `@astrojs/rss` failed on.
    expect(html).toContain("returns function");
    expect(html).toContain("default true");
    expect(html).toContain("Hello by Jane, cover 4x4");
  }, 60_000);

  test("Astro 6 (Zod 4): stays on Zod 4, from the project's Astro", async () => {
    const html = await buildWith(Bun.resolveSync("zod", import.meta.dir));
    expect(html).toContain("astro:content 4, astro/zod 4, same true, project true");
    expect(html).toContain("default true");
    expect(html).toContain("Hello by Jane, cover 4x4");
  }, 60_000);

  test("without astro installed: pletivo's own Zod", async () => {
    const html = await buildWith(null);
    expect(html).toContain("astro:content 4, astro/zod 4, same true, project false");
    expect(html).toContain("default true");
    expect(html).toContain("Hello by Jane, cover 4x4");
  }, 60_000);
});
