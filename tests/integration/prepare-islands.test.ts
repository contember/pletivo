import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ISLANDS_BUNDLE_MODULE_PREFIX, parsePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
import { createIslandClientUrls } from "@pletivo/core/island-urls";

/**
 * `pletivo prepare` for a project with a framework renderer: what the islands bundle may import,
 * and which project files it owns. Each project prepares in a CLI process of its own: under
 * `bun test`, a second islands `Bun.build` in one process fails reading package files (EISDIR).
 */

const CLI = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const REPO_NODE_MODULES = path.resolve(import.meta.dir, "../../node_modules");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true })));
});

const PAGE = `---
import { Counter } from "../components/Counter";
---
<html lang="en"><head><title>React</title></head><body><Counter start={1} client:load /></body></html>
`;

/** A React project in a temporary repository, its packages the workspace's own. */
async function reactProject(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-prepare-islands-"));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, ".git"));
  await fs.symlink(REPO_NODE_MODULES, path.join(directory, "node_modules"));
  const all: Record<string, string> = {
    "astro.config.mjs": 'import react from "@astrojs/react";\nexport default { integrations: [react()] };\n',
    "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" } }\n',
    "src/pages/index.astro": PAGE,
    ...files,
  };
  for (const [file, source] of Object.entries(all)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), source);
  }
  return directory;
}

