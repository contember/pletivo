/**
 * The adapter for the current renderer: a full `pletivo build` on Bun.
 *
 * Spawns one child process for the whole corpus (or one per case with
 * `CONFORMANCE_ISOLATE=1`, which is the knob to reach for when a case's output
 * looks like it depends on what ran before it), then reads the output back.
 */
import path from "path";
import fs from "fs/promises";
import { isTextOutput, type CaseRender, type ConformanceAdapter } from "../adapter";
import { defaultConfig, repoRoot, type CorpusEntry } from "../corpus";
import type { RunnerJob } from "./bun-build-runner";

const runnerPath = path.join(import.meta.dir, "bun-build-runner.ts");

export const bunBuildAdapter: ConformanceAdapter = {
  name: "bun-build",

  async render(entries: CorpusEntry[], workRoot: string): Promise<Map<string, CaseRender>> {
    if (entries.length === 0) return new Map();

    const jobs: RunnerJob[] = entries.map((entry) => ({
      id: entry.id,
      root: path.join(repoRoot, entry.root),
      outDir: path.join(workRoot, entry.id),
      config: { ...defaultConfig, ...entry.config },
    }));

    const isolate = process.env.CONFORMANCE_ISOLATE === "1";
    for (const batch of isolate ? jobs.map((j) => [j]) : [jobs]) {
      await runBatch(batch, workRoot);
    }

    const results = new Map<string, CaseRender>();
    for (const entry of entries) {
      const error = await readIfPresent(path.join(workRoot, `${entry.id}.error`));
      if (error !== undefined) {
        results.set(entry.id, { outputs: new Map(), error });
        continue;
      }
      results.set(entry.id, await readOutput(path.join(workRoot, entry.id)));
    }
    return results;
  },
};

async function runBatch(jobs: RunnerJob[], workRoot: string): Promise<void> {
  const jobFile = path.join(workRoot, `job-${jobs[0]!.id}.json`);
  await fs.writeFile(jobFile, JSON.stringify(jobs));

  const proc = Bun.spawn(["bun", "run", runnerPath, jobFile], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    // Production keeps the build off any dev-only code path, matching how a
    // released site is rendered.
    env: { ...process.env, NODE_ENV: "production" },
  });
  // Both pipes must be drained: a build logs a line per emitted page, and the
  // benchmark examples emit thousands, which would fill the pipe buffer and
  // wedge the child if nobody were reading.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A non-zero exit means the runner itself died — per-case failures are
  // reported through `<id>.error` files and leave the exit code at 0.
  if (exitCode !== 0) {
    throw new Error(`bun-build runner exited with ${exitCode}\n${stderr}\n${tail(stdout)}`);
  }
}

function tail(text: string, lines = 20): string {
  return text.split("\n").slice(-lines).join("\n");
}

async function readOutput(dir: string): Promise<CaseRender> {
  const emitted = await walk(dir, "");
  emitted.sort();
  const outputs = new Map<string, string>();
  for (const file of emitted) {
    if (isTextOutput(file)) outputs.set(file, await Bun.file(path.join(dir, file)).text());
  }
  return { outputs, emitted };
}

async function walk(dir: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text();
  } catch {
    return undefined;
  }
}
