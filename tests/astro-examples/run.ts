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
 * depends on the example, so it is reused across runs unless `--rebuild-astro`.
 */

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlag, readBoolFlag } from "../../packages/pletivo/src/cli-args";
import { compareOutputs, type Comparison } from "./compare";
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

interface BuildResult {
  ok: boolean;
  ms: number;
  /** Last lines of the build's output, when it failed. */
  error?: string;
}

interface ExampleResult {
  name: string;
  skipped?: string;
  astro?: BuildResult;
  pletivo?: BuildResult;
  comparison?: Comparison;
}

async function resolveExamplesDir(): Promise<string> {
  const checkout = readFlag(argv, ["--astro"]);
  if (checkout) return path.join(path.resolve(checkout), "examples");

  const cloneDir = path.join(workRoot, ".astro", ASTRO_REF);
  if (!fs.existsSync(path.join(cloneDir, "examples"))) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    await $`git clone --quiet --depth 1 --branch ${ASTRO_REF} --filter=blob:none --sparse ${ASTRO_REPO} ${cloneDir}`;
    await $`git -C ${cloneDir} sparse-checkout set examples`.quiet();
  }
  return path.join(cloneDir, "examples");
}

/** `^5.16.11` → `5.16.11`: the examples were released against these exact versions. */
function pinDependencies(pkg: Record<string, unknown>): void {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string") (deps as Record<string, string>)[name] = range.replace(/^[\^~]/, "");
    }
  }
}

/** Copy the example and install it; reinstall only when its manifest changed. */
async function prepareExample(sourceDir: string, exampleDir: string): Promise<void> {
  const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  pinDependencies(pkg);
  const manifest = `${JSON.stringify(pkg, null, 2)}\n`;
  const manifestPath = path.join(exampleDir, "package.json");
  const installed =
    fs.existsSync(path.join(exampleDir, "node_modules")) &&
    fs.existsSync(manifestPath) &&
    fs.readFileSync(manifestPath, "utf8") === manifest;

  for (const entry of fs.readdirSync(exampleDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("dist")) continue;
    fs.rmSync(path.join(exampleDir, entry.name), { recursive: true, force: true });
  }
  fs.cpSync(sourceDir, exampleDir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.astro)$/.test(src),
  });
  fs.writeFileSync(manifestPath, manifest);

  if (!installed) {
    const install = await $`bun install`.cwd(exampleDir).nothrow().quiet();
    if (install.exitCode !== 0) {
      throw new Error(`bun install failed:\n${install.stderr.toString()}`);
    }
  }
}

/** The first line that names an error, then the last lines of the output. */
function errorExcerpt(text: string, lines = 12): string {
  const all = text.trimEnd().split("\n");
  const first = all.find((l) => /\b\w*Error\b|\berror:|✗/.test(l));
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
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - started);
  const dist = path.join(exampleDir, "dist");
  if (exitCode !== 0 || !fs.existsSync(dist)) {
    return { ok: false, ms, error: errorExcerpt(`${stdout}\n${stderr}`) };
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
    const built = (dir: string): BuildResult => ({ ok: fs.existsSync(dir), ms: 0 });
    const astro = built(astroOut);
    const pletivo = built(pletivoOut);
    const comparison = astro.ok && pletivo.ok
      ? await compareOutputs(astroOut, pletivoOut, path.join(exampleDir, "normalized"))
      : undefined;
    return { name, astro, pletivo, comparison };
  }
  fs.mkdirSync(exampleDir, { recursive: true });
  await prepareExample(path.join(examplesDir, name), exampleDir);

  const astroMarker = path.join(exampleDir, ".astro-build.json");
  let astro: BuildResult;
  if (!rebuildAstro && fs.existsSync(astroMarker)) {
    astro = JSON.parse(fs.readFileSync(astroMarker, "utf8"));
  } else {
    astro = await runBuild([path.join(exampleDir, "node_modules/.bin/astro"), "build"], exampleDir, astroOut);
    fs.writeFileSync(astroMarker, JSON.stringify(astro));
  }

  const pletivo = await runBuild([process.execPath, PLETIVO_CLI, "build"], exampleDir, pletivoOut);

  const comparison =
    astro.ok && pletivo.ok
      ? await compareOutputs(astroOut, pletivoOut, path.join(exampleDir, "normalized"))
      : undefined;
  return { name, astro, pletivo, comparison };
}

function row(result: ExampleResult): string {
  if (result.skipped) return `| ${result.name} | skipped | | | | ${result.skipped} |`;
  const build = (b?: BuildResult) => (b ? (b.ok ? "yes" : "**no**") : "");
  const c = result.comparison;
  const routes = c ? `${c.routes.common.length}/${c.routes.astro.length}${c.routes.extra.length ? ` +${c.routes.extra.length}` : ""}` : "";
  const pages = c ? `${c.matchingPages.length}/${c.routes.astroPages.length}` : "";
  const summary = !result.pletivo?.ok
    ? firstLine(result.pletivo?.error)
    : !result.astro?.ok
      ? `astro: ${firstLine(result.astro?.error)}`
      : (c?.summary ?? "");
  const match = c?.match ? "**yes**" : "no";
  return `| ${result.name} | ${build(result.pletivo)} | ${routes} | ${pages} | ${match} | ${summary.replaceAll("|", "\\|")} |`;
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split(REPO_ROOT).join("<repo>").split(workRoot).join("<work>")
    .split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function renderTable(results: ExampleResult[]): string {
  const built = results.filter((r) => !r.skipped);
  const builds = built.filter((r) => r.pletivo?.ok).length;
  const matches = built.filter((r) => r.comparison?.match).length;
  return [
    `Astro ${ASTRO_REF}: ${builds} of ${built.length} examples build with pletivo, ${matches} of ${built.length} match.`,
    "",
    "| example | pletivo builds | routes (common/astro +extra) | pages equal | match | first difference |",
    "|---|---|---|---|---|---|",
    ...results.map(row),
  ].join("\n");
}

const examplesDir = await resolveExamplesDir();
const names = fs
  .readdirSync(examplesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(examplesDir, d.name, "package.json")))
  .map((d) => d.name)
  .filter((name) => !only || only.includes(name))
  .sort();

fs.mkdirSync(workRoot, { recursive: true });
const results: ExampleResult[] = [];
for (const name of names) {
  process.stderr.write(`${name} … `);
  let result: ExampleResult;
  try {
    result = await runExample(name, examplesDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { name, pletivo: { ok: false, ms: 0, error: `harness: ${message}` } };
  }
  results.push(result);
  process.stderr.write(
    result.skipped ? "skipped\n" : `pletivo ${result.pletivo?.ok ? "ok" : "FAILED"}, match ${result.comparison?.match ? "yes" : "no"}\n`,
  );
}

const table = renderTable(results);
console.log(table);
if (markdownOut) fs.writeFileSync(markdownOut, `${table}\n`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
