import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { RESTART_EXIT_CODE, superviseDev } from "../../packages/pletivo/src/dev-supervisor";

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
});
