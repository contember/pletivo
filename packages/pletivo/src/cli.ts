#!/usr/bin/env bun

import { build } from "./build";
import { dev } from "./dev";
import { isSupervisedChild, superviseDev } from "./dev-supervisor";
import { loadConfig } from "./config";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { version } = require_("../package.json");

const command = process.argv[2];
const projectRoot = process.cwd();

const config = await loadConfig(projectRoot);

// CLI arg overrides
const portArg = process.argv.find((a) => a.startsWith("--port="));
if (portArg) config.port = parseInt(portArg.split("=")[1], 10);
const portIdx = process.argv.indexOf("--port");
if (portIdx !== -1 && process.argv[portIdx + 1]) config.port = parseInt(process.argv[portIdx + 1], 10);
// Legacy positional port for `pletivo dev <port>`
if (command === "dev" && /^\d+$/.test(process.argv[3] || "")) {
  config.port = parseInt(process.argv[3], 10);
}
const hostArg = process.argv.find((a) => a.startsWith("--host="));
if (hostArg) config.host = hostArg.split("=")[1];
const hostIdx = process.argv.indexOf("--host");
if (hostIdx !== -1 && process.argv[hostIdx + 1] && !process.argv[hostIdx + 1].startsWith("--")) {
  config.host = process.argv[hostIdx + 1];
} else if (hostIdx !== -1 && (!process.argv[hostIdx + 1] || process.argv[hostIdx + 1].startsWith("--"))) {
  config.host = "0.0.0.0";
}

function readFlag(names: string[]): string | undefined {
  for (const name of names) {
    const eq = process.argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = process.argv.indexOf(name);
    if (idx !== -1) {
      const next = process.argv[idx + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return undefined;
}

function readBoolFlag(names: string[]): boolean {
  return names.some((n) => process.argv.includes(n));
}

// Custom 404 page. CLI > env > config.
const notFoundCli = readFlag(["--404-page", "--not-found-page"]);
if (notFoundCli) config.notFoundPage = notFoundCli;
else if (process.env.PLETIVO_404_PAGE) config.notFoundPage = process.env.PLETIVO_404_PAGE;

// Dev hybrid options. Merge on top of whatever came from the config file.
const errorPageCli = readFlag(["--error-page"]);
const staleCli = readBoolFlag(["--stale"]);
const debugHeaderCli = readFlag(["--debug-header"]);
if (errorPageCli || staleCli || debugHeaderCli ||
    process.env.PLETIVO_ERROR_PAGE || process.env.PLETIVO_STALE || process.env.PLETIVO_DEBUG_HEADER) {
  config.dev = { ...config.dev };
  if (errorPageCli) config.dev.errorPage = errorPageCli;
  else if (process.env.PLETIVO_ERROR_PAGE) config.dev.errorPage = process.env.PLETIVO_ERROR_PAGE;
  if (staleCli) config.dev.stale = true;
  else if (process.env.PLETIVO_STALE && process.env.PLETIVO_STALE !== "0" && process.env.PLETIVO_STALE !== "") {
    config.dev.stale = true;
  }
  if (debugHeaderCli) config.dev.debugHeader = debugHeaderCli;
  else if (process.env.PLETIVO_DEBUG_HEADER) config.dev.debugHeader = process.env.PLETIVO_DEBUG_HEADER;
}

switch (command) {
  case "build": {
    const incremental = process.argv.includes("--incremental");
    const clean = process.argv.includes("--clean");
    await build(projectRoot, config, { incremental, clean });
    break;
  }

  case "prepare": {
    // The config/integration phase, run once where a filesystem and npm exist. What
    // comes out is what `@pletivo/workers` renders with — see packages/pletivo/src/prepare.
    const { prepare } = await import("./prepare/index");
    const { emitArtifact } = await import("./prepare/emit");
    const outDir = readFlag(["--out"]) ?? ".pletivo";
    const prepared = await prepare(projectRoot);
    const written = await emitArtifact(
      outDir.startsWith("/") ? outDir : `${projectRoot}/${outDir}`,
      prepared,
    );
    const counts = [
      `${Object.keys(prepared.artifact.vendor).length} vendored specifier(s)`,
      `${Object.keys(prepared.artifact.virtualModules).length} frozen virtual module(s)`,
      `${Object.keys(prepared.artifact.generatedSources).length} carried source(s)`,
    ];
    console.log(`  artifact ${prepared.artifact.id}`);
    for (const line of counts) console.log(`    ${line}`);
    console.log(`    ${(written.moduleBytes / 1024).toFixed(1)} kB of modules → ${written.modulePath}`);
    for (const diagnostic of prepared.artifact.diagnostics) {
      console.warn(`  ⚠ ${diagnostic.source} (${diagnostic.hook}): ${diagnostic.reason}`);
    }
    break;
  }

  case "dev":
    // The parent supervises, the child serves. `--no-restart` opts out of both,
    // which also switches the config watcher off — nothing would restart it.
    if (!isSupervisedChild() && !process.argv.includes("--no-restart")) {
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
