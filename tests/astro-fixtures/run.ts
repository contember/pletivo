#!/usr/bin/env bun
/**
 * Build a fixed subset of Astro's own test fixtures with Astro and with pletivo,
 * compare the output, and print one table row per fixture.
 *
 *   bun tests/astro-fixtures/run.ts --astro <checkout> [--work <dir>] [--pletivo <checkout>]
 *     [--only a,b] [--all] [--jobs n] [--rebuild-astro] [--compare-only]
 *     [--json <file>] [--markdown <file>]
 *
 * `--astro` points at an Astro checkout at `ASTRO_REF`; the fixtures are copied
 * from `packages/astro/test/fixtures` into the work dir and never touched in place.
 * Every fixture shares one install in the work dir (`INSTALL` in the manifest):
 * fixtures name their dependencies as `workspace:*`, so a per-fixture install
 * would resolve nothing. A local test package a fixture names (`@test/*`) is
 * copied next to it from the checkout's own install.
 *
 * Each fixture is built with its own `astro.config.*` only. Astro's tests often
 * pass more config inline (an adapter, `site`, `base`); the harness does not, so
 * both builders see the same project.
 *
 * `--all` builds every fixture not in `SKIPPED` instead of `SUBSET`: that is how
 * the subset was chosen, and how a new upstream fixture is classified.
 */

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBoolFlag, readFlag } from "../../packages/pletivo/src/cli-args";
import {
  astroCssCanonicalizer,
  escapeCell,
  readAstroRecord,
  runBuild,
  sourceKey,
  writeAstroRecord,
  type BuildResult,
} from "../astro-examples/build";
import { compareOutputs, type Comparison } from "../astro-examples/compare";
import { compareAssets, type AssetComparison } from "./assets";
import { ASTRO_REF, INSTALL, SKIPPED, SUBSET } from "./manifest";

const argv = process.argv;
const REPO_ROOT = path.resolve(readFlag(argv, ["--pletivo"]) ?? path.join(import.meta.dirname, "../.."));
const PLETIVO_CLI = path.join(REPO_ROOT, "packages/pletivo/src/cli.ts");

const checkoutFlag = readFlag(argv, ["--astro"]);
if (!checkoutFlag) {
  process.stderr.write("usage: bun tests/astro-fixtures/run.ts --astro <astro checkout> [...]\n");
  process.exit(2);
}
const checkout = path.resolve(checkoutFlag);
const fixturesDir = path.join(checkout, "packages/astro/test/fixtures");
const workRoot = path.resolve(readFlag(argv, ["--work"]) ?? path.join(os.tmpdir(), "pletivo-astro-fixtures"));
const only = readFlag(argv, ["--only"])?.split(",").filter(Boolean);
const all = readBoolFlag(argv, ["--all"]);
const jobs = Math.max(1, Number(readFlag(argv, ["--jobs"]) ?? "2"));
const rebuildAstro = readBoolFlag(argv, ["--rebuild-astro"]);
const compareOnly = readBoolFlag(argv, ["--compare-only"]);
const jsonOut = readFlag(argv, ["--json"]);
const markdownOut = readFlag(argv, ["--markdown"]);

/** A fixture is a small project; a build this long is hung. */
const BUILD_TIMEOUT_MS = 120_000;

type Verdict = "pass" | "fail" | "error";

interface FixtureResult {
  name: string;
  /** The harness itself failed (copy, compare); neither build is judged. */
  harnessError?: string;
  astro?: BuildResult;
  pletivo?: BuildResult;
  comparison?: Comparison;
  assets?: AssetComparison;
  /** pass: same routes, equal pages and assets; fail: both build, output differs; error: pletivo's build fails. */
  verdict?: Verdict;
}

function readVersion(): string {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(checkout, "packages/astro/package.json"), "utf8"));
  const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : undefined;
  if (typeof version !== "string") throw new Error(`${checkout}/packages/astro/package.json has no version`);
  return `astro@${version}`;
}

const INSTALL_MARKER = "node_modules/.pletivo-astro-fixtures-installed";

