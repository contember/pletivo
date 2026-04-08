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
// Legacy positional port for `pavouk dev <port>`
if (command === "dev" && /^\d+$/.test(process.argv[3] || "")) {
  config.port = parseInt(process.argv[3], 10);
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
  pavouk v0.1.0 — static site generator

  Usage:
    pavouk build              Build static site
    pavouk dev [--port=3000]  Start dev server with HMR

  Options:
    --port=<number>  Dev server port (default: 3000)
    --help           Show this help

  Config:
    Create pavouk.config.ts to customize:

      import { defineConfig } from "pavouk";
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
