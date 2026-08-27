import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKERS_DIR = path.resolve(import.meta.dir, "..");
const WRANGLER_JS = path.join(WORKERS_DIR, "node_modules/wrangler/bin/wrangler.js");
const OUTPUT_ROOT = await mkdtemp(path.join(tmpdir(), "pletivo-worker-examples-"));
const EXAMPLES = ["example", "example-playground"];

afterAll(() => rm(OUTPUT_ROOT, { recursive: true, force: true }));

describe("Workers examples", () => {
  for (const example of EXAMPLES) {
    test(
      `Wrangler bundles ${example} without deploying`,
      async () => {
        const output = path.join(OUTPUT_ROOT, example);
        const child = Bun.spawn(
          [
            "node",
            WRANGLER_JS,
            "deploy",
            "--dry-run",
            "--config",
            `${example}/wrangler.jsonc`,
            "--outdir",
            output,
          ],
          {
            cwd: WORKERS_DIR,
            env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        expect((await readdir(output)).length).toBeGreaterThan(0);
      },
      120_000,
    );
  }
});
