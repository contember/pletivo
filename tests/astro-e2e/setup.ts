#!/usr/bin/env bun
/**
 * Setup script for Astro compatibility tests.
 *
 * Clones the Astro repo (shallow, specific tag), copies selected fixtures
 * and test files, and patches them to run through pletivo instead of Astro.
 *
 * Usage:
 *   bun run tests/astro-e2e/setup.ts
 *   # or
 *   cd tests/astro-e2e && bun run setup.ts
 */

import { $ } from "bun";
import path from "node:path";
import fs from "node:fs";
import {
  ASTRO_REPO,
  ASTRO_REF,
  e2eEntries,
  integrationEntries,
  type FixtureEntry,
} from "./manifest";

const ROOT = import.meta.dirname;
const CACHE_DIR = path.join(ROOT, ".cache");
const ASTRO_DIR = path.join(CACHE_DIR, "astro");
const OVERLAYS_DIR = path.join(ROOT, "overlays");

// E2E output dirs (Playwright browser tests)
const E2E_FIXTURES_DIR = path.join(ROOT, "fixtures");
const E2E_TESTS_DIR = path.join(ROOT, "tests");

// Integration output dirs (node:test + cheerio build tests)
const INT_FIXTURES_DIR = path.join(ROOT, "integration-fixtures");
const INT_TESTS_DIR = path.join(ROOT, "integration");

const REF_MARKER = path.join(CACHE_DIR, ".astro-ref");

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

