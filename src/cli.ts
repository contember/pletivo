#!/usr/bin/env bun

import { build } from "./build";
import { dev } from "./dev";

const command = process.argv[2];
const projectRoot = process.cwd();

switch (command) {
  case "build":
    await build(projectRoot);
    break;

  case "dev": {
    const port = parseInt(process.argv[3] || "3000", 10);
    await dev(projectRoot, port);
    break;
  }

  default:
    console.log(`
  pavouk - static site generator

  Usage:
    pavouk build    Build static site to dist/
    pavouk dev      Start dev server with HMR
`);
}
