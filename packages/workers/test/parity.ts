/**
 * HTML parity between the two hosts, byte for byte. Not a `bun test` file — it needs
 * a real workerd, so it is driven by hand.
 *
 *   bunx wrangler@4 dev --config packages/workers/example/wrangler.jsonc --port 8799
 *   bun packages/workers/test/parity.ts tests/conformance/fixtures/css-cascade-order
 *
 * Route enumeration is compared too, and the build is its reference as well: the
 * pages `pletivo build` wrote are exactly the pages the project can enumerate.
 *
 * The left side is `pletivo build` on Bun, run in a child process because a build
 * registers process-global Bun plugins. The right side is the example worker, handed
 * the same sources as a file map. Nothing is normalized on either side: the whole
 * value of this script is the list of places the two disagree.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { withoutCdnCgi } from "../src/images.ts";
import { builtPathname } from "./built-pathname.ts";
import { imageUrls, readSources, sameBytes, SKIPPED } from "./sources.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

// ── Child mode: one `pletivo build`, into a directory outside the fixture ──

if (process.argv[2] === "--build") {
  const [, , , root, outDir, artifactPath, pathPrefix] = process.argv;
  // The config/integration phase, in the same child and before the build: it registers
  // the same Bun plugins the build needs, and a fixture that cannot be prepared should
  // say so before 200 pages are written.
  if (artifactPath) {
    const { prepare } = await import("../../pletivo/src/prepare/index.ts");
    await Bun.write(
      artifactPath,
      JSON.stringify(await prepare(root, { pathPrefix: pathPrefix ?? "" })),
    );
  }
  const { build } = await import("../../pletivo/src/build.ts");
  // The same config every integration test uses (`tests/conformance/corpus.ts`),
  // with the output redirected so nothing is written into the fixture.
  await build(root, {
    outDir: path.relative(root, outDir),
    port: 3000,
    host: "localhost",
    base: "/",
    srcDir: "src",
    publicDir: "public",
    // The Workers host has no other choice — an isolate cannot resize or re-encode —
    // so a reference built with sharp would be comparing two image services rather
    // than two hosts. Fixtures with no images are unaffected either way.
    image: { service: "cloudflare" },
  });
  process.exit(0);
}

// ── Parent ──

const fixture = process.argv[2];
if (!fixture) {
  console.error("usage: bun packages/workers/test/parity.ts <fixture-dir> [worker-url]");
  process.exit(2);
}
const workerUrl = process.argv[3] ?? "http://localhost:8799";
const root = path.resolve(REPO_ROOT, fixture);

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-parity-"));
/**
 * Where the child leaves the site artifact — the frozen `astro:config:setup`, the
 * vendored npm modules and the `node_modules` sources. Outside the fixture, because
 * it is a build product; keyed with `prefix`, for the reason below.
 */
