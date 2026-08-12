import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import {
  BUN_ARGS_ENV,
  childRuntimeFlags,
  RESTART_EXIT_CODE,
  superviseDev,
} from "../../packages/pletivo/src/dev-supervisor";

const fixtureRoot = path.join(import.meta.dir, "__dev-supervisor-fixture__");
const runsPath = path.join(fixtureRoot, "runs.txt");

/** Stand-in for the dev server: counts its own starts, exits with a scripted code. */
const CHILD = `
import fs from 'node:fs'
const runsPath = process.argv[2]
const codes = process.argv[3].split(',').map(Number)
const runs = fs.existsSync(runsPath) ? Number(fs.readFileSync(runsPath, 'utf8')) : 0
fs.writeFileSync(runsPath, String(runs + 1))
if (process.env.PLETIVO_DEV_CHILD !== '1') { console.error('child flag missing'); process.exit(99) }
process.exit(codes[Math.min(runs, codes.length - 1)])
`;

const childPath = path.join(fixtureRoot, "child.mjs");

/** Reports the runtime flags it was actually started with, then exits cleanly. */
const FLAG_CHILD = `
import fs from 'node:fs'
fs.writeFileSync(process.argv[2], JSON.stringify(process.execArgv))
process.exit(0)
`;

const flagChildPath = path.join(fixtureRoot, "flag-child.mjs");
const flagsPath = path.join(fixtureRoot, "flags.json");

async function runs(): Promise<number> {
  return Number(await fs.readFile(runsPath, "utf8"));
}

async function supervise(codes: number[]): Promise<number> {
  await fs.writeFile(runsPath, "0");
  return await superviseDev({
    argv: [childPath, runsPath, codes.join(",")],
    backoffMs: [1],
    respawnDelayMs: 1,
    maxCrashRetries: 2,
  });
}

describe("dev supervisor", () => {
  beforeAll(async () => {
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(childPath, CHILD);
    await fs.writeFile(flagChildPath, FLAG_CHILD);
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("a restart request respawns the child and is not counted as a crash", async () => {
    expect(await supervise([RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0])).toBe(0);
    expect(await runs()).toBe(3);
  });

  test("a clean exit ends supervision", async () => {
    expect(await supervise([0])).toBe(0);
    expect(await runs()).toBe(1);
  });

  test("a crash is retried, then the child's code is returned", async () => {
    expect(await supervise([1])).toBe(1);
    // First run + two retries — then the budget is spent.
    expect(await runs()).toBe(3);
  });

  test("a crash that recovers keeps the server up", async () => {
    expect(await supervise([1, 0])).toBe(0);
    expect(await runs()).toBe(2);
  });

  test("restart requests do not consume the crash budget", async () => {
    // Four restarts (more than maxCrashRetries) then a crash that still gets
    // its own full retry budget.
    const code = RESTART_EXIT_CODE;
    expect(await supervise([code, code, code, code, 1])).toBe(1);
    expect(await runs()).toBe(7);
  });

  // Rebuilding the child's command line from `process.argv` alone dropped every bun runtime
  // flag, because bun keeps them in `process.execArgv`. The serving process — the one worth
  // tuning or profiling — could therefore never receive `--smol`, `--inspect` or `--heap-prof`.
  test("runtime flags reach the child that actually serves", async () => {
    await fs.rm(flagsPath, { force: true });
    expect(
      await superviseDev({
        argv: [flagChildPath, flagsPath],
        runtimeFlags: ["--smol"],
        respawnDelayMs: 1,
      }),
    ).toBe(0);
    expect(JSON.parse(await fs.readFile(flagsPath, "utf8"))).toEqual(["--smol"]);
  });

  describe("childRuntimeFlags", () => {
    test("passes this process's own runtime flags through", () => {
      expect(childRuntimeFlags({})).toEqual(process.execArgv);
    });

    // `bunx pkg` execs the package bin as a fresh `bun <bin>`, so a flag on the outer
    // `bun --smol x pletivo@latest` is gone before the supervisor starts. Env is the only
    // channel that survives, and bunx is how the redo agent launches the dev server.
    test("accepts flags over the env channel, which survives bunx", () => {
      expect(childRuntimeFlags({ [BUN_ARGS_ENV]: "--smol" })).toContain("--smol");
    });

    test("tolerates surrounding and repeated whitespace", () => {
      expect(childRuntimeFlags({ [BUN_ARGS_ENV]: "  --smol   --inspect " })).toEqual([
        ...process.execArgv,
        "--smol",
        "--inspect",
      ]);
    });

    test("an empty value adds nothing", () => {
      expect(childRuntimeFlags({ [BUN_ARGS_ENV]: "" })).toEqual(process.execArgv);
    });
  });
});
