import { describe, expect, test } from "bun:test";
import path from "node:path";
import { tailwindDir } from "./tailwind-sources.ts";

/**
 * The only assertion in this suite that compares the two hosts' actual bytes.
 *
 * Everything else here checks the Workers host against what it is *believed* the Bun
 * host does; this runs `pletivo build` for real and diffs the HTML and the generated
 * stylesheet against it. `local-parity.ts` does the work — in a subprocess, because a
 * build registers process-global Bun plugins and because the Astro compiler owns one
 * `globalThis` slot per process, which this file has already taken.
 *
 * `test/parity.ts` is the same comparison against a real workerd, and has to stay a
 * manual run: it needs `wrangler dev` listening.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** Tailwind's own sources are read off disk here, and the Bun host needs oxide too. */
const HAS_TAILWIND = tailwindDir() !== null && canResolve("@tailwindcss/oxide");

function canResolve(specifier: string): boolean {
  try {
    Bun.resolveSync(specifier, import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

async function localParity(fixture: string): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(
    ["bun", path.join(import.meta.dir, "local-parity.ts"), fixture],
    { cwd: REPO_ROOT, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, output: stdout + stderr };
}

describe.skipIf(!HAS_TAILWIND)("byte parity with pletivo build", () => {
  test(
    "the Tailwind fixture renders the same HTML and the same stylesheet on both hosts",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-tailwind");
      // Two pages and the stylesheet each of them links, all byte-for-byte.
      expect(output).toContain("2/2 byte-identical");
      expect(output).toContain("= /assets/styles.");
      expect(ok).toBe(true);
    },
    60_000,
  );
});