/** The shared install every fixture resolves its packages from, by walking up. */
async function prepareInstall(): Promise<string> {
  const manifest = `${JSON.stringify({ name: "pletivo-astro-fixtures", private: true, dependencies: INSTALL }, null, 2)}\n`;
  const marker = path.join(workRoot, INSTALL_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === manifest) return manifest;
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(path.join(workRoot, "package.json"), manifest);
  const install = await $`bun install`.cwd(workRoot).nothrow().quiet();
  if (install.exitCode !== 0) throw new Error(`bun install failed:\n${install.stderr.toString()}`);
  fs.writeFileSync(marker, manifest);
  return manifest;
}

function dependencyNames(pkgFile: string): string[] {
  if (!fs.existsSync(pkgFile)) return [];
  const pkg: unknown = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (typeof pkg !== "object" || pkg === null) return [];
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = field in pkg ? Reflect.get(pkg, field) : undefined;
    if (typeof deps === "object" && deps !== null) names.push(...Object.keys(deps));
  }
  return names;
}

const copyFilter = (src: string) => !/[\\/](node_modules|dist|\.astro)$/.test(src);

/** Copy the fixture, and the local `@test/*` packages it names from the checkout's install. */
function prepareFixture(name: string, fixtureDir: string): void {
  const source = path.join(fixturesDir, name);
  for (const entry of fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir) : []) {
    if (entry.startsWith("dist")) continue;
    fs.rmSync(path.join(fixtureDir, entry), { recursive: true, force: true });
  }
  fs.cpSync(source, fixtureDir, { recursive: true, filter: copyFilter });
  for (const dep of dependencyNames(path.join(source, "package.json"))) {
    if (!dep.startsWith("@test/")) continue;
    const linked = path.join(source, "node_modules", dep);
    if (!fs.existsSync(linked)) throw new Error(`${dep} is not installed in ${source}; run pnpm install in the checkout`);
    fs.cpSync(fs.realpathSync(linked), path.join(fixtureDir, "node_modules", dep), { recursive: true, filter: copyFilter });
  }
}

