/**
 * The same comparison `parity.ts` runs, with the Workers host on Bun instead of in
 * workerd — `FileLoader` in place of `env.LOADER`. Not a substitute for `parity.ts`:
 * it cannot see anything workerd does differently. It is the fast loop for the parts
 * that are pure host-side string work, above all the project stylesheet.
 *
 *   bun packages/workers/test/local-parity.ts tests/fixture-astro-hoisted-imports
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";
import { tailwindStylesheets } from "./tailwind-sources.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SKIPPED = new Set(["node_modules", "dist", "tmp", ".astro", ".wrangler"]);

const fixture = process.argv[2];
if (!fixture) {
  console.error("usage: bun packages/workers/test/local-parity.ts <fixture-dir>");
  process.exit(2);
}
const root = path.resolve(REPO_ROOT, fixture);
const prefix = path.relative(REPO_ROOT, root);

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-local-parity-"));
const build = Bun.spawn(["bun", path.join(import.meta.dir, "parity.ts"), "--build", root, outDir], {
  cwd: REPO_ROOT,
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) {
  console.error(`pletivo build failed for ${fixture}`);
  process.exit(1);
}

const files = new Map<string, string>();
for await (const rel of new Glob("**/*").scan({ cwd: root, dot: false })) {
  if (rel.split("/").some((segment) => SKIPPED.has(segment))) continue;
  files.set(`${prefix}/${rel}`, await Bun.file(path.join(root, rel)).text());
}

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
let identical = 0;
let pages = 0;
const problems: string[] = [];

for await (const rel of new Glob("**/*.html").scan({ cwd: outDir })) {
  pages++;
  const pathname = "/" + rel.replace(/(^|\/)index\.html$/, "");
  const expected = await Bun.file(path.join(outDir, rel)).text();
  let page;
  try {
    page = await renderPage({
      files,
      pathname,
      loader,
      compiler,
      pagesDir: `${prefix}/src/pages`,
      tailwind: await tailwindStylesheets(),
    });
  } catch (error) {
    problems.push(`  ! ${rel}\n    ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (page.html === expected) {
    identical++;
    console.log(`  = ${rel}`);
  } else {
    problems.push(`  ! ${rel}\n${firstDifference(expected, page.html)}`);
  }

  for (const asset of page.assets) {
    const built = path.join(outDir, asset.path.replace(/^\//, ""));
    const expectedAsset = await Bun.file(built).text().catch(() => null);
    if (expectedAsset === null) {
      problems.push(`  ! ${asset.path} — the Bun host emitted no such asset`);
    } else if (expectedAsset !== asset.body) {
      problems.push(`  ! ${asset.path}\n${firstDifference(expectedAsset, asset.body)}`);
    } else {
      console.log(`  = ${asset.path}`);
    }
  }
}

await loader.cleanup();
console.log(`\n${fixture}: ${identical}/${pages} byte-identical`);
for (const problem of problems) console.log(`\n${problem}`);
await fs.rm(outDir, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);

function firstDifference(expected: string, actual: string): string {
  const left = expected.split("\n");
  const right = actual.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    return (
      `    line ${i + 1}\n` +
      `      bun:    ${JSON.stringify(left[i] ?? null)}\n` +
      `      worker: ${JSON.stringify(right[i] ?? null)}`
    );
  }
  return "    identical by line, different bytes";
}
