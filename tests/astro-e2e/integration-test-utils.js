/**
 * Drop-in replacement for Astro's test/test-utils.js.
 *
 * Provides a loadFixture() that builds via pletivo CLI instead of Astro,
 * then exposes the same read/fetch API so copied Astro test files work
 * with minimal patching.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUN, PLETIVO_CLI, startPletivoDev } from "./dev-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Promisified exec that runs bun with the pletivo CLI.
 * Uses shell: true so that bun is found via PATH even when spawned from node.
 */
function runPletivo(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      BUN,
      ["run", PLETIVO_CLI, ...args],
      { cwd },
      (err, stdout, stderr) => {
        if (err) {
          const msg = `pletivo ${args.join(" ")} failed (exit ${err.code}):\n${stderr || stdout}`;
          reject(new Error(msg));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * Load a pletivo fixture. API-compatible with Astro's loadFixture().
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
  const fileCache = new Map();

  let server = null;

  const fixture = {
    config: { outDir: new URL(`file://${outDir}/`), root: new URL(`file://${root}/`) },

    async build() {
      // Clean dist first
      fs.rmSync(outDir, { recursive: true, force: true });
      await runPletivo(["build"], root);
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

    // Stub — pletivo doesn't have a preview server. Returns a stoppable
    // object so tests that call preview() in before() hooks don't crash.
    async preview() {
      return { stop: async () => {} };
    },

    resolveUrl(url) {
      if (!server) throw new Error(`${root}: start the dev server before resolving a URL`);
      return `${server.url()}${url.replace(/^\/?/, "/")}`;
    },

    async fetch(url, init) {
      return fetch(fixture.resolveUrl(url), init);
    },

    async startDevServer() {
      server = await startPletivoDev({ cwd: root, label: "dev" });
      return {
        async stop() {
          if (server) {
            await server.stop();
            server = null;
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
