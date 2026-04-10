/**
 * Drop-in replacement for Astro's test/test-utils.js.
 *
 * Provides a loadFixture() that builds via pavouk CLI instead of Astro,
 * then exposes the same read/fetch API so copied Astro test files work
 * with minimal patching.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAVOUK_CLI = path.resolve(
  __dirname,
  "../../packages/pavouk/src/cli.ts",
);

// Resolve bun binary path — node's execFile needs an absolute path
// since bun may not be on node's default PATH.
const BUN = (() => {
  // Check common locations first (fastest)
  const candidates = [
    process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin/bun"),
    path.join(process.env.HOME || "", ".bun/bin/bun"),
    "/usr/local/bin/bun",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: try which
  try {
    return execFileSync("/usr/bin/which", ["bun"]).toString().trim();
  } catch {
    return "bun";
  }
})();

/**
 * Promisified exec that runs bun with the pavouk CLI.
 * Uses shell: true so that bun is found via PATH even when spawned from node.
 */
function runPavouk(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      BUN,
      ["run", PAVOUK_CLI, ...args],
      { cwd },
      (err, stdout, stderr) => {
        if (err) {
          const msg = `pavouk ${args.join(" ")} failed (exit ${err.code}):\n${stderr || stdout}`;
          reject(new Error(msg));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * Wait for a server to respond.
 */
async function waitForServer(url, maxAttempts = 60, intervalMs = 250) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Server at ${url} did not start within ${(maxAttempts * intervalMs) / 1000}s`,
  );
}

// Port counter for dev servers
let nextPort = 6100;

/**
 * Load a pavouk fixture. API-compatible with Astro's loadFixture().
 *
 * @param {object} inlineConfig
 * @param {string} inlineConfig.root - Path to fixture directory (relative to caller or absolute)
 * @returns {Promise<Fixture>}
 */
export async function loadFixture(inlineConfig) {
  if (!inlineConfig?.root) throw new Error("Must provide { root: './fixtures/...' }");

  let root = inlineConfig.root;
  if (typeof root === "string" && root.startsWith("file://")) {
    root = fileURLToPath(new URL(root));
  } else if (typeof root === "string" && !path.isAbsolute(root)) {
    // Resolve relative to the project root (astro-e2e directory),
    // not relative to this file's location.
    root = path.resolve(__dirname, root);
  }

  const outDir = path.join(root, "dist");
  const port = nextPort++;
  const fileCache = new Map();

  let devProc = null;

  const fixture = {
    config: { outDir: new URL(`file://${outDir}/`), root: new URL(`file://${root}/`) },

    async build() {
      // Clean dist first
      fs.rmSync(outDir, { recursive: true, force: true });
      await runPavouk(["build"], root);
    },

    async readFile(filePath, encoding) {
      const full = path.join(outDir, filePath.replace(/^\//, ""));
      return fs.promises.readFile(full, encoding === undefined ? "utf8" : encoding);
    },

    async readdir(dirPath) {
      const full = path.join(outDir, (dirPath || "").replace(/^\//, ""));
      return fs.promises.readdir(full);
    },

    pathExists(p) {
      return fs.existsSync(path.join(outDir, p.replace(/^\//, "")));
    },

    async clean() {
      fs.rmSync(outDir, { recursive: true, force: true });
    },

    // Stub — pavouk doesn't have a preview server. Returns a stoppable
    // object so tests that call preview() in before() hooks don't crash.
    async preview() {
      return { stop: async () => {} };
    },

    resolveUrl(url) {
      return `http://localhost:${port}${url.replace(/^\/?/, "/")}`;
    },

    async fetch(url, init) {
      return fetch(fixture.resolveUrl(url), init);
    },

    async startDevServer() {
      const { spawn } = await import("node:child_process");
      devProc = spawn(BUN, ["run", PAVOUK_CLI, "dev", `--port=${port}`], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });

      devProc.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) process.stderr.write(`[pavouk:dev] ${msg}\n`);
      });

      await waitForServer(`http://localhost:${port}`);
      return {
        async stop() {
          if (devProc) {
            devProc.kill("SIGINT");
            await new Promise((resolve) => devProc.on("close", resolve));
            devProc = null;
          }
        },
      };
    },

    async editFile(filePath, newContentsOrCallback) {
      const fileUrl = path.resolve(root, filePath.replace(/^\//, ""));
      const contents = await fs.promises.readFile(fileUrl, "utf-8");
      if (!fileCache.has(fileUrl)) {
        fileCache.set(fileUrl, contents);
      }
      const newContents =
        typeof newContentsOrCallback === "function"
          ? newContentsOrCallback(contents)
          : newContentsOrCallback;
      await fs.promises.writeFile(fileUrl, newContents);
      return () => fs.writeFileSync(fileUrl, contents);
    },

    resetAllFiles() {
      for (const [filePath, original] of fileCache) {
        fs.writeFileSync(filePath, original);
      }
      fileCache.clear();
    },
  };

  return fixture;
}
