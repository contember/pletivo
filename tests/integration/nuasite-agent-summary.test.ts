import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-nuasite-agent-summary");
const distDir = path.join(fixtureRoot, "dist");
// `@nuasite/agent-summary` writes `AGENTS.md` to `process.cwd()`, so the
// test chdirs into the fixture for the duration of the build.
const agentsFile = path.join(fixtureRoot, "AGENTS.md");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("@nuasite/agent-summary integration", () => {
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    __resetForTests();
    process.chdir(fixtureRoot);
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    __resetForTests();
    process.chdir(originalCwd);
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.rm(agentsFile, { force: true });
  });

  test("writes AGENTS.md with one JSONL entry per page", async () => {
    const md = await Bun.file(agentsFile).text();
    expect(md).toContain('"kind":"page"');
    expect(md).toContain('"route":"/"');
    expect(md).toContain('"route":"/about"');
    expect(md).toContain('"description":"Landing page for the home route."');
    expect(md).toContain('"description":"About the project."');
  });
});
