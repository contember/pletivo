/**
 * Starts `pletivo dev --port=0` for the e2e (Playwright) and integration (node --test) harnesses.
 * A fixed port can be held by another process on a shared machine; port 0 cannot.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLETIVO_CLI = path.resolve(__dirname, "../../packages/pletivo/src/cli.ts");

// Anchored on the whitespace after the URL, so a read that splits the line mid-port is not taken.
const READY_LINE = /dev server running at (http:\/\/\S+)\s/g;

// Node's spawn needs an absolute path; bun may not be on node's PATH.
export const BUN = (() => {
  const candidates = [
    process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin/bun"),
    path.join(process.env.HOME || "", ".bun/bin/bun"),
    "/usr/local/bin/bun",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync("/usr/bin/which", ["bun"]).toString().trim();
  } catch {
    return "bun";
  }
})();

export { PLETIVO_CLI };

/**
 * Start the dev server in `cwd` and resolve once it reports the URL it bound.
 *
 * @param {{ cwd: string, label: string, timeoutMs?: number }} options
 * @returns {Promise<{ url(): string, stop(): Promise<void> }>}
 */
export async function startPletivoDev({ cwd, label, timeoutMs = 30_000 }) {
  const proc = spawn(BUN, ["run", PLETIVO_CLI, "dev", "--port=0"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  // The supervisor restarts the child on a config change or crash, and the new child gets a new port.
  let url = null;
  let onReady = () => {};
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    output += chunk;
    const matches = [...output.matchAll(READY_LINE)];
    if (matches.length === 0) return;
    url = matches[matches.length - 1][1].replace(/\/$/, "");
    onReady();
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    output += chunk;
    const msg = chunk.trim();
    if (msg) process.stderr.write(`[pletivo:${label}] ${msg}\n`);
  });

  const closed = new Promise((resolve) => proc.on("close", resolve));
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGINT");
    await closed;
  };

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  onReady = () => {};

  if (!ready) {
    const ended =
      proc.signalCode ?? (proc.exitCode === null ? null : `code ${proc.exitCode}`);
    await stop();
    const reason =
      ended === null
        ? `did not report a URL within ${timeoutMs}ms`
        : `exited with ${ended} before reporting a URL`;
    throw new Error(`pletivo dev in ${cwd} ${reason}:\n${output}`);
  }

  return { url: () => url, stop };
}
