/**
 * HTML parity between the two hosts, byte for byte. Not a `bun test` file — it needs
 * a real workerd, so it is driven by hand.
 *
 *   bunx wrangler@4 dev --config packages/workers/example/wrangler.jsonc --port 8799
 *   bun packages/workers/test/parity.ts tests/conformance/fixtures/css-cascade-order
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

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** Directories that hold build products or dependencies, not sources. */
const SKIPPED = new Set(["node_modules", "dist", "tmp", ".astro", ".wrangler"]);

// ── Child mode: one `pletivo build`, into a directory outside the fixture ──

if (process.argv[2] === "--build") {
  const [, , , root, outDir] = process.argv;
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
const child = Bun.spawn(["bun", import.meta.path, "--build", root, outDir], {
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
 * — so the virtual file map is keyed the same way. In real use both sides sit at the
 * project root and this prefix is empty.
 */
const prefix = path.relative(REPO_ROOT, root);
const files = new Map(
  [...(await readSources(root))].map(([rel, source]) => [`${prefix}/${rel}`, source]),
);
const pagesDir = `${prefix}/src/pages`;
const bunPages = await readBuiltHtml(outDir);

let identical = 0;
const divergent: { page: string; detail: string }[] = [];

for (const [outputPath, expected] of bunPages) {
  const pathname = "/" + outputPath.replace(/(^|\/)index\.html$/, "");
  const response = await fetch(`${workerUrl}/__render`, {
    method: "POST",
    body: JSON.stringify({ files: Object.fromEntries(files), pathname, pagesDir }),
  });
  const actual = await response.text();
  if (!response.ok) {
    divergent.push({ page: outputPath, detail: `HTTP ${response.status}: ${firstLine(actual)}` });
    continue;
  }
  if (actual === expected) {
    identical++;
    console.log(`  = ${outputPath}`);
    continue;
  }
  divergent.push({ page: outputPath, detail: firstDifference(expected, actual) });
}

console.log(`\n${fixture}: ${identical}/${bunPages.size} byte-identical`);
for (const { page, detail } of divergent) console.log(`\n  ! ${page}\n${detail}`);
await fs.rm(outDir, { recursive: true, force: true });
process.exit(divergent.length === 0 ? 0 : 1);

// ── Helpers ─────────────────────────────────────────────────────────

/** The fixture's sources, keyed the way the Workers host keys a virtual file map. */
async function readSources(dir: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const rel of new Glob("**/*").scan({ cwd: dir, dot: false })) {
    if (rel.split("/").some((segment) => SKIPPED.has(segment))) continue;
    sources.set(rel, await Bun.file(path.join(dir, rel)).text());
  }
  return sources;
}

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
