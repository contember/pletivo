import { test as testBase } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startPletivoDev } from "./dev-server.js";

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

  const fixtureRoot = path.resolve(path.dirname(testFilePath), inlineConfig.root);

  /** Cache of original file contents for resetAllFiles() */
  const fileCache = new Map();
  let server = null;

  const origin = () => {
    if (!server) throw new Error(`${testFileName}: start the dev server before resolving a URL`);
    return server.url();
  };

  const fixture = {
    async startDevServer() {
      server = await startPletivoDev({ cwd: fixtureRoot, label: testFileName });
      return {
        async stop() {
          if (server) {
            await server.stop();
            server = null;
          }
        },
      };
    },

    resolveUrl(p) {
      return `${origin()}${p}`;
    },

    async fetch(p) {
      return fetch(`${origin()}${p}`);
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
