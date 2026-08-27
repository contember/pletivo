import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The parsing matrix lives in `tests/unit/cli-args.test.ts`, which calls
 * `applyCliOverrides` directly. This file covers what that cannot: that the
 * binary still reaches it, and the exit codes a shell or a CI job depends on.
 */

const cliPath = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-cli-args-"));

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: temporary,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("pletivo CLI", () => {
  test("--help, -h and help all print usage and exit 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("static site generator");
      // Every documented flag must appear, or the help drifts from the parser.
      for (const documented of [
        "--incremental", "--clean", "--port", "--host", "--404-page",
        "--error-page", "--stale", "--debug-header", "--no-restart", "--version",
      ]) {
        expect(result.stdout).toContain(documented);
      }
    }
  }, 30_000);

  test("--version, -v and version print the bare version and exit 0", async () => {
    const manifest = await Bun.file(
      path.resolve(import.meta.dir, "../../packages/pletivo/package.json"),
    ).json();
    for (const flag of ["--version", "-v", "version"]) {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      // Bare, so `$(pletivo --version)` is usable without stripping.
      expect(result.stdout.trim()).toBe(manifest.version);
    }
  }, 30_000);

  test("no command prints usage and exits 0", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  }, 30_000);

  test("an unknown command names it and exits 1", async () => {
    const result = await runCli(["buld"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: buld");
  }, 30_000);

  /**
   * The parse runs before the command dispatch, so a rejected value has to stop
   * the process rather than reach `dev` — where it used to bind `NaN`.
   */
  test("a bad --port fails before anything starts", async () => {
    const result = await runCli(["dev", "--port=abc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--port expects a number");
    expect(result.stdout).not.toContain("dev server running");
  }, 30_000);

  test("--help wins over a bad flag value only when the parse succeeds", async () => {
    const result = await runCli(["--help", "--port=70000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--port expects a number");
  }, 30_000);
});
