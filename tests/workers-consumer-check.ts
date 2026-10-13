#!/usr/bin/env bun

/**
 * Installs the staged @pletivo/runtime, core and workers tarballs into an empty
 * npm project and uses them the way a host Worker does: typecheck every published
 * module against workerd's types, then bundle the README's host with wrangler.
 * The workspace hoists everything, so only a fresh install shows a manifest that
 * leaves a module or a dependency behind.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIBRARY_PACKAGES, readJson, sourceFiles } from "../scripts/package-pletivo";
import { MIN_TYPESCRIPT, requireSuccess, run } from "./consumer-support";

interface StagedTarball {
  name: string;
  version: string;
  tarball: string;
}

function tarballArguments(args: readonly string[]): string[] {
  const tarballs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    let value: string | undefined;
    if (argument === "--tarball") {
      index++;
      value = args[index];
    }
    else if (argument.startsWith("--tarball=")) value = argument.slice("--tarball=".length);
    else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    if (!value || !path.isAbsolute(value)) {
      throw new Error("usage: workers-consumer-check --tarball <absolute-path> [--tarball <absolute-path> ...]");
    }
    tarballs.push(value);
  }
  return tarballs;
}

function stringField(manifest: object, field: string, label: string): string {
  const value: unknown = Reflect.get(manifest, field);
  if (typeof value !== "string" || value === "") throw new Error(`${label} has no ${field}`);
  return value;
}

function parseJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

/** One tarball per library package, all of the same version. */
function readTarballs(tarballs: readonly string[]): StagedTarball[] {
  const staged: StagedTarball[] = [];
  for (const tarball of tarballs) {
    const extracted = run(["tar", "-xOzf", tarball, "package/package.json"], path.dirname(tarball));
    requireSuccess(`reading the manifest of ${tarball}`, extracted);
    const manifest = parseJsonObject(extracted.output, tarball);
    staged.push({
      name: stringField(manifest, "name", tarball),
      version: stringField(manifest, "version", tarball),
      tarball,
    });
  }
  const expected = LIBRARY_PACKAGES.map((library) => library.name).sort();
  const received = staged.map((entry) => entry.name).sort();
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error(`expected tarballs for ${expected.join(", ")}, got ${received.join(", ")}`);
  }
  const versions = new Set(staged.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error(`tarballs disagree on the version: ${[...versions].join(", ")}`);
  return staged;
}

/** The exact version the repository's own Workers checks ran with. */
async function workspaceToolVersion(name: string): Promise<string> {
  const workers = LIBRARY_PACKAGES.find((library) => library.name === "@pletivo/workers");
  if (workers === undefined) throw new Error("@pletivo/workers is not a library package");
  const manifest = await readJson(Bun.resolveSync(`${name}/package.json`, workers.directory));
  return stringField(manifest, "version", name);
}

/** The README is the documented way in; checking its snippets keeps it honest. */
function fencedBlock(readme: string, language: string): string {
  const match = new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```").exec(readme);
  if (!match) throw new Error(`@pletivo/workers README has no \`\`\`${language} block`);
  return match[1];
}

