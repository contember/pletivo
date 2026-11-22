// pletivo reads sources from its own `srcDir`. An astro.config `srcDir` that differs would be
// ignored, so build, dev and prepare stop and name the pletivo.config setting that fixes it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const PAGES: Record<string, string> = {
  "app/pages/index.astro": `<html><body><p id="page">home from app</p></body></html>\n`,
  "app/pages/about.astro": `<html><body><p id="page">about from app</p></body></html>\n`,
};

const ASTRO_ONLY: Record<string, string> = {
  "astro.config.mjs": `export default { srcDir: "./app" };\n`,
  ...PAGES,
};

const EXPECTED_ERROR =
  `astro.config sets srcDir "./app", but pletivo reads sources from "src". ` +
  `Set srcDir: "./app" in pletivo.config as well.`;

async function writeProject(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
}

async function runCli(root: string, args: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bun", cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode: await child.exited, output: stdout + stderr };
}

const roots: string[] = [];

async function project(name: string, files: Record<string, string>): Promise<string> {
  // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
  const root = await fs.mkdtemp(path.join(import.meta.dir, `tmp-astro-src-dir-${name}-`));
  roots.push(root);
  await writeProject(root, files);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("srcDir set only in astro.config", () => {
  test("build stops and quotes the astro.config value", async () => {
    const root = await project("build", ASTRO_ONLY);
    const result = await runCli(root, ["build"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(EXPECTED_ERROR);
    expect(result.output).not.toContain("    at ");
    expect(await Bun.file(path.join(root, "dist/index.html")).exists()).toBe(false);
  }, 60_000);

  test("dev stops before serving", async () => {
    const root = await project("dev", ASTRO_ONLY);
    // Port 0: should dev bind after all, it cannot collide with another process.
    const result = await runCli(root, ["dev", "--port=0", "--no-restart"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(EXPECTED_ERROR);
    expect(result.output).not.toContain("    at ");
  }, 60_000);

  test("prepare reports it as a diagnostic", async () => {
    const root = await project("prepare", ASTRO_ONLY);
    const result = await runCli(root, ["prepare"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`astro.config (srcDir): ${EXPECTED_ERROR}`);
  }, 60_000);
});

describe("srcDir set in both configs", () => {
  test("build emits the pages under app/pages", async () => {
    const root = await project("both", {
      ...ASTRO_ONLY,
      // Spelled differently from astro.config on purpose: the check compares resolved paths.
      "pletivo.config.ts": `export default { srcDir: "app" };\n`,
    });
    const result = await runCli(root, ["build"]);
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(path.join(root, "dist/index.html")).text()).toContain("home from app");
    expect(await Bun.file(path.join(root, "dist/about/index.html")).text()).toContain("about from app");
  }, 60_000);
});
