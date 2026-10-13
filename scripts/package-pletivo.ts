#!/usr/bin/env bun

import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLETIVO_DIR = path.join(REPO_ROOT, "packages/pletivo");
const CORE_DIR = path.join(REPO_ROOT, "packages/core");
const RUNTIME_DIR = path.join(REPO_ROOT, "packages/runtime");
const WORKERS_DIR = path.join(REPO_ROOT, "packages/workers");
const INTERNAL_PREFIXES = ["@pletivo/core", "@pletivo/runtime"];

export interface PackagePletivoOptions {
  version: string;
  output: string;
}

export interface LibraryPackage {
  /** The release workflow's step output key for this tarball. */
  key: string;
  name: string;
  directory: string;
}

/**
 * Published as they are in the workspace, source and all, in dependency order:
 * each one's `@pletivo/*` dependencies come earlier in the list.
 */
export const LIBRARY_PACKAGES: readonly LibraryPackage[] = [
  { key: "runtime", name: "@pletivo/runtime", directory: RUNTIME_DIR },
  { key: "core", name: "@pletivo/core", directory: CORE_DIR },
  { key: "workers", name: "@pletivo/workers", directory: WORKERS_DIR },
];

export interface ReleaseTarball {
  key: string;
  name: string;
  tarball: string;
}

/** Every release tarball, in the order they can be published without a dangling dependency. */
export async function packageRelease(options: PackagePletivoOptions): Promise<ReleaseTarball[]> {
  validatePackageVersion(options.version);
  const output = path.resolve(options.output);
  await ensureEmptyOutput(output);
  const tarballs: ReleaseTarball[] = [];
  for (const library of LIBRARY_PACKAGES) {
    const tarball = await packStaged(output, (stage) => stageLibraryPackage(library, stage, options.version));
    tarballs.push({ key: library.key, name: library.name, tarball });
  }
  const pletivo = await packStaged(output, (stage) => stagePackage(stage, options.version));
  tarballs.push({ key: "pletivo", name: "pletivo", tarball: pletivo });
  return tarballs;
}

export async function packagePletivo(options: PackagePletivoOptions): Promise<string> {
  validatePackageVersion(options.version);
  const output = path.resolve(options.output);
  await ensureEmptyOutput(output);
  return packStaged(output, (stage) => stagePackage(stage, options.version));
}

async function packStaged(output: string, stageInto: (stage: string) => Promise<void>): Promise<string> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-package-"));
  const stage = path.join(temporary, "stage");
  try {
    await stageInto(stage);
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

/** The fields a library tarball carries; scripts and devDependencies stay behind. */
const LIBRARY_MANIFEST_FIELDS = [
  "description", "type", "license", "repository", "homepage", "bugs",
  "files", "exports", "peerDependencies", "peerDependenciesMeta", "engines", "publishConfig",
];

const LIBRARY_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta"];

export async function stageLibraryPackage(library: LibraryPackage, stage: string, version: string): Promise<void> {
  validatePackageVersion(version);
  const source = await readJson(path.join(library.directory, "package.json"));
  if (Reflect.get(source, "name") !== library.name) {
    throw new Error(`${library.directory}/package.json is not ${library.name}`);
  }
  assertOnlyHandledDependencyFields(library.name, source, LIBRARY_DEPENDENCY_FIELDS);
  const files: unknown = Reflect.get(source, "files");
  if (!Array.isArray(files) || files.length === 0 || !files.every((entry) => typeof entry === "string")) {
    throw new Error(`${library.name} package.json must declare a non-empty files array`);
  }

  await fs.mkdir(stage, { recursive: true });
  for (const entry of files) {
    await fs.cp(path.join(library.directory, entry), path.join(stage, entry), { recursive: true });
  }

  const manifest: Record<string, unknown> = { name: library.name, version };
  for (const field of LIBRARY_MANIFEST_FIELDS) {
    const value = Reflect.get(source, field);
    if (value !== undefined) manifest[field] = value;
  }
  manifest.dependencies = sortedRecord(
    pinWorkspaceDependencies(
      library.name,
      dependencyMap(Reflect.get(source, "dependencies"), `${library.name} dependencies`),
      version,
    ),
  );
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestText.includes("workspace:")) {
    throw new Error(`staged ${library.name} package.json still contains a workspace: range`);
  }
  await fs.writeFile(path.join(stage, "package.json"), manifestText);
  await assertImportsDeclared(library.name, stage, manifest);
}

/**
 * Lockstep release: a sibling is pinned to the exact version being published,
 * and only a sibling that this release publishes may be named at all.
 */
export function pinWorkspaceDependencies(
  label: string,
  dependencies: Record<string, string>,
  version: string,
): Record<string, string> {
  const released = new Set(LIBRARY_PACKAGES.map((library) => library.name));
  const pinned: Record<string, string> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    const internal = name.startsWith("@pletivo/");
    if (internal !== range.startsWith("workspace:")) {
      throw new Error(`${label} depends on ${name}@${range}; only released @pletivo/* siblings use workspace:*`);
    }
    if (!internal) {
      pinned[name] = range;
      continue;
    }
    if (range !== "workspace:*" || !released.has(name)) {
      throw new Error(`${label} depends on ${name}@${range}, which this release does not publish`);
    }
    pinned[name] = version;
  }
  return pinned;
}

/**
 * A bare import the manifest does not declare still resolves in the workspace,
 * where everything is hoisted, and fails only in a consumer's install.
 */
async function assertImportsDeclared(label: string, stage: string, manifest: Record<string, unknown>): Promise<void> {
  const declared = new Set([
    ...Object.keys(dependencyMap(manifest.dependencies, `${label} dependencies`)),
    ...Object.keys(dependencyMap(manifest.peerDependencies, `${label} peerDependencies`)),
  ]);
  const violations: string[] = [];
  for (const file of await sourceFiles(stage)) {
    const source = await fs.readFile(file, "utf8");
    for (const specifier of actualModuleSpecifiers(file, source)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
      if (!declared.has(packageName(specifier))) {
        violations.push(`${path.relative(stage, file)} imports ${JSON.stringify(specifier)}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`${label} imports packages its manifest does not declare:\n${violations.join("\n")}`);
  }
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
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

export async function sourceFiles(root: string): Promise<string[]> {
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

export async function readJson(file: string): Promise<object> {
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

export function assertOnlyHandledDependencyFields(
  label: string,
  manifest: object,
  handled: readonly string[] = HANDLED_DEPENDENCY_FIELDS,
): void {
  for (const [field, value] of Object.entries(manifest)) {
    if (!/dependencies/i.test(field) || handled.includes(field)) continue;
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
  // `key=path` lines, so the release workflow can append stdout to $GITHUB_OUTPUT.
  for (const { key, tarball } of await packageRelease(commandLineOptions(process.argv.slice(2)))) {
    console.log(`${key}=${tarball}`);
  }
}