async function writeConsumer(project: string, staged: readonly StagedTarball[]): Promise<void> {
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  const dependencies: Record<string, string> = {};
  for (const entry of staged) dependencies[entry.name] = `file:${entry.tarball}`;
  await fs.writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({
      name: "pletivo-workers-consumer",
      private: true,
      type: "module",
      dependencies,
      devDependencies: {
        typescript: MIN_TYPESCRIPT,
        "@types/node": "^22",
        "@cloudflare/workers-types": await workspaceToolVersion("@cloudflare/workers-types"),
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        module: "ESNext",
        moduleResolution: "bundler",
        target: "ESNext",
        lib: ["ESNext"],
        types: ["@cloudflare/workers-types", "node"],
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ["src"],
    }, null, 2)}\n`,
  );
}

async function assertInstalledShape(project: string, staged: readonly StagedTarball[]): Promise<void> {
  for (const entry of staged) {
    const packageRoot = path.join(project, "node_modules", entry.name);
    const manifest = await readJson(path.join(packageRoot, "package.json"));
    if (Reflect.get(manifest, "version") !== entry.version) {
      throw new Error(`${entry.name} installed at a different version than its tarball`);
    }
    if (Reflect.get(manifest, "scripts") !== undefined) {
      throw new Error(`${entry.name} published its workspace scripts`);
    }
    const dependencies: unknown = Reflect.get(manifest, "dependencies");
    if (JSON.stringify(dependencies).includes("workspace:")) {
      throw new Error(`${entry.name} published a workspace: range: ${JSON.stringify(dependencies)}`);
    }
    if (typeof dependencies === "object" && dependencies !== null) {
      for (const [name, range] of Object.entries(dependencies)) {
        if (name.startsWith("@pletivo/") && range !== entry.version) {
          throw new Error(`${entry.name} depends on ${name}@${String(range)}, not the lockstep ${entry.version}`);
        }
      }
    }
    // A nested copy would give runtime modules holding process-global state a second module record.
    try {
      await fs.access(path.join(packageRoot, "node_modules/@pletivo"));
      throw new Error(`${entry.name} installed its own copy of an @pletivo package`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("its own copy")) throw error;
    }
  }
}

/** Every published module, imported through the package's `exports` map. */
async function writeAllModulesEntry(project: string, staged: readonly StagedTarball[]): Promise<number> {
  const imports: string[] = [];
  for (const entry of staged) {
    const sourceRoot = path.join(project, "node_modules", entry.name, "src");
    for (const file of await sourceFiles(sourceRoot)) {
      if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
      const subpath = path.relative(sourceRoot, file).split(path.sep).join("/").slice(0, -".ts".length);
      imports.push(`import ${JSON.stringify(`${entry.name}/${subpath}`)};`);
    }
  }
  await fs.writeFile(path.join(project, "src/all-modules.ts"), `${imports.join("\n")}\n`);
  return imports.length;
}

async function writeReadmeHost(project: string): Promise<void> {
  const readme = await fs.readFile(path.join(project, "node_modules/@pletivo/workers/README.md"), "utf8");
  await fs.writeFile(path.join(project, "src/index.ts"), `${fencedBlock(readme, "ts")}\n`);
  const config = fencedBlock(readme, "jsonc").replace(
    /^\{/,
    '{\n  "name": "pletivo-workers-consumer",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-01-01",',
  );
  await fs.writeFile(path.join(project, "wrangler.jsonc"), `${config}\n`);
}

/** Run outside the consumer's dependencies: wrangler's optional peer pins an older workers-types major. */
async function assertBundled(project: string): Promise<void> {
  const output = path.join(project, "bundle");
  const wrangler = `wrangler@${await workspaceToolVersion("wrangler")}`;
  requireSuccess(
    "wrangler bundle of the README host",
    run(
      ["npm", "exec", "--yes", `--package=${wrangler}`, "--", "wrangler", "deploy", "--dry-run", "--outdir", output],
      project,
      { WRANGLER_SEND_METRICS: "false" },
    ),
  );
  const files = await fs.readdir(output);
  if (!files.includes("index.js")) throw new Error("wrangler emitted no index.js");
  if (!files.some((file) => file.endsWith("astro.wasm"))) {
    throw new Error("wrangler did not carry astro.wasm as a compiled module");
  }
}

const staged = readTarballs(tarballArguments(process.argv.slice(2)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-workers-consumer-"));
const project = path.join(temporary, "project");
try {
  await writeConsumer(project, staged);
  requireSuccess(
    "npm consumer install",
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], project),
  );
  await assertInstalledShape(project, staged);
  const modules = await writeAllModulesEntry(project, staged);
  await writeReadmeHost(project);
  requireSuccess(
    `consumer TypeScript ${MIN_TYPESCRIPT} check`,
    run(["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"], project),
  );
  await assertBundled(project);
  console.log(`OK: ${staged.map((entry) => `${entry.name}@${entry.version}`).join(", ")} passed the Worker consumer gate (${modules} modules)`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
