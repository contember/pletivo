#!/usr/bin/env bun
/**
 * Build Astro's official examples with Astro and with pletivo, compare the
 * output, and print one table row per example.
 *
 *   bun tests/astro-examples/run.ts [--astro <checkout>] [--work <dir>]
 *     [--pletivo <checkout>] [--only a,b] [--rebuild-astro] [--compare-only]
 *     [--json <file>] [--markdown <file>]
 *
 * `--astro` points at an Astro checkout to copy the examples from; without it
 * the examples are cloned at `ASTRO_REF`. Each example is copied to the work
 * dir (outside the repo by default, so a missing dependency cannot resolve from
 * pletivo's own node_modules), its dependencies are pinned to the exact
 * versions it names and installed, then it is built twice. Astro's output only
 * depends on the example's files, so it is reused while they are unchanged, unless
 * `--rebuild-astro`.
 */

import { $ } from "bun";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlag, readBoolFlag } from "../../packages/pletivo/src/cli-args";
import { createRequire } from "node:module";
import { compareOutputs, type Comparison, type CssCanonicalizer } from "./compare";
import { ASTRO_REF, ASTRO_REPO, SKIPPED } from "./manifest";

const argv = process.argv;
/** `--pletivo <checkout>` builds with another pletivo checkout, e.g. a branch's worktree. */
const REPO_ROOT = path.resolve(readFlag(argv, ["--pletivo"]) ?? path.join(import.meta.dirname, "../.."));
const PLETIVO_CLI = path.join(REPO_ROOT, "packages/pletivo/src/cli.ts");

const workRoot = path.resolve(
  readFlag(argv, ["--work"]) ?? path.join(os.tmpdir(), "pletivo-astro-examples"),
);
const only = readFlag(argv, ["--only"])?.split(",").filter(Boolean);
const rebuildAstro = readBoolFlag(argv, ["--rebuild-astro"]);
/** Re-run only the comparison on the outputs of the previous run. */
const compareOnly = readBoolFlag(argv, ["--compare-only"]);
const jsonOut = readFlag(argv, ["--json"]);
const markdownOut = readFlag(argv, ["--markdown"]);

/** A build gets this long before it is killed and counted as failed. */
const BUILD_TIMEOUT_MS = 10 * 60_000;

interface BuildResult {
  ok: boolean;
  ms: number;
  /** The error line and the last lines of the build's output, when it failed. */
  error?: string;
}

interface ExampleResult {
  name: string;
  skipped?: string;
  /** The harness itself failed (install, copy, compare); neither build is judged. */
  harnessError?: string;
  astro?: BuildResult;
  /** Absent under `--compare-only` when there is no pletivo output to compare. */
  pletivo?: BuildResult;
  comparison?: Comparison;
}

interface ExamplesSource {
  dir: string;
  /** The `astro` version the checkout is at. */
  astroVersion: string;
}

async function resolveExamples(): Promise<ExamplesSource> {
  const checkout = readFlag(argv, ["--astro"]);
  if (checkout) {
    const root = path.resolve(checkout);
    const astroPackage: unknown = JSON.parse(fs.readFileSync(path.join(root, "packages/astro/package.json"), "utf8"));
    const version = typeof astroPackage === "object" && astroPackage !== null ? Reflect.get(astroPackage, "version") : undefined;
    if (typeof version !== "string") throw new Error(`${root}/packages/astro/package.json has no version`);
    if (`astro@${version}` !== ASTRO_REF) {
      process.stderr.write(`warning: ${root} is at astro@${version}, the harness pins ${ASTRO_REF}\n`);
    }
    return { dir: path.join(root, "examples"), astroVersion: `astro@${version}` };
  }

  const cloneDir = path.join(workRoot, ".astro", ASTRO_REF);
  if (!fs.existsSync(path.join(cloneDir, "examples"))) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    await $`git clone --quiet --depth 1 --branch ${ASTRO_REF} --filter=blob:none --sparse ${ASTRO_REPO} ${cloneDir}`;
    await $`git -C ${cloneDir} sparse-checkout set examples`.quiet();
  }
  return { dir: path.join(cloneDir, "examples"), astroVersion: ASTRO_REF };
}

/** `^5.16.11` → `5.16.11`: the examples were released against these exact versions. */
function pinDependencies(pkg: Record<string, unknown>): Record<string, unknown> {
  const pinned = { ...pkg };
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    pinned[field] = Object.fromEntries(
      Object.entries(deps).map(([name, range]) => [name, typeof range === "string" ? range.replace(/^[\^~]/, "") : range]),
    );
  }
  return pinned;
}

/** Files of the example as copied, skipping what a build or install writes. */
function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (rel === "" && (entry.name === "node_modules" || entry.name.startsWith("dist") || entry.name === "normalized" || entry.name === ".astro")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(dir, child));
    else out.push(child);
  }
  return out.sort();
}

