import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import {
  __resetForTests,
  initAstroHost,
  type AstroHost,
} from "../../packages/pletivo/src/astro-host/runner";

const fixtureRoot = path.join(import.meta.dir, "__astro-setup-retry-fixture__");
const markerPath = path.join(fixtureRoot, "marker.txt");

// The hook registers all three kinds of side effect BEFORE it throws — that
// partial state is what a retry has to avoid duplicating.
const CONFIG = `
import { existsSync } from 'node:fs'
import path from 'node:path'

const marker = path.join(import.meta.dir, 'marker.txt')

function flaky() {
  return {
    name: 'flaky',
    hooks: {
      'astro:config:setup': ({ injectRoute, injectScript, updateConfig }) => {
        injectRoute({ pattern: '/robots.txt', entrypoint: './src/routes/robots.ts' })
        injectScript('page', 'console.log("flaky")')
        updateConfig({ vite: { plugins: [{ name: 'flaky-vite-plugin' }] } })
        if (!existsSync(marker)) throw new Error('marker missing')
      },
    },
  }
}

export default { integrations: [flaky()] }
`;

function pluginCount(host: AstroHost, name: string): number {
  return host.server.__plugins.filter((p) => p?.name === name).length;
}

describe("astro:config:setup retry", () => {
  let host: AstroHost;

  beforeAll(async () => {
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.rm(markerPath, { force: true });
    await fs.writeFile(path.join(fixtureRoot, "astro.config.mjs"), CONFIG);
    __resetForTests();
    host = (await initAstroHost(fixtureRoot, "dev"))!;
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("a thrown hook is recorded instead of swallowed", () => {
    expect(host.setupErrors.map((f) => f.name)).toEqual(["flaky"]);
    expect((host.setupErrors[0]!.error as Error).message).toBe("marker missing");
  });

  test("side effects registered before the throw are kept", () => {
    expect(host.injectedRoutes).toHaveLength(1);
    expect(host.injectedPageScripts).toHaveLength(1);
    expect(pluginCount(host, "flaky-vite-plugin")).toBe(1);
  });

  test("a retry that fails again does not duplicate them", async () => {
    const recovered = await host.retryFailedSetup();
    expect(recovered).toEqual([]);
    expect(host.setupErrors).toHaveLength(1);
    expect(host.injectedRoutes).toHaveLength(1);
    expect(host.injectedPageScripts).toHaveLength(1);
    expect(pluginCount(host, "flaky-vite-plugin")).toBe(1);
  });

  test("fixing the cause recovers the integration without a restart", async () => {
    await fs.writeFile(markerPath, "ok");
    const recovered = await host.retryFailedSetup();
    expect(recovered).toEqual(["flaky"]);
    expect(host.setupErrors).toHaveLength(0);
    expect(host.injectedRoutes).toHaveLength(1);
    expect(host.injectedPageScripts).toHaveLength(1);
    expect(pluginCount(host, "flaky-vite-plugin")).toBe(1);
  });

  test("retrying with nothing left to fix is a no-op", async () => {
    expect(await host.retryFailedSetup()).toEqual([]);
    expect(host.injectedRoutes).toHaveLength(1);
  });
});