async function cloneAstro() {
  const cachedRef = fs.existsSync(REF_MARKER)
    ? fs.readFileSync(REF_MARKER, "utf-8").trim()
    : null;

  if (cachedRef === ASTRO_REF && fs.existsSync(path.join(ASTRO_DIR, ".git"))) {
    console.log(`Using cached Astro repo at .cache/astro (${ASTRO_REF})`);
    return;
  }

  if (fs.existsSync(ASTRO_DIR)) {
    console.log(
      `Cached ref ${cachedRef || "none"} != ${ASTRO_REF}, re-cloning...`,
    );
    fs.rmSync(ASTRO_DIR, { recursive: true, force: true });
  }

  console.log(`Cloning ${ASTRO_REPO} at ${ASTRO_REF}...`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  await $`git clone --depth 1 --branch ${ASTRO_REF} ${ASTRO_REPO} ${ASTRO_DIR}`;
  fs.writeFileSync(REF_MARKER, ASTRO_REF + "\n");
  console.log(`  Done.`);
}

// ---------------------------------------------------------------------------
// Fixture + test copying
// ---------------------------------------------------------------------------

function copyFixture(
  entry: FixtureEntry,
  srcFixturesDir: string,
  dstFixturesDir: string,
) {
  const srcFixture = path.join(srcFixturesDir, entry.fixture);
  if (!fs.existsSync(srcFixture)) {
    throw new Error(
      `Fixture not found: ${srcFixture}\nAvailable: ${fs.readdirSync(srcFixturesDir).join(", ")}`,
    );
  }

  const dstFixture = path.join(dstFixturesDir, entry.fixture);
  fs.cpSync(srcFixture, dstFixture, { recursive: true });

  // Rewrite package.json — strip astro workspace deps, keep extras
  const pkgJsonPath = path.join(dstFixture, "package.json");
  const pkg: Record<string, unknown> = {
    name: `@pletivo-compat/${entry.name}`,
    private: true,
  };
  if (entry.extraDeps && Object.keys(entry.extraDeps).length > 0) {
    pkg.dependencies = entry.extraDeps;
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  // Apply overlay files (committed overrides on top of cloned fixture)
  const overlayDir = path.join(OVERLAYS_DIR, entry.fixture);
  if (fs.existsSync(overlayDir)) {
    fs.cpSync(overlayDir, dstFixture, { recursive: true });
    console.log(`  Applied overlay from overlays/${entry.fixture}/`);
  }

  // Remove files listed in removeFiles
  if (entry.removeFiles) {
    for (const file of entry.removeFiles) {
      const target = path.join(dstFixture, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
      }
    }
    console.log(`  Removed ${entry.removeFiles.length} files`);
  }

  return dstFixture;
}

function copyTestFile(
  entry: FixtureEntry,
  srcDir: string,
  dstDir: string,
  testUtilsImport: string,
  fixtureRootPrefix: string,
) {
  if (entry.testFile === null) return;
  const srcTest = path.join(srcDir, entry.testFile);
  if (!fs.existsSync(srcTest)) {
    throw new Error(`Test file not found: ${srcTest}`);
  }

  let content = fs.readFileSync(srcTest, "utf-8");

  // Patch: use our test-utils instead of Astro's
  content = content.replace(
    /from\s+['"]\.\/test-utils\.js['"]/g,
    `from '${testUtilsImport}'`,
  );

  // Patch: fixture root paths
  content = content.replace(
    /root:\s*['"]\.\/fixtures\//g,
    `root: '${fixtureRootPrefix}`,
  );

  // Apply custom patches from manifest
  if (entry.testPatches) {
    for (const patch of entry.testPatches) {
      content = content.replace(patch.search, patch.replace);
    }
  }

  const dstTest = path.join(dstDir, entry.testFile);
  fs.writeFileSync(dstTest, content);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Astro Compatibility Test Setup ===\n");

  // 1. Clone astro
  await cloneAstro();

  const astroE2eDir = path.join(ASTRO_DIR, "packages", "astro", "e2e");
  const astroTestDir = path.join(ASTRO_DIR, "packages", "astro", "test");

  // 2. Clean and recreate output directories
  for (const dir of [
    E2E_FIXTURES_DIR,
    E2E_TESTS_DIR,
    INT_FIXTURES_DIR,
    INT_TESTS_DIR,
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  // 3. Copy shared _deps from e2e fixtures (if any e2e entries)
  if (e2eEntries.length > 0) {
    const srcDeps = path.join(astroE2eDir, "fixtures", "_deps");
    const dstDeps = path.join(E2E_FIXTURES_DIR, "_deps");
    if (fs.existsSync(srcDeps)) {
      fs.cpSync(srcDeps, dstDeps, { recursive: true });
      for (const dep of fs.readdirSync(dstDeps)) {
        const depPkg = path.join(dstDeps, dep, "package.json");
        if (fs.existsSync(depPkg)) {
          const pkg = JSON.parse(fs.readFileSync(depPkg, "utf-8"));
          delete pkg.dependencies?.astro;
          delete pkg.devDependencies?.astro;
          fs.writeFileSync(depPkg, JSON.stringify(pkg, null, 2) + "\n");
        }
      }
      console.log(`Copied shared e2e _deps/`);
    }
  }

  // 4. Process e2e entries
  if (e2eEntries.length > 0) {
    console.log(`\n--- E2E tests (Playwright) ---`);
    for (const entry of e2eEntries) {
      console.log(`\n  ${entry.name}`);
      copyFixture(entry, path.join(astroE2eDir, "fixtures"), E2E_FIXTURES_DIR);
      copyTestFile(
        entry,
        astroE2eDir,
        E2E_TESTS_DIR,
        "../test-utils.js",
        "../fixtures/",
      );
      console.log(`    → fixtures/${entry.fixture}/ + tests/${entry.testFile}`);
    }
  }

  // 5. Process integration entries
  if (integrationEntries.length > 0) {
    console.log(`\n--- Integration tests (node:test + cheerio) ---`);
    for (const entry of integrationEntries) {
      console.log(`\n  ${entry.name}`);
      copyFixture(
        entry,
        path.join(astroTestDir, "fixtures"),
        INT_FIXTURES_DIR,
      );
      copyTestFile(
        entry,
        astroTestDir,
        INT_TESTS_DIR,
        "../integration-test-utils.js",
        "./integration-fixtures/",
      );
      if (entry.testFile === null) {
        console.log(`    → integration-fixtures/${entry.fixture}/ (fixture-only)`);
      } else {
        console.log(
          `    → integration-fixtures/${entry.fixture}/ + integration/${entry.testFile}`,
        );
      }
    }
  }

  // 6. Summary
  const total = e2eEntries.length + integrationEntries.length;
  console.log(`\n=== Setup complete ===`);
  console.log(`  E2E fixtures:         ${e2eEntries.length}`);
  console.log(`  Integration fixtures:  ${integrationEntries.length}`);
  console.log(`  Total:                 ${total}`);
  console.log(`\nRun:`);
  console.log(`  cd tests/astro-e2e && bun install`);
  console.log(`  npm run test:integration     # build output tests`);
  console.log(`  npm run test:e2e             # browser tests (needs playwright)`);
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
