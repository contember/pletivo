#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLETIVO_DIR = path.join(REPO_ROOT, "packages/pletivo");
const CORE_DIR = path.join(REPO_ROOT, "packages/core");
const RUNTIME_DIR = path.join(REPO_ROOT, "packages/runtime");
const INTERNAL_PREFIXES = ["@pletivo/core", "@pletivo/runtime"];

export interface PackagePletivoOptions {
  version: string;
  output: string;
}

export async function packagePletivo(options: PackagePletivoOptions): Promise<string> {
  validatePackageVersion(options.version);
  const output = path.resolve(options.output);
  await ensureEmptyOutput(output);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-package-"));
  const stage = path.join(temporary, "stage");
  try {
    await stagePackage(stage, options.version);
    const packed = Bun.spawnSync(
      ["npm", "pack", "--json", "--pack-destination", output, stage],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (packed.exitCode !== 0) {
      throw new Error(
        `npm pack failed:\n${packed.stdout.toString()}${packed.stderr.toString()}`,
      );
    }
    const filename = packedFilename(packed.stdout.toString());
    const tarball = path.resolve(output, filename);
    const stat = await fs.stat(tarball);
    if (!stat.isFile()) throw new Error(`npm pack did not create ${JSON.stringify(tarball)}`);
    return tarball;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function stagePackage(stage: string, version: string): Promise<void> {
  validatePackageVersion(version);
  await fs.mkdir(stage, { recursive: true });
  await fs.cp(path.join(PLETIVO_DIR, "src"), path.join(stage, "src"), { recursive: true });
  await fs.mkdir(path.join(stage, "src/_internal"), { recursive: true });
  await Promise.all([
    fs.cp(path.join(CORE_DIR, "src"), path.join(stage, "src/_internal/core"), { recursive: true }),
    fs.cp(path.join(RUNTIME_DIR, "src"), path.join(stage, "src/_internal/runtime"), { recursive: true }),
    fs.copyFile(path.join(REPO_ROOT, "README.md"), path.join(stage, "README.md")),
  ]);
  await rewriteTree(path.join(stage, "src"));
  await fs.writeFile(
    path.join(stage, "package.json"),
    `${JSON.stringify(await stagedManifest(version), null, 2)}\n`,
  );
  await assertNoInternalImports(path.join(stage, "src"));
  const manifestText = await fs.readFile(path.join(stage, "package.json"), "utf8");
  if (manifestText.includes("workspace:*")) {
    throw new Error("staged package.json still contains workspace:*");
  }
}

async function stagedManifest(version: string): Promise<Record<string, unknown>> {
  const pletivo = await readJson(path.join(PLETIVO_DIR, "package.json"));
  const core = await readJson(path.join(CORE_DIR, "package.json"));
  const runtime = await readJson(path.join(RUNTIME_DIR, "package.json"));
  const dependencies = dependencyMap(Reflect.get(pletivo, "dependencies"), "pletivo dependencies");
  delete dependencies["@pletivo/core"];
  delete dependencies["@pletivo/runtime"];
  // Both inlined trees, not just core: runtime declares nothing today, and a
  // dependency added to it later has to reach the staged manifest the same way.
  for (const [label, inlined] of [["core", core], ["runtime", runtime]] as const) {
    assertOnlyHandledDependencyFields(label, inlined);
    mergeDependencies(
      dependencies,
      dependencyMap(Reflect.get(inlined, "dependencies"), `${label} dependencies`),
    );
  }

  const manifest: Record<string, unknown> = {};
  for (const field of [
    "name", "description", "type", "license", "repository", "homepage", "bugs",
    "files", "bin", "exports", "peerDependencies", "peerDependenciesMeta", "engines",
    "publishConfig",
  ]) {
    const value = Reflect.get(pletivo, field);
    if (value !== undefined) manifest[field] = value;
  }
  // Read, not hardcoded: a second copy of the published file list here would let
  // the two drift, and the drift ships the whole directory rather than failing.
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("pletivo package.json must declare a non-empty files array");
  }
  manifest.version = version;
  manifest.imports = {
    "#pletivo/core/*": "./src/_internal/core/*.ts",
    "#pletivo/runtime/*": "./src/_internal/runtime/*.ts",
  };
  manifest.dependencies = sortedRecord(dependencies);
  return manifest;
}

async function rewriteTree(root: string): Promise<void> {
  for (const file of await sourceFiles(root)) {
    const source = await fs.readFile(file, "utf8");
    const rewritten = rewriteInternalSpecifiers(file, source);
    if (rewritten !== source) await fs.writeFile(file, rewritten);
  }
}

export function rewriteInternalSpecifiers(file: string, source: string): string {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const rewrite = (literal: ts.StringLiteralLike): void => {
    const replacement = internalAlias(literal.text);
    if (replacement === null) return;
    edits.push({ start: literal.getStart(sourceFile), end: literal.getEnd(), text: JSON.stringify(replacement) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      rewrite(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      rewrite(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      rewrite(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      rewrite(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  edits.sort((left, right) => right.start - left.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

export function actualModuleSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found: string[] = [];
  const record = (literal: ts.StringLiteralLike): void => {
    found.push(literal.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      record(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      record(node.argument.literal);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "require" && node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

async function assertNoInternalImports(root: string): Promise<void> {
  const violations: string[] = [];
  for (const file of await sourceFiles(root)) {
    const source = await fs.readFile(file, "utf8");
    for (const specifier of actualModuleSpecifiers(file, source)) {
      if (INTERNAL_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
        violations.push(`${path.relative(root, file)} imports ${JSON.stringify(specifier)}`);
      }
    }
  }
  if (violations.length > 0) throw new Error(`staged source retains internal imports:\n${violations.join("\n")}`);
}

function internalAlias(specifier: string): string | null {
  for (const name of ["core", "runtime"]) {
    const prefix = `@pletivo/${name}/`;
    if (specifier.startsWith(prefix)) return `#pletivo/${name}/${specifier.slice(prefix.length)}`;
  }
  return null;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  }
  return files.sort();
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

async function readJson(file: string): Promise<object> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return parsed;
}

function dependencyMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(value)) {
    const range: unknown = Reflect.get(value, name);
    if (typeof range !== "string" || range === "") throw new Error(`${label}.${name} is not a version range`);
    dependencies[name] = range;
  }
  return dependencies;
}

/**
 * `dependencies` is merged into the staged manifest; `devDependencies` is
 * dropped the way npm drops it. Every other dependency field — peers above
 * all — would vanish here without a trace and surface as a missing module in
 * the consumer's project, so refuse to stage instead of publishing the hole.
 */
const HANDLED_DEPENDENCY_FIELDS = ["dependencies", "devDependencies"];

export function assertOnlyHandledDependencyFields(label: string, manifest: object): void {
  for (const [field, value] of Object.entries(manifest)) {
    if (!/dependencies/i.test(field) || HANDLED_DEPENDENCY_FIELDS.includes(field)) continue;
    if (typeof value !== "object" || value === null || Object.keys(value).length === 0) continue;
    throw new Error(
      `${label} declares ${field}, which the staged manifest cannot carry — teach stagedManifest() to merge it`,
    );
  }
}

export function mergeDependencies(
  target: Record<string, string>,
  additions: Record<string, string>,
): void {
  for (const [name, range] of Object.entries(additions)) {
    if (name.startsWith("@pletivo/")) continue;
    const existing = target[name];
    if (existing !== undefined && existing !== range) {
      throw new Error(`dependency conflict for ${name}: ${JSON.stringify(existing)} versus ${JSON.stringify(range)}`);
    }
    target[name] = range;
  }
}

function sortedRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

async function ensureEmptyOutput(output: string): Promise<void> {
  await fs.mkdir(output, { recursive: true });
  const entries = await fs.readdir(output);
  if (entries.length > 0) throw new Error(`output directory must be empty: ${output}`);
}

function packedFilename(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result");
  const item: unknown = parsed[0];
  if (typeof item !== "object" || item === null) throw new Error("npm pack result is not an object");
  const filename: unknown = Reflect.get(item, "filename");
  if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
    throw new Error("npm pack returned an invalid filename");
  }
  return filename;
}

export function validatePackageVersion(version: string): void {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`--version must be a stable SemVer, got ${JSON.stringify(version)}`);
  }
}

function commandLineOptions(args: readonly string[]): PackagePletivoOptions {
  let version: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--version") {
      index++;
      version = args[index];
    }
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else if (argument === "--output") {
      index++;
      output = args[index];
    }
    else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!version || !output) throw new Error("usage: package-pletivo --version <semver> --output <empty-dir>");
  return { version, output };
}

if (import.meta.main) {
  const tarball = await packagePletivo(commandLineOptions(process.argv.slice(2)));
  console.log(tarball);
}
