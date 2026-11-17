/**
 * A process wires one renderer set: its compilers are Bun plugins. When a retried
 * `astro:config:setup` changes a wired set, the supervised dev child exits for a restart, as
 * on a config change; without a supervisor, dev says to restart it.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { CHILD_ENV_FLAG, RESTART_EXIT_CODE } from "../../packages/pletivo/src/dev-supervisor";

const template = path.join(import.meta.dir, "../fixture-astro-renderers-restart");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

interface Dev {
  root: string;
  base: string;
  child: ReturnType<typeof Bun.spawn>;
  output(): string;
}

const started: Dev[] = [];

afterEach(async () => {
  for (const dev of started.splice(0)) {
    dev.child.kill();
    await dev.child.exited;
    await fs.rm(dev.root, { recursive: true, force: true });
  }
});

async function startDev(args: readonly string[], env: Record<string, string>): Promise<Dev> {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-restart-"));
  await fs.cp(template, root, { recursive: true });
  const port = 7600 + Math.floor(Math.random() * 1000);
  const child = Bun.spawn(["bun", cli, "dev", String(port), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const dev: Dev = { root, base: `http://localhost:${port}`, child, output: () => output };
  started.push(dev);
  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(child.stdout);
  void collect(child.stderr);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${dev.base}/__hmr_ping`);
      return dev;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`the dev server did not start:\n${output}`);
}

test("the supervised dev child exits for a restart when a retry changes the wired renderers", async () => {
  const dev = await startDev([], { [CHILD_ENV_FLAG]: "1" });
  // A change under src/ retries the failed hook, which now passes and registers Preact.
  await fs.writeFile(path.join(dev.root, "src/ready.txt"), "ready\n");
  const code = await Promise.race([dev.child.exited, Bun.sleep(20_000).then(() => "still running")]);
  expect({ code, output: dev.output() }).toMatchObject({ code: RESTART_EXIT_CODE });
  expect(dev.output()).toContain("framework renderers changed (@astrojs/vue → @astrojs/vue, @astrojs/preact) → restarting dev server");
}, 60_000);

test("without a supervisor, dev keeps serving and says to restart it", async () => {
  const dev = await startDev(["--no-restart"], {});
  await fs.writeFile(path.join(dev.root, "src/ready.txt"), "ready\n");
  for (let attempt = 0; attempt < 100 && !dev.output().includes("framework renderers changed"); attempt++) {
    await Bun.sleep(100);
  }
  expect(dev.output()).toContain("framework renderers changed (@astrojs/vue → @astrojs/vue, @astrojs/preact); restart `pletivo dev`");
  expect((await fetch(`${dev.base}/`)).status).toBe(200);
}, 60_000);
