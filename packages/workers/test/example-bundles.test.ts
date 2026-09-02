import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKERS_DIR = path.resolve(import.meta.dir, "..");
const WRANGLER_JS = path.join(WORKERS_DIR, "node_modules/wrangler/bin/wrangler.js");
const OUTPUT_ROOT = await mkdtemp(path.join(tmpdir(), "pletivo-worker-examples-"));
const EXAMPLES = ["example", "example-playground"];

afterAll(() => rm(OUTPUT_ROOT, { recursive: true, force: true }));

async function allocatePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  return port;
}

function startPlayground(port: number, persistence: string) {
  const child = Bun.spawn(
    [
      "node",
      WRANGLER_JS,
      "dev",
      "--config",
      "example-playground/wrangler.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistence,
      "--log-level",
      "error",
    ],
    {
      cwd: WORKERS_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

type PlaygroundServer = ReturnType<typeof startPlayground>;

async function stopPlayground(server: PlaygroundServer): Promise<{ stdout: string; stderr: string }> {
  if (server.child.exitCode === null) server.child.kill();
  await server.child.exited;
  return { stdout: await server.stdout, stderr: await server.stderr };
}

async function waitForPlayground(base: string, server: PlaygroundServer): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Wrangler exited before readiness with ${server.child.exitCode}`);
    }
    try {
      const response = await fetch(`${base}/__files`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Wrangler readiness timed out: ${lastError}`);
}

async function withPlayground<T>(
  port: number,
  persistence: string,
  run: (base: string) => Promise<T>,
): Promise<T> {
  const server = startPlayground(port, persistence);
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForPlayground(base, server);
    return await run(base);
  } catch (error) {
    const logs = await stopPlayground(server);
    throw new Error(`Wrangler playground failed\n${logs.stdout}\n${logs.stderr}`, { cause: error });
  } finally {
    await stopPlayground(server);
  }
}

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

  test(
    "runs the kompjutr playground, renders its seed, and keeps an edit across restart",
    async () => {
      const port = await allocatePort();
      const persistence = path.join(OUTPUT_ROOT, "example-playground-state");
      let revisionAfterWrite = "";

      await withPlayground(port, persistence, async (base) => {
        const before = await (await fetch(`${base}/__files`)).text();
        const beforeRevision = /"revision":"([^"]+)"/.exec(before)?.[1];
        expect(beforeRevision).toBeString();

        const homeResponse = await fetch(`${base}/`);
        const home = await homeResponse.text();
        expect(homeResponse.status, home).toBe(200);
        expect(home).toContain("Four notes on what it takes");
        expect(home).toContain(".text-3xl");

        const postResponse = await fetch(`${base}/posts/no-build-step/`);
        const post = await postResponse.text();
        expect(postResponse.status, post).toBe(200);
        expect(post).toContain("A page with no build step");

        const write = await fetch(`${base}/__files/src/pages/probe.astro`, {
          method: "PUT",
          body: '<h1 class="font-bold">Persisted kompjutr probe</h1>',
        });
        expect(write.status, await write.text()).toBe(201);

        const probeResponse = await fetch(`${base}/probe`);
        expect(probeResponse.status).toBe(200);
        expect(await probeResponse.text()).toContain("Persisted kompjutr probe");

        const after = await (await fetch(`${base}/__files`)).text();
        revisionAfterWrite = /"revision":"([^"]+)"/.exec(after)?.[1] ?? "";
        expect(revisionAfterWrite).toBeString();
        expect(revisionAfterWrite).not.toBe(beforeRevision);
        expect(after).toContain("src/pages/probe.astro");
      });

      await withPlayground(port, persistence, async (base) => {
        const restored = await (await fetch(`${base}/__files`)).text();
        expect(restored).toContain(`"revision":"${revisionAfterWrite}"`);
        expect(restored).toContain("src/pages/probe.astro");

        const probeResponse = await fetch(`${base}/probe`);
        expect(probeResponse.status).toBe(200);
        expect(await probeResponse.text()).toContain("Persisted kompjutr probe");

        const remove = await fetch(`${base}/__files/src/pages/probe.astro`, { method: "DELETE" });
        expect(remove.status, await remove.text()).toBe(200);
        expect((await fetch(`${base}/probe`)).status).toBe(404);
      });
    },
    120_000,
  );
});
