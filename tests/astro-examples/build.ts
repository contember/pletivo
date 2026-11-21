/**
 * What the two compatibility harnesses (`tests/astro-examples`, `tests/astro-fixtures`)
 * share: running a build into its own output directory, caching Astro's build by the
 * project's files, and the CSS spelling both sides are compared in.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { CssCanonicalizer } from "./compare";

export interface BuildResult {
  ok: boolean;
  ms: number;
  /** The error line and the last lines of the build's output, when it failed. */
  error?: string;
}

/** Files of a project as copied, skipping what a build or install writes. */
export function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (rel === "" && (entry.name === "node_modules" || entry.name.startsWith("dist") || entry.name === "normalized" || entry.name === ".astro" || entry.name === "bun.lock")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    // A symlinked directory (Astro's fixtures link content collections) is read through.
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, child)).isDirectory());
    if (isDirectory) out.push(...sourceFiles(dir, child));
    else out.push(child);
  }
  return out.sort();
}

/** Identifies what Astro's build of a project depends on: every source file, plus `extra` (installed versions). */
export function sourceKey(projectDir: string, extra = ""): string {
  const hash = createHash("sha256");
  hash.update(`${extra}\0`);
  for (const file of sourceFiles(projectDir)) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(projectDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Astro minifies CSS with Vite's esbuild; that copy, resolved through the project's
 * astro and vite, is the canonical spelling both sides are compared in, so Astro's
 * output is a fixed point.
 */
export async function astroCssCanonicalizer(projectDir: string): Promise<CssCanonicalizer> {
  const astroPath = createRequire(path.join(projectDir, "package.json")).resolve("astro/package.json");
  const vitePath = createRequire(astroPath).resolve("vite/package.json");
  const esbuildPath = createRequire(vitePath).resolve("esbuild");
  const esbuild: unknown = await import(esbuildPath);
  if (typeof esbuild !== "object" || esbuild === null || !("transform" in esbuild) || typeof esbuild.transform !== "function") {
    throw new Error(`${esbuildPath} exports no transform()`);
  }
  const transform = esbuild.transform;
  return async (css) => {
    const result: unknown = await transform(css, { loader: "css", minify: true, legalComments: "none" });
    if (typeof result !== "object" || result === null || !("code" in result) || typeof result.code !== "string") {
      throw new Error("esbuild transform() returned no code");
    }
    return result.code.trimEnd();
  };
}

/** Astro's cached result, valid only for the sources it was built from and while its output exists. */
export interface AstroRecord {
  key: string;
  result: BuildResult;
}

/**
 * A cached Astro build for `key`. A failed build is reused only with `reuseFailure`: a
 * failure may have been transient (a timeout), and the examples always retry it.
 */
export function readAstroRecord(file: string, key: string, outDir: string, reuseFailure = false): BuildResult | null {
  if (!fs.existsSync(file)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("key" in parsed) || parsed.key !== key) return null;
  if (!("result" in parsed) || typeof parsed.result !== "object" || parsed.result === null) return null;
  const result = parsed.result;
  if (!("ms" in result) || typeof result.ms !== "number" || !("ok" in result) || typeof result.ok !== "boolean") return null;
  if (result.ok) return fs.existsSync(outDir) ? { ok: true, ms: result.ms } : null;
  if (!reuseFailure) return null;
  const error = "error" in result && typeof result.error === "string" ? result.error : undefined;
  return { ok: false, ms: result.ms, error };
}

export function writeAstroRecord(file: string, record: AstroRecord): void {
  fs.writeFileSync(file, JSON.stringify(record));
}

/** The first line that names an error, then the last lines of the output. */
export function errorExcerpt(text: string, lines = 12): string {
  const all = text.trimEnd().split("\n");
  // The message line, not Bun's echo of the throwing source line (`57 | throw new Error(…)`).
  const first = all.find((l) => /^\s*(\w*Error\b|error:|✗)/.test(l)) ?? all.find((l) => /\b\w*Error\b/.test(l));
  return [first, ...all.slice(-lines)].filter((l) => l !== undefined).join("\n");
}

/** Run a build that writes `<projectDir>/<distName>`, then move it to `outDir`. */
export async function runBuild(
  cmd: string[],
  projectDir: string,
  outDir: string,
  timeoutMs: number,
  distName = "dist",
): Promise<BuildResult> {
  const dist = path.join(projectDir, distName);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  const started = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - started);
  if (exitCode !== 0 || !fs.existsSync(dist)) {
    const timedOut = proc.signalCode !== null && ms >= timeoutMs;
    const output = `${timedOut ? `error: killed after ${Math.round(timeoutMs / 1000)} s\n` : ""}${stdout}\n${stderr}`;
    return { ok: false, ms, error: errorExcerpt(output) };
  }
  fs.renameSync(dist, outDir);
  return { ok: true, ms };
}

export function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}
