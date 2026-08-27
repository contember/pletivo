#!/usr/bin/env bun

import { build } from "./build";
import { dev } from "./dev";
import { isSupervisedChild, superviseDev } from "./dev-supervisor";
import { loadConfig } from "./config";
import { applyCliOverrides, readArgvOptions } from "./cli-args";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { version } = require_("../package.json");

const { command, incremental, clean, noRestart } = readArgvOptions(process.argv);
const projectRoot = process.cwd();

let config;
try {
  config = applyCliOverrides(await loadConfig(projectRoot), process.argv, process.env);
} catch (error) {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

switch (command) {
  case "build":
    await build(projectRoot, config, { incremental, clean });
    break;

  case "prepare": {
    // The config/integration phase, run once where a filesystem and npm exist. What
    // comes out is what `@pletivo/workers` renders with — see packages/pletivo/src/prepare.
    const { prepare, PrepareError } = await import("./prepare/index");
    const { emitArtifact } = await import("./prepare/emit");
    const outDir = readFlag(["--out"]) ?? ".pletivo";
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(projectRoot);
    } catch (error) {
      if (!(error instanceof PrepareError)) throw error;
      for (const diagnostic of error.report.diagnostics) {
        console.error(
          `  ✗ ${diagnostic.source} (${diagnostic.hook}): ${diagnostic.reason}`,
        );
      }
      process.exitCode = 1;
      break;
    }
    const written = await emitArtifact(
      outDir.startsWith("/") ? outDir : `${projectRoot}/${outDir}`,
      prepared.site,
    );
    const virtualCount = prepared.site.artifact.modules.filter((module) =>
      module.id.startsWith("virtual:"),
    ).length;
    console.log(`  artifact v${prepared.site.artifact.version}`);
    console.log(`    ${prepared.site.artifact.modules.length} carried module(s)`);
    console.log(`    ${prepared.site.artifact.resolutions.length} frozen resolution(s)`);
    console.log(`    ${virtualCount} frozen virtual module(s)`);
    console.log(`    ${(written.moduleBytes / 1024).toFixed(1)} kB of modules → ${written.modulePath}`);
    for (const diagnostic of prepared.report.diagnostics) {
      console.warn(`  ⚠ ${diagnostic.source} (${diagnostic.hook}): ${diagnostic.reason}`);
    }
    break;
  }

  case "dev":
    // The parent supervises, the child serves. `--no-restart` opts out of both,
    // which also switches the config watcher off — nothing would restart it.
    if (!isSupervisedChild() && !noRestart) {
      process.exit(await superviseDev());
    }
    await dev(projectRoot, config);
    break;

  case "--help":
  case "-h":
  case "help":
  default:
    console.log(`
  pletivo v${version} — static site generator

  Usage:
    pletivo build [--incremental] [--clean]  Build static site (full rebuild by default)
    pletivo dev [--port=3000] [--host]       Start dev server with HMR
    pletivo prepare [--out=.pletivo]         Freeze astro.config + integrations + npm
                                             into a site artifact for @pletivo/workers

  Options:
    --incremental            Reuse the build cache to skip unchanged pages (off by default)
    --clean                  Wipe node_modules/.pletivo/cache, then build incrementally
    --port=<number>          Dev server port (default: 3000)
    --host[=<addr>]          Dev server host (default: localhost, bare --host = 0.0.0.0)
    --404-page=<path>        Custom 404 page (overrides pages/404.{tsx,jsx,astro})
    --error-page=<path>      Page shown when a render fails (replaces raw stack trace)
    --stale                  Serve last-good snapshot per route on render failure
    --debug-header=<name>    Requests with this header see raw errors + HMR instead of
                             the error-page / snapshot fallback (default: x-pletivo-debug)
    --no-restart             Do not supervise the dev server: no restart when a config
                             file changes, no backed-off restart after a crash
    --help                   Show this help

  Env vars: PLETIVO_404_PAGE, PLETIVO_ERROR_PAGE, PLETIVO_STALE=1,
            PLETIVO_DEBUG_HEADER, PLETIVO_IMAGE_SERVICE=sharp|passthrough|cloudflare

  Config:
    Create pletivo.config.ts to customize:

      import { defineConfig } from "pletivo";
      export default defineConfig({
        outDir: "dist",
        port: 3000,
        base: "/",
        srcDir: "src",
        publicDir: "public",
      });
`);
    if (command && command !== "--help" && command !== "-h" && command !== "help") {
      console.error(`  Unknown command: ${command}\n`);
      process.exit(1);
    }
}