const artifactPath = path.join(outDir, "..", `${path.basename(outDir)}-artifact.json`);
const prefix = path.relative(REPO_ROOT, root);
const child = Bun.spawn(["bun", import.meta.path, "--build", root, outDir, artifactPath, prefix], {
  // From the repo root, so the fixture's TSX resolves the same JSX runtime the
  // conformance harness gives it, and production so no dev-only path is taken.
  cwd: REPO_ROOT,
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0) {
  console.error(`pletivo build failed for ${fixture}`);
  process.exit(1);
}

/**
 * Both hosts must see the same `filename` for a component, because the Astro
 * compiler derives the `astro-{scope}` hash from it. The Bun host names a module by
 * its path relative to `process.cwd()`, and the build above runs from the repo root
 * — so the virtual file map is keyed the same way, and so is the artifact
 * (`prepare({ pathPrefix })`). In real use both sides sit at the project root and
 * this prefix is empty.
 */
const artifact: unknown = JSON.parse(await Bun.file(artifactPath).text());
const sources = await readSources(root);
const files = new Map([...sources.text].map(([rel, source]) => [`${prefix}/${rel}`, source]));
/** The fixture's binaries, base64 so they survive the JSON body. */
const assets = Object.fromEntries(
  [...sources.binary].map(([rel, bytes]) => [`${prefix}/${rel}`, Buffer.from(bytes).toString("base64")]),
);
const pagesDir = `${prefix}/src/pages`;
const bunPages = await readBuiltHtml(outDir);

let identical = 0;
const divergent: { page: string; detail: string }[] = [];
/** Every image URL the rendered pages linked to, so each can be fetched afterwards. */
const linkedImages = new Set<string>();

for (const [outputPath, expected] of bunPages) {
  const pathname = builtPathname(outputPath);
  const response = await fetch(`${workerUrl}/__render`, {
    method: "POST",
    body: JSON.stringify({ files: Object.fromEntries(files), assets, pathname, pagesDir, artifact }),
  });
  const actual = await response.text();
  if (!response.ok) {
    divergent.push({ page: outputPath, detail: `HTTP ${response.status}: ${firstLine(actual)}` });
    continue;
  }
  for (const url of imageUrls(actual)) linkedImages.add(url);
  if (actual === expected) {
    identical++;
    console.log(`  = ${outputPath}`);
    continue;
  }
  divergent.push({ page: outputPath, detail: firstDifference(expected, actual) });
}

// A URL that 404s is worse than no image, so every one a page linked to is fetched
// from the worker and compared with the file `pletivo build` wrote.
for (const url of [...linkedImages].sort()) {
  const response = await fetch(`${workerUrl}${url}`);
  if (!response.ok) {
    divergent.push({ page: url, detail: `    HTTP ${response.status} — the page links to it` });
    continue;
  }
  const served = new Uint8Array(await response.arrayBuffer());
  // A `/cdn-cgi/image/` URL names a transform of a file, and the file is what the
  // build wrote — the transform is the origin's to perform, and this host says so by
  // serving the original.
  const source = withoutCdnCgi(url).replace(/^\//, "");
  const built = await Bun.file(path.join(outDir, source)).bytes().catch(() => null);
  if (built === null) {
    divergent.push({ page: url, detail: "    the Bun host emitted no such file" });
  } else if (!sameBytes(served, built)) {
    divergent.push({ page: url, detail: `    ${served.length} B served, ${built.length} B built` });
  } else {
    console.log(`  = ${url} (${served.length} B)`);
  }
}

// Route enumeration, against the only reference it has: the pages `pletivo build`
// wrote *are* the pages the project can enumerate.
const listed = await fetch(`${workerUrl}/__paths`, {
  method: "POST",
  body: JSON.stringify({ files: Object.fromEntries(files), assets, pagesDir, artifact }),
});
const enumerated = listed.ok ? pathnamesOf(await listed.json()) : null;
if (enumerated === null) {
  divergent.push({ page: "__paths", detail: `    HTTP ${listed.status}: ${firstLine(await listed.text())}` });
} else {
  const built = new Set([...bunPages.keys()].map(builtPathname));
  const missing = [...built].filter((pathname) => !enumerated.has(pathname)).sort();
  const extra = [...enumerated].filter((pathname) => !built.has(pathname)).sort();
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  = ${enumerated.size} enumerated path(s)`);
  } else {
    divergent.push({
      page: "__paths",
      detail:
        (missing.length ? `    built but not listed: ${missing.join(", ")}\n` : "") +
        (extra.length ? `    listed but not built: ${extra.join(", ")}` : ""),
    });
  }
}

console.log(`\n${fixture}: ${identical}/${bunPages.size} byte-identical`);
for (const { page, detail } of divergent) console.log(`\n  ! ${page}\n${detail}`);
await fs.rm(outDir, { recursive: true, force: true });
await fs.rm(artifactPath, { force: true });
process.exit(divergent.length === 0 ? 0 : 1);

/** The pathnames out of a `/__paths` response, without trusting its shape. */
function pathnamesOf(body: unknown): Set<string> {
  if (!Array.isArray(body)) return new Set();
  const pathnames = new Set<string>();
  for (const entry of body) {
    const pathname: unknown = entry === null ? null : Reflect.get(Object(entry), "pathname");
    if (typeof pathname === "string") pathnames.add(pathname);
  }
  return pathnames;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Every HTML file `pletivo build` emitted, keyed by output path. */
async function readBuiltHtml(dir: string): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  for await (const rel of new Glob("**/*.html").scan({ cwd: dir })) {
    pages.set(rel, await Bun.file(path.join(dir, rel)).text());
  }
  return new Map([...pages].sort(([a], [b]) => a.localeCompare(b)));
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 200);
}

/** The first differing line, with both sides, so the cause is readable at a glance. */
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