async function runFixture(name: string, installKey: string): Promise<FixtureResult> {
  const fixtureDir = path.join(workRoot, "fixtures", name);
  const astroOut = path.join(fixtureDir, "dist-astro");
  const pletivoOut = path.join(fixtureDir, "dist-pletivo");
  const normalized = path.join(fixtureDir, "dist-normalized");

  let astro: BuildResult | null;
  let pletivo: BuildResult;
  if (compareOnly) {
    if (!fs.existsSync(astroOut)) return { name, harnessError: "no Astro output to compare" };
    if (!fs.existsSync(pletivoOut)) return { name, astro: { ok: true, ms: 0 }, harnessError: "no pletivo output to compare" };
    astro = { ok: true, ms: 0 };
    pletivo = { ok: true, ms: 0 };
  } else {
    fs.mkdirSync(fixtureDir, { recursive: true });
    prepareFixture(name, fixtureDir);
    const recordFile = path.join(fixtureDir, "dist-astro.json");
    const key = sourceKey(fixtureDir, installKey);
    // A fixture's Astro build is deterministic given its files; a failure is reused too.
    astro = rebuildAstro ? null : readAstroRecord(recordFile, key, astroOut, true);
    if (astro === null) {
      astro = await runBuild([path.join(workRoot, "node_modules/.bin/astro"), "build"], fixtureDir, astroOut, BUILD_TIMEOUT_MS);
      writeAstroRecord(recordFile, { key, result: astro });
    }
    if (!astro.ok) return { name, astro };
    pletivo = await runBuild([process.execPath, PLETIVO_CLI, "build"], fixtureDir, pletivoOut, BUILD_TIMEOUT_MS);
    if (!pletivo.ok) return { name, astro, pletivo, verdict: "error" };
  }

  const comparison = await compareOutputs(astroOut, pletivoOut, await astroCssCanonicalizer(fixtureDir), normalized);
  const assets = compareAssets(astroOut, pletivoOut);
  const verdict: Verdict = comparison.match && assets.match ? "pass" : "fail";
  return { name, astro, pletivo, comparison, assets, verdict };
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split(REPO_ROOT).join("<repo>").split(workRoot).join("<work>")
    .split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function summary(result: FixtureResult): string {
  if (result.harnessError) return result.harnessError;
  if (result.astro && !result.astro.ok) return `astro: ${result.astro.error ?? ""}`;
  if (result.pletivo && !result.pletivo.ok) return result.pletivo.error ?? "";
  const parts = [result.comparison?.summary, result.assets?.summary].filter(Boolean);
  return parts.join("; ");
}

function row(result: FixtureResult): string {
  const c = result.comparison;
  const routes = c ? `${c.routes.common.length}/${c.routes.astro.length}${c.routes.extra.length ? ` +${c.routes.extra.length}` : ""}` : "";
  const pages = c ? `${c.matchingPages.length}/${c.routes.astroPages.length}` : "";
  const verdict = result.harnessError ? "harness error" : result.verdict ?? "astro fails";
  return `| ${result.name} | ${verdict === "pass" ? "**pass**" : verdict} | ${routes} | ${pages} | ${escapeCell(firstLine(summary(result)))} |`;
}

function renderTable(results: FixtureResult[], astroVersion: string): string {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const unjudged = results.filter((r) => r.verdict === undefined);
  return [
    `Astro ${astroVersion}, ${results.length} fixtures: **${count("pass")} pass**, ${count("fail")} fail, ${count("error")} error` +
      (unjudged.length > 0 ? `, ${unjudged.length} not judged (${unjudged.map((r) => r.name).join(", ")})` : "") +
      ".",
    "",
    "| fixture | verdict | routes (common/astro +extra) | pages equal | first difference |",
    "|---|---|---|---|---|",
    ...results.map(row),
  ].join("\n");
}

/** Fixtures in the checkout that the manifest does not classify, and manifest names the checkout lacks. */
function manifestDrift(available: string[]): string[] {
  const listed = new Set([...SUBSET, ...Object.keys(SKIPPED)]);
  const present = new Set(available);
  return [
    ...available.filter((n) => !listed.has(n)).map((n) => `unclassified fixture: ${n}`),
    ...[...listed].filter((n) => !present.has(n)).map((n) => `listed but not in the checkout: ${n}`),
    ...SUBSET.filter((n) => n in SKIPPED).map((n) => `both in SUBSET and SKIPPED: ${n}`),
  ];
}

const astroVersion = readVersion();
if (astroVersion !== ASTRO_REF) process.stderr.write(`warning: ${checkout} is at ${astroVersion}, the harness pins ${ASTRO_REF}\n`);
const available = fs
  .readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(fixturesDir, d.name, "package.json")))
  .map((d) => d.name)
  .sort();
for (const line of manifestDrift(available)) process.stderr.write(`warning: ${line}\n`);

const base = all ? available.filter((n) => !(n in SKIPPED)) : [...SUBSET].sort();
const names = base.filter((n) => !only || only.includes(n));

const started = performance.now();
const installKey = compareOnly ? "" : await prepareInstall();
const results: FixtureResult[] = new Array(names.length);
let next = 0;
async function worker(): Promise<void> {
  while (next < names.length) {
    const index = next++;
    const name = names[index];
    let result: FixtureResult;
    try {
      result = await runFixture(name, installKey);
    } catch (error) {
      result = { name, harnessError: error instanceof Error ? error.message : String(error) };
    }
    results[index] = result;
    const timing = [result.astro && `astro ${result.astro.ms} ms`, result.pletivo && `pletivo ${result.pletivo.ms} ms`].filter(Boolean).join(", ");
    process.stderr.write(`${name}: ${result.harnessError ? "harness error" : (result.verdict ?? "astro fails")} (${timing})\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));

const table = renderTable(results, astroVersion);
console.log(table);
process.stderr.write(`${names.length} fixtures in ${Math.round((performance.now() - started) / 1000)} s\n`);
if (markdownOut) fs.writeFileSync(markdownOut, `${table}\n`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
