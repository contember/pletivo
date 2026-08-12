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
import { parsePreparedSite } from "@pletivo/core/artifact";
import { serveImage } from "../src/images.ts";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { ContentFiles } from "../src/content-files.ts";
import { projectPaths, renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { builtPathname } from "./built-pathname.ts";
import { FileLoader } from "./file-loader.ts";
import { imageUrls, readSources, sameBytes } from "./sources.ts";
import { tailwindStylesheets } from "./tailwind-sources.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const fixture = process.argv[2];
if (!fixture) {
  console.error("usage: bun packages/workers/test/local-parity.ts <fixture-dir>");
  process.exit(2);
}
const root = path.resolve(REPO_ROOT, fixture);
const prefix = path.relative(REPO_ROOT, root);

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-local-parity-"));
/** The child writes the site artifact here — see `parity.ts` for why it is prefixed. */
const artifactPath = path.join(outDir, "..", `${path.basename(outDir)}-artifact.json`);
const build = Bun.spawn(
  ["bun", path.join(import.meta.dir, "parity.ts"), "--build", root, outDir, artifactPath, prefix],
  {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await build.exited) !== 0) {
  console.error(`pletivo build failed for ${fixture}`);
  process.exit(1);
}

const sources = await readSources(root);
const files = new Map([...sources.text].map(([rel, text]) => [`${prefix}/${rel}`, text]));
const assets = new Map([...sources.binary].map(([rel, bytes]) => [`${prefix}/${rel}`, bytes]));

const artifact = parsePreparedSite(JSON.parse(await Bun.file(artifactPath).text()));
if (artifact === null) {
  console.error(`prepare produced an artifact this host cannot read for ${fixture}`);
  process.exit(1);
}

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
// On Bun the "binding" and the store are the same object — there is no RPC hop to
// cross. In workerd they are two halves; see `example/src/index.ts`.
const contentFiles = new ContentFiles();
const content = { binding: contentFiles, store: contentFiles };
const pagesDir = `${prefix}/src/pages`;
let identical = 0;
let pages = 0;
const problems: string[] = [];
const builtPathnames = new Set<string>();
/** Every image URL the rendered pages linked to, checked against dist afterwards. */
const linkedImages = new Set<string>();

for await (const rel of new Glob("**/*.html").scan({ cwd: outDir })) {
  pages++;
  const pathname = builtPathname(rel);
  builtPathnames.add(pathname);
  const expected = await Bun.file(path.join(outDir, rel)).text();
  let page;
  try {
    page = await renderPage({
      files,
      assets,
      pathname,
      loader,
      compiler,
      pagesDir,
      content,
      artifact,
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

  for (const url of imageUrls(page.html)) linkedImages.add(url);

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

// A URL that 404s is worse than no image, so every one a page linked to is resolved
// back to bytes and compared with the file `pletivo build` wrote. A `/cdn-cgi/image/`
// URL names a transform of a file; the file is what the build wrote, and serving the
// original is this host saying it cannot perform the transform itself.
for (const url of [...linkedImages].sort()) {
  const served = serveImage(url, assets);
  if (!served?.bytes) {
    problems.push(`  ! ${url} — a page links to it and this host serves nothing`);
    continue;
  }
  const built = await Bun.file(path.join(outDir, served.path.replace(/^\//, ""))).bytes().catch(() => null);
  if (built === null) {
    problems.push(`  ! ${url} — the Bun host emitted no such file`);
  } else if (!sameBytes(served.bytes, built)) {
    problems.push(`  ! ${url} — ${served.bytes.length} B served, ${built.length} B built`);
  } else {
    console.log(`  = ${url} (${served.bytes.length} B)`);
  }
}

// The other half of the dynamic-route API, against the only reference it has: the
// pages `pletivo build` wrote *are* the pages the project can enumerate.
const enumerated = new Set(
  (await projectPaths({ files, assets, loader, compiler, pagesDir, content, artifact })).map(
    (path) => path.pathname,
  ),
);
const missing = [...builtPathnames].filter((pathname) => !enumerated.has(pathname)).sort();
const extra = [...enumerated].filter((pathname) => !builtPathnames.has(pathname)).sort();
if (missing.length === 0 && extra.length === 0) {
  console.log(`  = ${enumerated.size} enumerated path(s)`);
} else {
  problems.push(
    `  ! projectPaths\n` +
      (missing.length ? `    built but not listed: ${missing.join(", ")}\n` : "") +
      (extra.length ? `    listed but not built: ${extra.join(", ")}` : ""),
  );
}

await loader.cleanup();
console.log(`\n${fixture}: ${identical}/${pages} byte-identical`);
for (const problem of problems) console.log(`\n${problem}`);
await fs.rm(outDir, { recursive: true, force: true });
await fs.rm(artifactPath, { force: true });
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
