/**
 * The same comparison `parity.ts` runs, with the Workers host on Bun instead of in
 * workerd — `FileLoader` in place of `env.LOADER`. Not a substitute for `parity.ts`:
 * it cannot see anything workerd does differently. It is the fast loop for the parts
 * that are pure host-side string work, above all the page's CSS.
 *
 *   bun packages/workers/test/local-parity.ts tests/fixture-astro-hoisted-imports
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { parsePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
import { minifyCss } from "../../pletivo/src/css-minify.ts";
import { serveImage } from "../src/images.ts";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { ContentFiles, createProjectAssetsView } from "../src/content-files.ts";
import { tailwindEntry } from "../src/project-css.ts";
import { compileTailwind, extractCandidates, scanCandidates } from "../src/tailwind.ts";
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
/** The child writes the prepare result here — see `parity.ts` for why it is prefixed. */
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
const assetView = createProjectAssetsView(assets);

const preparedOutput: unknown = JSON.parse(await Bun.file(artifactPath).text());
const artifact = prefixProjectImporters(
  parsePreparedSite(siteFromPrepareOutput(preparedOutput)),
  prefix,
);

function siteFromPrepareOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !Reflect.has(value, "site")) {
    return value;
  }
  return Reflect.get(value, "site");
}

/** Match the harness's repo-relative file-map namespace without changing producer IDs. */
function prefixProjectImporters(site: PreparedSite, projectPrefix: string): PreparedSite {
  if (projectPrefix === "") return site;
  return {
    artifact: {
      ...site.artifact,
      resolutions: site.artifact.resolutions.map((resolution) => ({
        ...resolution,
        importer: resolution.importer.startsWith("project:")
          ? `project:${path.posix.join(projectPrefix, resolution.importer.slice("project:".length))}`
          : resolution.importer,
      })),
    },
  };
}

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
const executionNamespace = { tenant: "local-parity", capabilityGeneration: "content-v1" };
// On Bun the "binding" and the store are the same object — there is no RPC hop to
// cross. In workerd they are two halves; see `example/src/index.ts`.
const contentFiles = new ContentFiles();
const content = { binding: contentFiles, store: contentFiles };
const srcDir = `${prefix}/src`;
const pagesDir = `${srcDir}/pages`;
let identical = 0;
let pages = 0;
/** Pages whose CSS delivery was excepted from the byte comparison — see below. */
let excepted = 0;
const problems: string[] = [];
const builtPathnames = new Set<string>();
/** Every image URL the rendered pages linked to, checked against dist afterwards. */
const linkedImages = new Set<string>();

/**
 * The proof that inlining took away, re-made one level down.
 *
 * `fixture-tailwind` used to be the only assertion anywhere that this host's JS
 * candidate scanner plus Tailwind-over-a-virtual-file-map produces the **same bytes**
 * as the real `@tailwindcss/node` + `@tailwindcss/oxide` (`docs/todos/016 §7`), and it
 * made it by comparing the linked stylesheet file. This host inlines now
 * (`docs/todos/023 §5`) so there is no file — but the claim was always about the
 * engine, not the delivery. Same entry, same candidates in, same bytes out.
 *
 * What it no longer covers: that the *page* gets those bytes. That is what the two
 * per-page checks below are for.
 */
const entry = tailwindEntry({ files, srcDir });
const projectWide =
  entry === null
    ? null
    : await compileTailwind({
        entry,
        files,
        stylesheets: await tailwindStylesheets(),
        candidates: scanCandidates(files),
      });
if (projectWide !== null) {
  // The Bun host minifies the finished stylesheet before writing it. Run the same
  // final transform here so this remains a Tailwind parity check, not a whitespace
  // comparison against the pre-minification output.
  const builtProjectWide = (await minifyCss(projectWide.css)).trimEnd();
  const built: string[] = [];
  for await (const rel of new Glob("assets/*.css").scan({ cwd: outDir })) {
    built.push(await Bun.file(path.join(outDir, rel)).text());
  }
  // A prefix, not the whole file: the Bun host appends the imported source CSS after
  // the compiled Tailwind, and that half was never the thing in question.
  if (built.some((css) => css.startsWith(builtProjectWide))) {
    console.log(`  = ${projectWide.css.length} B of Tailwind, byte-identical to pletivo build`);
  } else {
    problems.push(
      `  ! tailwind — ${projectWide.css.length} B compiled here match no stylesheet the build wrote` +
        (built.length === 0 ? " (it wrote none)" : `\n${firstDifference(built[0], builtProjectWide)}`),
    );
  }
}