async function runPrepare(root: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bun", CLI, "prepare", "--out", "out"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

async function prepare(root: string): Promise<PreparedSite> {
  const { code, output } = await runPrepare(root);
  if (code !== 0) throw new Error(`prepare failed:\n${output}`);
  return parsePreparedSite(JSON.parse(await fs.readFile(path.join(root, "out/pletivo-artifact.json"), "utf8")));
}

/** The refusal prepare printed. */
async function prepareError(root: string): Promise<string> {
  const { code, output } = await runPrepare(root);
  expect(code).not.toBe(0);
  return output;
}

function bundleExternals(site: PreparedSite): string[] {
  const externals = new Set<string>();
  for (const { importer, target } of site.artifact.resolutions) {
    if (importer.startsWith(ISLANDS_BUNDLE_MODULE_PREFIX) && target.kind === "external") externals.add(target.specifier);
  }
  return [...externals].sort();
}

function digest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

describe("pletivo prepare, framework islands", () => {
  test("refuses a component that imports a Node built-in the Workers host does not give it, naming the component", async () => {
    const root = await reactProject({
      "src/components/Counter.jsx":
        'import { readFileSync } from "node:fs";\nexport function Counter() { return <b>{typeof readFileSync}</b>; }\n',
    });
    expect(await prepareError(root)).toContain('src/components/Counter.jsx (islands): imports the Node built-in "node:fs"');
  });

  test("refuses a bare or dynamically imported built-in the same way", async () => {
    const bare = await reactProject({
      "src/components/Counter.jsx": 'import os from "os";\nexport function Counter() { return <b>{os.EOL}</b>; }\n',
    });
    expect(await prepareError(bare)).toContain('src/components/Counter.jsx (islands): imports the Node built-in "os"');
    const dynamic = await reactProject({
      "src/components/Counter.jsx":
        'export function Counter() { void import("node:child_process"); return <b />; }\n',
    });
    expect(await prepareError(dynamic)).toContain(
      'src/components/Counter.jsx (islands): imports the Node built-in "node:child_process"',
    );
  });

  test("refuses an allowed built-in by its bare name or through require(), naming the importer", async () => {
    const bare = await reactProject({
      "src/components/Counter.jsx":
        'import { createHash } from "crypto";\nexport function Counter() { return <b>{typeof createHash}</b>; }\n',
    });
    expect(await prepareError(bare)).toContain(
      'src/components/Counter.jsx (islands): imports the Node built-in "crypto"',
    );
    const required = await reactProject({
      "src/components/Counter.jsx":
        'const crypto = require("node:crypto");\nexport function Counter() { return <b>{typeof crypto}</b>; }\n',
    });
    expect(await prepareError(required)).toContain(
      'src/components/Counter.jsx (islands): requires the Node built-in "node:crypto"',
    );
    const requiredBare = await reactProject({
      "src/components/Counter.jsx":
        'const crypto = require("crypto");\nexport function Counter() { return <b>{typeof crypto}</b>; }\n',
    });
    expect(await prepareError(requiredBare)).toContain(
      'src/components/Counter.jsx (islands): requires the Node built-in "crypto"',
    );
  });

  test("keeps node:async_hooks and node:crypto as imports the bundle runs with", async () => {
    const root = await reactProject({
      "src/components/Counter.jsx": [
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'import { createHash } from "node:crypto";',
        'export const digest = createHash("sha256").update("x").digest("hex");',
        "export const storage = new AsyncLocalStorage().run(1, () => 2);",
        'export const lazy = async () => typeof (await import("node:crypto")).webcrypto;',
        "export function Counter() { return <b>{digest}</b>; }",
        "",
      ].join("\n"),
    });
    const site = await prepare(root);
    expect(bundleExternals(site)).toEqual(["node:async_hooks", "node:crypto"]);
    const bundle = site.artifact.modules.filter((module) => module.id.startsWith(ISLANDS_BUNDLE_MODULE_PREFIX));
    // Neither stubbed to `{}` nor polyfilled by the browser target.
    expect(bundle.some((module) => module.source.includes("crypto-browserify"))).toBe(false);

    // And the bundle loads: every binding the component imported is live.
    const directory = path.join(root, "bundle");
    await fs.mkdir(directory);
    for (const module of bundle) {
      await fs.writeFile(path.join(directory, module.id.slice(module.id.indexOf("/") + 1)), module.source);
    }
    const component = site.artifact.islands?.components[0]?.module ?? "";
    const entry = path.join(directory, component.slice(component.indexOf("/") + 1));
    const child = Bun.spawn(
      ["bun", "-e", `const m = await import(${JSON.stringify(entry)}); console.log(JSON.stringify([m.digest, m.storage, await m.lazy(), typeof m.Counter]));`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([createHash("sha256").update("x").digest("hex"), 2, "object", "function"]);
  });

  test("carries client modules for each component an .astro hydrates, and none for a claimed one it does not", async () => {
    const root = await reactProject({
      "src/components/Counter.jsx": "export function Counter({ start }) { return <b>{start}</b>; }\n",
      "src/components/Other.jsx": "export default function Other() { return <i>other</i>; }\n",
    });
    const site = await prepare(root);
    const islands = site.artifact.islands;
    if (islands === undefined) throw new Error("no islands");
    // As the page spells the import: without the extension.
    const counter = createIslandClientUrls({ projectRoot: islands.projectRoot, base: "/" }).component(
      `${islands.projectRoot}/src/components/Counter`,
      "Counter",
    );
    const urls = islands.clients.map((client) => client.url);
    expect(urls).toContain(counter);
    expect(urls.filter((url) => url.startsWith("/_astro/Other."))).toEqual([]);
    expect(islands.components.map((component) => component.file).sort()).toEqual(["src/components/Counter.jsx", "src/components/Other.jsx"]);
    expect(islands.clients.find((client) => client.url === counter)?.sources).toEqual(["src/components/Counter.jsx"]);
    const paths = (site.inputs ?? []).map((input) => input.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("records a file the project and the bundle both read once", async () => {
    const root = await reactProject({
      "package.json": '{ "name": "site", "version": "1.2.3" }\n',
      "src/components/Counter.jsx":
        'import pkg from "../../package.json";\nexport function Counter() { return <b>{pkg.version}</b>; }\n',
    });
    const site = await prepare(root);
    expect((site.inputs ?? []).filter((input) => input.path === "package.json")).toEqual([
      { path: "package.json", digest: digest('{ "name": "site", "version": "1.2.3" }\n') },
    ]);
  });

  test("keeps a helper only components import out of the vendor graph, and records what the bundle read", async () => {
    const counter =
      'import { useCount } from "../hooks/useCount";\nexport function Counter({ start }) { const [n] = useCount(start); return <b>{n}</b>; }\n';
    const hook = 'import { useState } from "react";\nexport function useCount(start: number) { return useState(start); }\n';
    const root = await reactProject({ "src/components/Counter.jsx": counter, "src/hooks/useCount.ts": hook });
    const site = await prepare(root);
    const importers = new Set(site.artifact.resolutions.map((resolution) => resolution.importer));
    expect(importers.has("project:src/hooks/useCount.ts")).toBe(false);
    // Editing either one needs a new prepare, so the host reports the artifact stale.
    expect(site.inputs).toContainEqual({ path: "src/components/Counter.jsx", digest: digest(counter) });
    expect(site.inputs).toContainEqual({ path: "src/hooks/useCount.ts", digest: digest(hook) });
    const paths = (site.inputs ?? []).map((input) => input.path);
    expect(paths).toEqual([...paths].sort());
  });

  test("refuses, by name, only the shared helper whose live copy cannot be carried", async () => {
    const root = await reactProject({
      "src/components/Counter.jsx":
        'import { a } from "../lib/a";\nimport { b } from "../lib/b";\nexport function Counter() { return <b>{a}{b}</b>; }\n',
      // React is CommonJS, which the live graph cannot carry; Preact is ESM, which it can.
      "src/lib/a.ts": 'import { useState } from "react";\nexport const a = typeof useState;\n',
      "src/lib/b.ts": 'import { h } from "preact";\nexport const b = typeof h;\n',
      "src/pages/index.astro": `---\nimport { Counter } from "../components/Counter";\nimport { a } from "../lib/a";\nimport { b } from "../lib/b";\n---\n<Counter client:load /><p>{a}{b}</p>\n`,
    });
    const output = await prepareError(root);
    expect(output).toContain(
      "src/lib/a.ts (islands): framework components and the project's live modules both import it",
    );
    expect(output).not.toContain("src/lib/b.ts (islands)");
  });
});
