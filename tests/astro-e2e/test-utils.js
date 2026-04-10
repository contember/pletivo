import { test as testBase } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLETIVO_CLI = path.resolve(
  __dirname,
  "../../packages/pletivo/src/cli.ts",
);

// Assign unique ports per test file. Scan tests/ dir at import time.
const testsDir = path.join(__dirname, "tests");
const testFileToPort = new Map();
if (fs.existsSync(testsDir)) {
  const testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.js")).sort();
  for (let i = 0; i < testFiles.length; i++) {
    testFileToPort.set(testFiles[i], 5100 + i);
  }
}

/**
 * Wait for a server to respond at the given URL.
 */
async function waitForServer(url, maxAttempts = 60, intervalMs = 250) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // server is up
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Server at ${url} did not start within ${(maxAttempts * intervalMs) / 1000}s`,
  );
}

/**
 * Drop-in replacement for Astro's e2e testFactory.
 *
 * Returns a Playwright `test` instance extended with an `astro` fixture
 * that starts pletivo's dev server instead of Astro's.
 */
export function testFactory(testFile, inlineConfig) {
  if (!inlineConfig?.root)
    throw new Error("Must provide { root: './fixtures/...' }");

  const testFilePath =
    typeof testFile === "string" && testFile.startsWith("file:")
      ? fileURLToPath(testFile)
      : String(testFile);
  const testFileName = path.basename(testFilePath);
  const port = testFileToPort.get(testFileName) || 5199;

  const fixtureRoot = path.resolve(path.dirname(testFilePath), inlineConfig.root);

  /** Cache of original file contents for resetAllFiles() */
  const fileCache = new Map();
  let serverProc = null;

  const fixture = {
    async startDevServer() {
      serverProc = spawn("bun", ["run", PLETIVO_CLI, "dev", `--port=${port}`], {
        cwd: fixtureRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Log stderr for debugging
      serverProc.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) process.stderr.write(`[pletivo:${testFileName}] ${msg}\n`);
      });

      // Fail fast if process exits during startup
      const exitPromise = new Promise((_, reject) => {
        serverProc.on("exit", (code) => {
          if (code !== null && code !== 0) {
            reject(new Error(`pletivo dev exited with code ${code}`));
          }
        });
      });

      await Promise.race([
        waitForServer(`http://localhost:${port}`),
        exitPromise,
      ]);

      return {
        async stop() {
          if (serverProc) {
            serverProc.kill("SIGINT");
            await new Promise((resolve) => serverProc.on("close", resolve));
            serverProc = null;
          }
        },
      };
    },

    resolveUrl(p) {
      return `http://localhost:${port}${p}`;
    },

    async fetch(p) {
      return fetch(`http://localhost:${port}${p}`);
    },

    async editFile(filePath, transform) {
      const fullPath = path.resolve(fixtureRoot, filePath);
      if (!fileCache.has(fullPath)) {
        fileCache.set(fullPath, fs.readFileSync(fullPath, "utf-8"));
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      fs.writeFileSync(fullPath, transform(content));
    },

    resetAllFiles() {
      for (const [fullPath, original] of fileCache) {
        fs.writeFileSync(fullPath, original);
      }
      fileCache.clear();
    },

    config: inlineConfig,
  };

  const test = testBase.extend({
    // biome-ignore lint/correctness/noEmptyPattern: playwright needs this
    astro: async ({}, use) => {
      await use(fixture);
    },
  });

  test.afterEach(() => {
    fixture.resetAllFiles();
  });

  return test;
}