/** The `<link>` cluster the Bun host injects, and the `<style>` this host injects in its place. */
const LINKED_STYLESHEETS = /(?:<link rel="stylesheet" href="[^"]+\.css">\n?)+/;
const INLINED_STYLESHEET = /<style>([\s\S]*?)<\/style>\n?/;

/** Every class name the markup applies. */
function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) tokens.add(token);
  }
  return tokens;
}

/**
 * Whether a stylesheet carries the rule for one utility class.
 *
 * Tailwind escapes a selector the way `CSS.escape` does, and the trailing boundary is
 * load bearing: without it `.mt-4` is found inside `.mt-40`.
 */
function hasUtility(css: string, token: string): boolean {
  const selector = `.${token.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`)}`;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9_-])`).test(css);
}

for await (const rel of new Glob("**/*.html").scan({ cwd: outDir })) {
  pages++;
  const pathname = builtPathname(rel);
  builtPathnames.add(pathname);
  const expected = await Bun.file(path.join(outDir, rel)).text();
  let page;
  try {
    page = await renderPage({
      files,
      assets: assetView,
      pathname,
      loader,
      compiler,
      pagesDir,
      content,
      artifact,
      executionNamespace,
      tailwind: await tailwindStylesheets(),
    });
  } catch (error) {
    problems.push(`  ! ${rel}\n    ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  // The one divergence the two hosts keep on purpose: the Bun host links the project
  // stylesheets, this one inlines the page's own. Exactly one cluster is removed from
  // each side — the adjacent `<link>` tags there, the leading `<style>` here — so every
  // other byte of the page, the scoped `<style>` included, is still compared. Not a
  // normalizer: it fires only where the build actually linked a sheet, and a missing
  // counterpart is a reported difference rather than a silent pass.
  let expectedHtml = expected;
  let actualHtml = page.html;
  let inlined: string | null = null;
  if (LINKED_STYLESHEETS.test(expected)) {
    const match = INLINED_STYLESHEET.exec(page.html);
    if (match === null) {
      problems.push(`  ! ${rel} — pletivo build linked a stylesheet and this host inlined none`);
      continue;
    }
    inlined = match[1];
    expectedHtml = expected.replace(LINKED_STYLESHEETS, "");
    actualHtml = page.html.replace(INLINED_STYLESHEET, "");
    excepted++;
  }

  if (actualHtml === expectedHtml) {
    identical++;
    console.log(`  = ${rel}${inlined === null ? "" : " (CSS delivery excepted)"}`);
  } else {
    problems.push(`  ! ${rel}\n${firstDifference(expectedHtml, actualHtml)}`);
  }

  // What the per-page model needs to hold, on the page that just made it. The markup
  // without the injected `<style>` blocks is what the candidate scan actually saw —
  // they are added after the render, which is why the CSS text in them cannot feed
  // back in as candidates.
  const markup = page.html.replace(/<style>[\s\S]*?<\/style>\n?/g, "");
  const applied = classTokens(markup);
  const scanned = new Set(extractCandidates(markup));
  const unseen = [...applied].filter((token) => !scanned.has(token)).sort();
  if (unseen.length > 0) {
    problems.push(`  ! ${rel} — the scanner missed ${unseen.length} applied class(es): ${unseen.join(", ")}`);
  }
  const sheet = inlined;
  if (sheet !== null && projectWide !== null) {
    // Every utility the page applies has to survive the narrowing. This is the claim
    // the old byte comparison used to carry for free.
    const dropped = [...applied]
      .filter((token) => hasUtility(projectWide.css, token) && !hasUtility(sheet, token))
      .sort();
    if (dropped.length > 0) {
      problems.push(`  ! ${rel} — ${dropped.length} utility class(es) missing from the inlined CSS: ${dropped.join(", ")}`);
    } else if (applied.size > 0) {
      console.log(`  = ${rel} — ${applied.size} applied class(es) covered by ${sheet.length} B inline`);
    }
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
  const served = await serveImage(url, assetView);
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
  (await projectPaths({
    files,
    assets: assetView,
    loader,
    compiler,
    pagesDir,
    content,
    artifact,
    executionNamespace,
  })).map(
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
console.log(
  `\n${fixture}: ${identical}/${pages} byte-identical` +
    (excepted === 0 ? "" : ` (${excepted} with the CSS delivery excepted — docs/todos/023 §5)`),
);
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
