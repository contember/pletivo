/**
 * A retry that changes a wired renderer set restarts a supervised dev child (else dev says to);
 * a hook that fails only on a fresh process's first pass is retried before wiring, so no restart.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";
import { CHILD_ENV_FLAG, RESTART_EXIT_CODE } from "../../packages/pletivo/src/dev-supervisor";

const RESTART = path.join(import.meta.dir, "../fixture-astro-renderers-restart");
const LATE_SETUP = path.join(import.meta.dir, "../fixture-astro-renderers-late-setup");

interface Dev {
  root: string;
  server: DevServer;
}

const started: Dev[] = [];

afterEach(async () => {
  for (const dev of started.splice(0)) {
    await dev.server.stop();
    await fs.rm(dev.root, { recursive: true, force: true });
  }
});

async function startDev(template: string, args: string[], env: Record<string, string>): Promise<Dev> {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-restart-"));
  try {
    await fs.cp(template, root, { recursive: true });
    const server = await startDevServer({ cwd: root, args, env: { ...process.env, ...env }, timeoutMs: 25_000 });
    const dev = { root, server };
    started.push(dev);
    return dev;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("the supervised dev child exits for a restart when a retry changes the wired renderers", async () => {
  const dev = await startDev(RESTART, [], { [CHILD_ENV_FLAG]: "1" });
  // A change under src/ retries the failed hook, which now passes and registers Preact.
  await fs.writeFile(path.join(dev.root, "src/ready.txt"), "ready\n");
  const code = await Promise.race([dev.server.exited, Bun.sleep(20_000).then(() => "still running")]);
  expect({ code, output: dev.server.output() }).toMatchObject({ code: RESTART_EXIT_CODE });
  expect(dev.server.output()).toContain("framework renderers changed (@astrojs/vue → @astrojs/vue, @astrojs/preact) → restarting dev server");
}, 60_000);

test("without a supervisor, dev keeps serving and says to restart it", async () => {
  const dev = await startDev(RESTART, ["--no-restart"], {});
  await fs.writeFile(path.join(dev.root, "src/ready.txt"), "ready\n");
  for (let attempt = 0; attempt < 100 && !dev.server.output().includes("framework renderers changed"); attempt++) {
    await Bun.sleep(100);
  }
  expect(dev.server.output()).toContain("framework renderers changed (@astrojs/vue → @astrojs/vue, @astrojs/preact); restart `pletivo dev`");
  expect((await fetch(`${dev.server.url}/`)).status).toBe(200);
}, 60_000);

test("a hook that passes only on a retry is retried at start, so the supervised child serves without restarting", async () => {
  const dev = await startDev(LATE_SETUP, [], { [CHILD_ENV_FLAG]: "1" });
  for (let request = 0; request < 5; request++) {
    const response = await fetch(`${dev.server.url}/`);
    const html = await response.text();
    expect({ request, status: response.status, output: dev.server.output() }).toMatchObject({ request, status: 200 });
    expect(html).toContain("preact 3</button>");
    expect(html).toContain("vue 4</button>");
    // Past the rate limit on request-triggered retries, so each request could retry.
    await Bun.sleep(1100);
  }
  expect(dev.server.running()).toBe(true);
  expect(dev.server.output()).not.toContain("restarting dev server");
}, 60_000);
