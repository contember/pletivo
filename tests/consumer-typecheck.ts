#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actualModuleSpecifiers } from "../scripts/package-pletivo";

const MIN_TYPESCRIPT = "5.7.3";

interface CommandResult {
  ok: boolean;
  output: string;
}

function run(command: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function requireSuccess(label: string, result: CommandResult): void {
  if (!result.ok) throw new Error(`${label} failed:\n${result.output}`);
}

function tarballArgument(args: readonly string[]): string {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--tarball") {
      index++;
      value = args[index];
    }
    else if (argument.startsWith("--tarball=")) value = argument.slice("--tarball=".length);
    else if (index === 0 && !argument.startsWith("--")) value = argument;
    else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!value || !path.isAbsolute(value)) {
    throw new Error("usage: consumer-typecheck --tarball <absolute-path>");
  }
  return value;
}

async function readObject(file: string): Promise<object> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return parsed;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  }
  return files.sort();
}

async function assertInstalledShape(project: string): Promise<object> {
  const packageRoot = path.join(project, "node_modules/pletivo");
  const manifest = await readObject(path.join(packageRoot, "package.json"));
  const dependencies: unknown = Reflect.get(manifest, "dependencies");
  const dependencyText = JSON.stringify(dependencies);
  if (dependencyText.includes("workspace:") || dependencyText.includes("@pletivo/")) {
    throw new Error(`published dependencies retain an internal package: ${dependencyText}`);
  }
  try {
    await fs.access(path.join(project, "node_modules/@pletivo"));
    throw new Error("consumer installed an @pletivo internal package");
  } catch (error) {
    if (error instanceof Error && error.message.includes("consumer installed")) throw error;
  }

  const violations: string[] = [];
  for (const file of await sourceFiles(path.join(packageRoot, "src"))) {
    const source = await fs.readFile(file, "utf8");
    for (const specifier of actualModuleSpecifiers(file, source)) {
      if (specifier === "@pletivo/core" || specifier.startsWith("@pletivo/core/") ||
          specifier === "@pletivo/runtime" || specifier.startsWith("@pletivo/runtime/")) {
        violations.push(`${path.relative(packageRoot, file)}: ${specifier}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`published source retains internal imports:\n${violations.join("\n")}`);
  }
  return manifest;
}

async function writeConsumer(project: string, tarball: string): Promise<void> {
  await fs.mkdir(path.join(project, "src/pages"), { recursive: true });
  await fs.writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({
      name: "pletivo-package-consumer",
      private: true,
      type: "module",
      dependencies: {
        pletivo: `file:${tarball}`,
        preact: "^10.29.1",
      },
      devDependencies: { typescript: MIN_TYPESCRIPT },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "pletivo",
        strict: true,
        skipLibCheck: true,
        module: "ESNext",
        moduleResolution: "bundler",
        target: "ESNext",
        noEmit: true,
      },
      include: ["src"],
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, "src/pages/index.tsx"),
    `import { defineConfig } from "pletivo";
import { defineCollection, z } from "pletivo/content";

export const config = defineConfig({ srcDir: "src" });
export const collections = {
  posts: defineCollection({ schema: z.object({ title: z.string() }) }),
};

export default function Page() {
  return <main class="consumer-smoke">packaged pletivo</main>;
}
`,
  );
}

async function assertRuntimeIdentity(project: string): Promise<void> {
  const packageRoot = path.join(project, "node_modules/pletivo");
  const canonical = path.join(packageRoot, "src/_internal/runtime/jsx-runtime.ts");
  const duplicateRoot = path.join(project, "duplicate-runtime");
  await fs.cp(path.join(packageRoot, "src/_internal/runtime"), duplicateRoot, { recursive: true });
  const identityScript = path.join(project, "identity-check.ts");
  await fs.writeFile(
    identityScript,
    `import * as publicRuntime from "pletivo/jsx-runtime";
import * as canonicalRuntime from ${JSON.stringify(pathToFileURL(canonical).href)};
import * as duplicateRuntime from ${JSON.stringify(pathToFileURL(path.join(duplicateRoot, "jsx-runtime.ts")).href)};

if (publicRuntime.jsx !== canonicalRuntime.jsx || publicRuntime.Fragment !== canonicalRuntime.Fragment) {
  throw new Error("public wrapper does not resolve to the canonical runtime module");
}
if (publicRuntime.jsx === duplicateRuntime.jsx) {
  throw new Error("duplicate-runtime negative control did not create a second module record");
}
`,
  );
  requireSuccess("runtime identity check", run(["bun", identityScript], project));
}

async function assertExportBoundary(project: string): Promise<void> {
  const result = run(
    ["bun", "--eval", 'await import("pletivo/src/_internal/runtime/base")'],
    project,
  );
  if (result.ok) throw new Error("private runtime subpath is importable through package exports");
}

async function assertImportsMapIsRequired(project: string, manifest: object): Promise<void> {
  const manifestFile = path.join(project, "node_modules/pletivo/package.json");
  const withoutImports = structuredClone(manifest);
  Reflect.deleteProperty(withoutImports, "imports");
  await fs.writeFile(manifestFile, `${JSON.stringify(withoutImports, null, 2)}\n`);
  const result = run(["./node_modules/.bin/pletivo", "--help"], project);
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  if (result.ok) throw new Error("missing-imports-map negative control unexpectedly succeeded");
}

const tarball = tarballArgument(process.argv.slice(2));
const stat = await fs.stat(tarball);
if (!stat.isFile()) throw new Error(`tarball is not a file: ${tarball}`);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-consumer-"));
const project = path.join(temporary, "project");
try {
  await writeConsumer(project, tarball);
  requireSuccess(
    "npm consumer install",
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], project),
  );
  const manifest = await assertInstalledShape(project);
  requireSuccess(
    `consumer TypeScript ${MIN_TYPESCRIPT} check`,
    run(["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"], project),
  );
  requireSuccess("pletivo --help", run(["./node_modules/.bin/pletivo", "--help"], project));
  requireSuccess("minimal pletivo build", run(["./node_modules/.bin/pletivo", "build"], project));
  const output = await fs.readFile(path.join(project, "dist/index.html"), "utf8");
  if (!output.includes("packaged pletivo")) throw new Error("minimal build output is incomplete");
  await assertRuntimeIdentity(project);
  await assertExportBoundary(project);
  await assertImportsMapIsRequired(project, manifest);
  console.log(`OK: ${tarball} passed the external npm consumer gate`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
