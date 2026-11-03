/**
 * `pletivo prepare` and the Workers host together on Tailwind `@plugin` rules written as
 * paths: the host must ask the artifact before it judges the path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectArtifact, type ProjectArtifact } from "../src/artifact.ts";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

const CLI = path.resolve(import.meta.dir, "../../pletivo/src/cli.ts");
const compiler = createAstroCompiler(await astroWasmModule());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const KIT = {
  "node_modules/kit/package.json": JSON.stringify({ name: "kit", exports: { ".": { style: "./theme.css" }, "./plugin.js": "./plugin.js" } }),
  "node_modules/kit/theme.css": '@plugin "./plugin.js";\n',
  "node_modules/kit/plugin.js":
    'module.exports = function ({ addUtilities }) { addUtilities({ ".kit-box": { display: "grid" } }); };\n',
};
const PAGE = '---\nimport "../styles/global.css";\n---\n<html><body><h1 class="kit-box">hi</h1></body></html>\n';

/**
 * Prepare the project at `site` of a repository of `files` with the CLI, in its own
 * process as a host's preparer runs it. Tailwind is installed at the repository root.
 */
async function prepared(
  files: Readonly<Record<string, string>>,
  site: string,
): Promise<{ artifact: ProjectArtifact; sources: Map<string, string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-tailwind-prepared-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  const sourcePrefix = site === "" ? "src/" : `${site}/src/`;
  const sources = new Map<string, string>();
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
    if (file.startsWith(sourcePrefix)) sources.set(file.slice(sourcePrefix.length - "src/".length), source);
  }
  const tailwind = tailwindDir();
  if (tailwind === null) throw new Error("tailwindcss is not installed");
  await fs.symlink(tailwind, path.join(root, "node_modules/tailwindcss"));
  const child = Bun.spawn(["bun", CLI, "prepare", "--out", "out"], { cwd: path.join(root, site), stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`pletivo prepare failed:\n${stderr}`);
  const artifact: unknown = JSON.parse(await fs.readFile(path.join(root, site, "out/pletivo-artifact.json"), "utf8"));
  return { artifact: loadProjectArtifact(artifact), sources };
}

async function render(files: Readonly<Record<string, string>>, site = ""): Promise<string> {
  const { artifact, sources } = await prepared(files, site);
  const loader = new FileLoader();
  cleanups.push(() => loader.cleanup());
  const { html } = await renderPage({ files: sources, loader, compiler, artifact, tailwind: await tailwindStylesheets(), pathname: "/" });
  return html;
}

describe.skipIf(tailwindDir() === null)("Tailwind @plugin paths, prepared and rendered", () => {
  test("a package stylesheet's relative @plugin renders", async () => {
    const html = await render({
      ...KIT,
      "src/pages/index.astro": PAGE,
      "src/styles/global.css": '@import "tailwindcss";\n@import "kit";\n',
    });
    expect(html).toMatch(/\.kit-box\s*\{\s*display: grid;/);
  });

  test("a project stylesheet's @plugin path into node_modules renders", async () => {
    const html = await render({
      ...KIT,
      "src/pages/index.astro": PAGE,
      "src/styles/global.css": '@import "tailwindcss";\n@plugin "../../node_modules/kit/plugin.js";\n',
    });
    expect(html).toMatch(/\.kit-box\s*\{\s*display: grid;/);
  });

  test("a @plugin path into a monorepo's hoisted node_modules renders", async () => {
    const html = await render(
      {
        ...KIT,
        "apps/site/package.json": JSON.stringify({ name: "site" }),
        "apps/site/src/pages/index.astro": PAGE,
        "apps/site/src/styles/global.css": '@import "tailwindcss";\n@plugin "../../../../node_modules/kit/plugin.js";\n',
      },
      "apps/site",
    );
    expect(html).toMatch(/\.kit-box\s*\{\s*display: grid;/);
  });
});