/** Identifies what Astro's build of the example depends on: every source file, the pinned manifest included. */
function sourceKey(exampleDir: string): string {
  const hash = createHash("sha256");
  for (const file of sourceFiles(exampleDir)) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(exampleDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const INSTALL_MARKER = "node_modules/.pletivo-astro-examples-installed";

/** Copy the example and install it; reinstall only when its manifest changed or an install did not finish. */
async function prepareExample(sourceDir: string, exampleDir: string): Promise<void> {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new Error(`${sourceDir}/package.json is not an object`);
  const manifest = `${JSON.stringify(pinDependencies(Object.fromEntries(Object.entries(pkg))), null, 2)}\n`;
  const marker = path.join(exampleDir, INSTALL_MARKER);
  const installed = fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === manifest;

  for (const entry of fs.readdirSync(exampleDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("dist")) continue;
    fs.rmSync(path.join(exampleDir, entry.name), { recursive: true, force: true });
  }
  fs.cpSync(sourceDir, exampleDir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.astro)$/.test(src),
  });
  fs.writeFileSync(path.join(exampleDir, "package.json"), manifest);

  if (!installed) {
    const install = await $`bun install`.cwd(exampleDir).nothrow().quiet();
    if (install.exitCode !== 0) {
      throw new Error(`bun install failed:\n${install.stderr.toString()}`);
    }
    fs.writeFileSync(marker, manifest);
  }
}

/**
 * Astro minifies CSS with Vite's esbuild; the example's own copy is the canonical
 * spelling both sides are compared in, so Astro's output is a fixed point.
 */
async function exampleCssCanonicalizer(exampleDir: string): Promise<CssCanonicalizer> {
  const esbuildPath = createRequire(path.join(exampleDir, "package.json")).resolve("esbuild");
  const esbuild: unknown = await import(esbuildPath);
  const transform = typeof esbuild === "object" && esbuild !== null ? Reflect.get(esbuild, "transform") : undefined;
  if (typeof transform !== "function") throw new Error(`${esbuildPath} exports no transform()`);
  return async (css) => {
    const result: unknown = await Reflect.apply(transform, esbuild, [css, { loader: "css", minify: true }]);
    const code = typeof result === "object" && result !== null ? Reflect.get(result, "code") : undefined;
    if (typeof code !== "string") throw new Error("esbuild transform() returned no code");
    return code.trimEnd();
  };
}

/** Astro's cached result, valid only for the sources it was built from and while its output exists. */
interface AstroRecord {
  key: string;
  result: BuildResult;
}

