import { afterAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-dev-supervisor-shutdown-"));
const runsPath = path.join(temporary, "runs.txt");
const childPath = path.join(temporary, "child.mjs");
const supervisorPath = path.join(temporary, "supervisor.ts");
const supervisorModule = path.join(import.meta.dir, "../../packages/pletivo/src/dev-supervisor.ts");

/** Stand-in for the dev server: counts its own starts and crashes at once. */
const CHILD = `
import fs from 'node:fs'
const runsPath = process.argv[2]
const runs = fs.existsSync(runsPath) ? Number(fs.readFileSync(runsPath, 'utf8')) : 0
fs.writeFileSync(runsPath, String(runs + 1))
process.exit(1)
`;

/** The supervisor runs in its own process so the test can send it a real SIGTERM. */
const SUPERVISOR = `
import { superviseDev } from ${JSON.stringify(supervisorModule)}
process.exit(await superviseDev({
  argv: [${JSON.stringify(childPath)}, ${JSON.stringify(runsPath)}],
  runtimeFlags: [],
  backoffMs: [10000],
}))
`;

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

async function waitForStderr(stream: ReadableStream<Uint8Array>, needle: string): Promise<void> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes(needle)) return;
  }
  throw new Error(`supervisor stderr ended without ${JSON.stringify(needle)}:\n${seen}`);
}

test("SIGTERM during the crash backoff stops the supervisor without spawning another child", async () => {
  await fs.writeFile(childPath, CHILD);
  await fs.writeFile(supervisorPath, SUPERVISOR);
  await fs.writeFile(runsPath, "0");

  const supervisor = Bun.spawn([process.execPath, supervisorPath], {
    stdout: "inherit",
    stderr: "pipe",
  });

  try {
    // The supervisor logs this after the first child crashed and before its backoff sleep.
    await waitForStderr(supervisor.stderr, "restarting in 10000ms");
    const signalledAt = performance.now();
    supervisor.kill("SIGTERM");

    expect(await supervisor.exited).toBe(0);
    expect(Number(await fs.readFile(runsPath, "utf8"))).toBe(1);
    // Well under the 10 s backoff: the signal cuts the sleep short instead of waiting it out.
    expect(performance.now() - signalledAt).toBeLessThan(5000);
  } finally {
    supervisor.kill("SIGKILL");
  }
}, 20_000);
