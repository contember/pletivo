#!/usr/bin/env bun

import { build } from "./build";
import { dev } from "./dev";
import { loadConfig } from "./config";

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

switch (command) {
  case "build":
    await build(projectRoot, config);
    break;

  case "dev":
    await dev(projectRoot, config);
    break;

  case "--help":
  case "-h":
  case "help":
  default:
    console.log(`
  pletivo v0.1.0 — static site generator

  Usage:
    pletivo build              Build static site
    pletivo dev [--port=3000] [--host]  Start dev server with HMR

  Options:
    --port=<number>  Dev server port (default: 3000)
    --host[=<addr>]  Dev server host (default: localhost, bare --host = 0.0.0.0)
    --help           Show this help

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