function readAstroRecord(file: string, key: string, outDir: string): BuildResult | null {
  if (!fs.existsSync(file)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const result: unknown = Reflect.get(parsed, "result");
  if (Reflect.get(parsed, "key") !== key || typeof result !== "object" || result === null) return null;
  const ok = Reflect.get(result, "ok");
  const ms = Reflect.get(result, "ms");
  const error = Reflect.get(result, "error");
  if (typeof ok !== "boolean" || typeof ms !== "number") return null;
  if (ok && !fs.existsSync(outDir)) return null;
  return typeof error === "string" ? { ok, ms, error } : { ok, ms };
}

/** The first line that names an error, then the last lines of the output. */
function errorExcerpt(text: string, lines = 12): string {
  const all = text.trimEnd().split("\n");
  // The message line, not Bun's echo of the throwing source line (`57 | throw new Error(…)`).
  const first = all.find((l) => /^\s*(\w*Error\b|error:|✗)/.test(l)) ?? all.find((l) => /\b\w*Error\b/.test(l));
  return [first, ...all.slice(-lines)].filter((l) => l !== undefined).join("\n");
}

/** Run a build that writes `dist/`, then move it to `outDir`. */
async function runBuild(cmd: string[], exampleDir: string, outDir: string): Promise<BuildResult> {
  fs.rmSync(path.join(exampleDir, "dist"), { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  const started = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: exampleDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: BUILD_TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - started);
  const dist = path.join(exampleDir, "dist");
  if (exitCode !== 0 || !fs.existsSync(dist)) {
    const timedOut = proc.signalCode !== null && ms >= BUILD_TIMEOUT_MS;
    const output = `${timedOut ? `error: killed after ${BUILD_TIMEOUT_MS / 60_000} min\n` : ""}${stdout}\n${stderr}`;
    return { ok: false, ms, error: errorExcerpt(output) };
  }
  fs.renameSync(dist, outDir);
  return { ok: true, ms };
}

async function runExample(name: string, examplesDir: string): Promise<ExampleResult> {
  if (SKIPPED[name]) return { name, skipped: SKIPPED[name] };
  const exampleDir = path.join(workRoot, name);
  const astroOut = path.join(exampleDir, "dist-astro");
  const pletivoOut = path.join(exampleDir, "dist-pletivo");
  if (compareOnly) {
    if (!fs.existsSync(astroOut)) return { name, harnessError: "no Astro output to compare" };
    if (!fs.existsSync(pletivoOut)) return { name, astro: { ok: true, ms: 0 } };
    const comparison = await compareOutputs(astroOut, pletivoOut, await exampleCssCanonicalizer(exampleDir), path.join(exampleDir, "normalized"));
    return { name, astro: { ok: true, ms: 0 }, pletivo: { ok: true, ms: 0 }, comparison };
  }
  fs.mkdirSync(exampleDir, { recursive: true });
  await prepareExample(path.join(examplesDir, name), exampleDir);

  // Starts with `dist`, so `prepareExample` keeps it.
  const astroRecordFile = path.join(exampleDir, "dist-astro.json");
  const key = sourceKey(exampleDir);
  let astro = rebuildAstro ? null : readAstroRecord(astroRecordFile, key, astroOut);
  if (astro === null) {
    astro = await runBuild([path.join(exampleDir, "node_modules/.bin/astro"), "build"], exampleDir, astroOut);
    const record: AstroRecord = { key, result: astro };
    fs.writeFileSync(astroRecordFile, JSON.stringify(record));
  }

  const pletivo = await runBuild([process.execPath, PLETIVO_CLI, "build"], exampleDir, pletivoOut);

  const comparison =
    astro.ok && pletivo.ok
      ? await compareOutputs(astroOut, pletivoOut, await exampleCssCanonicalizer(exampleDir), path.join(exampleDir, "normalized"))
      : undefined;
  return { name, astro, pletivo, comparison };
}

function row(result: ExampleResult): string {
  if (result.skipped) return `| ${result.name} | skipped | | | | ${result.skipped} |`;
  if (result.harnessError) return `| ${result.name} | harness error | | | | ${escapeCell(firstLine(result.harnessError))} |`;
  if (!result.pletivo) return `| ${result.name} | not built | | | | |`;
  const c = result.comparison;
  const routes = c ? `${c.routes.common.length}/${c.routes.astro.length}${c.routes.extra.length ? ` +${c.routes.extra.length}` : ""}` : "";
  const pages = c ? `${c.matchingPages.length}/${c.routes.astroPages.length}` : "";
  const summary = !result.astro?.ok
    ? `astro: ${firstLine(result.astro?.error)}`
    : !result.pletivo.ok
      ? firstLine(result.pletivo.error)
      : (c?.summary ?? "");
  const match = c?.match ? "**yes**" : "no";
  return `| ${result.name} | ${result.pletivo.ok ? "yes" : "**no**"} | ${routes} | ${pages} | ${match} | ${escapeCell(summary)} |`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split(REPO_ROOT).join("<repo>").split(workRoot).join("<work>")
    .split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function renderTable(results: ExampleResult[], astroVersion: string): string {
  const judged = results.filter((r) => !r.skipped && !r.harnessError && r.astro?.ok);
  const builds = judged.filter((r) => r.pletivo?.ok).length;
  const matches = judged.filter((r) => r.comparison?.match).length;
  const unjudged = results.filter((r) => !r.skipped).length - judged.length;
  return [
    `Astro ${astroVersion}: ${builds} of ${judged.length} examples build with pletivo, ${matches} of ${judged.length} match.` +
      (unjudged > 0 ? ` ${unjudged} not judged (harness error or Astro build failed).` : ""),
    "",
    "| example | pletivo builds | routes (common/astro +extra) | pages equal | match | first difference |",
    "|---|---|---|---|---|---|",
    ...results.map(row),
  ].join("\n");
}

const examples = await resolveExamples();
const names = fs
  .readdirSync(examples.dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(examples.dir, d.name, "package.json")))
  .map((d) => d.name)
  .filter((name) => !only || only.includes(name))
  .sort();

fs.mkdirSync(workRoot, { recursive: true });
const results: ExampleResult[] = [];
for (const name of names) {
  process.stderr.write(`${name} … `);
  let result: ExampleResult;
  try {
    result = await runExample(name, examples.dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { name, harnessError: message };
  }
  results.push(result);
  process.stderr.write(
    result.skipped
      ? "skipped\n"
      : result.harnessError
        ? `harness error: ${firstLine(result.harnessError)}\n`
        : `pletivo ${result.pletivo ? (result.pletivo.ok ? "ok" : "FAILED") : "not built"}, match ${result.comparison?.match ? "yes" : "no"}\n`,
  );
}

const table = renderTable(results, examples.astroVersion);
console.log(table);
if (markdownOut) fs.writeFileSync(markdownOut, `${table}\n`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
