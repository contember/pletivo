/**
 * Compiles a corpus of `.astro` files with one of the two hosts and prints a JSON
 * digest on stdout. Run once per host in its own process, then diff: the Go program
 * publishes itself on a single `globalThis` slot, so two instances in one process
 * would not be two independent compilers.
 *
 *   bun packages/workers/test/compile-corpus.ts --host=node    <root>...
 *   bun packages/workers/test/compile-corpus.ts --host=workers <root>...
 */

import path from "node:path";
import { readdir } from "node:fs/promises";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import type { TransformOptions, TransformResult } from "@astrojs/compiler/types";

type Transform = (source: string, options: TransformOptions) => Promise<TransformResult>;

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** The options pletivo's Bun host passes — see packages/pletivo/src/astro-plugin.ts. */
function transformOptions(filename: string): TransformOptions {
  return {
    filename,
    internalURL: "pletivo/astro-shim",
    sourcemap: false,
    resolvePath: async (specifier) => specifier,
  };
}

async function nodeHost(): Promise<Transform> {
  const { transform } = await import("@astrojs/compiler");
  return transform;
}

async function workersHost(): Promise<Transform> {
  const wasmPath = path.join(
    path.dirname(Bun.resolveSync("@astrojs/compiler/package.json", REPO_ROOT)),
    "dist/astro.wasm",
  );
  const wasm = new WebAssembly.Module(await Bun.file(wasmPath).arrayBuffer());
  const compiler = createAstroCompiler(wasm);
  return (source, options) => compiler.transform(source, options);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".astro", ".git"]);

/** Hand-rolled walk rather than a glob: the fixture trees contain self-referential symlinks. */
export async function collectAstroFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.name.endsWith(".astro")) {
        files.push(full);
      }
    }
  };
  for (const root of roots) await walk(path.resolve(root));
  return files.sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const host = args.find((a) => a.startsWith("--host="))?.slice("--host=".length);
  const roots = args.filter((a) => !a.startsWith("--"));
  if (host !== "node" && host !== "workers") throw new Error("--host=node|workers is required");
  if (roots.length === 0) throw new Error("at least one corpus root is required");

  const transform = host === "node" ? await nodeHost() : await workersHost();
  const out: Record<string, unknown> = {};

  for (const file of await collectAstroFiles(roots)) {
    const rel = path.relative(REPO_ROOT, file);
    const source = await Bun.file(file).text();
    try {
      const result = await transform(source, transformOptions(rel));
      out[rel] = {
        code: result.code,
        css: result.css,
        scope: result.scope,
        scripts: result.scripts,
        containsHead: result.containsHead,
        propagation: result.propagation,
        diagnostics: result.diagnostics.map((d) => `${d.severity}:${d.code}:${d.text}`),
      };
    } catch (error) {
      out[rel] = { failed: String(error) };
    }
  }

  process.stdout.write(JSON.stringify(out));
}
