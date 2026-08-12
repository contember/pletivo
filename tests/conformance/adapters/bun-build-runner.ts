/**
 * Child-process entry for the `bun-build` adapter. Not a test file.
 *
 * Reads a job file describing which projects to build and where to put the
 * output, then runs `build()` for each. A failure is written to
 * `<workRoot>/<id>.error` and the run continues, so one broken case cannot hide
 * the results of the rest.
 *
 * Runs as a child rather than inline in `bun test` because a build registers
 * process-global Bun plugins and builds the astro host once per process; `bun
 * test` shares one process across test files, so doing this inline would leak
 * the corpus's plugin and host state into every other suite.
 */
import path from "path";
import fs from "fs/promises";
import { build } from "../../../packages/pletivo/src/build";
import { __resetForTests } from "../../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../../packages/pletivo/src/config";

export interface RunnerJob {
  id: string;
  /** Absolute project root. */
  root: string;
  /** Absolute output directory. */
  outDir: string;
  config: PletivoConfig;
}

const jobFile = process.argv[2];
if (!jobFile) {
  console.error("usage: bun-build-runner.ts <job.json>");
  process.exit(2);
}

const jobs: RunnerJob[] = JSON.parse(await Bun.file(jobFile).text());
const workRoot = path.dirname(jobFile);

for (const job of jobs) {
  try {
    // The astro host is per-process and per-root; reset it so a project without
    // an astro.config cannot inherit the previous project's host.
    __resetForTests();
    await build(job.root, {
      ...job.config,
      // `build()` joins outDir onto the project root, so an out-of-tree target
      // has to be expressed relative to it. This keeps the harness from writing
      // anything at all into the fixture and example directories.
      outDir: path.relative(job.root, job.outDir),
    });
  } catch (err) {
    await fs.writeFile(
      path.join(workRoot, `${job.id}.error`),
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
    );
  } finally {
    __resetForTests();
  }
}
