import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The split only holds while nothing walks back over it: @pletivo/runtime ships
 * into the output, @pletivo/core stays host-agnostic, and neither may reach
 * into the Bun host it was lifted out of.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME_SRC = path.join(REPO_ROOT, "packages/runtime/src");
const CORE_SRC = path.join(REPO_ROOT, "packages/core/src");
const HOST_SRC = path.join(REPO_ROOT, "packages/pletivo/src");

/** Host-only modules @pletivo/core must not reach for. */
const HOST_ONLY_MODULES = [
  "bun",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "os",
  "node:os",
  "worker_threads",
  "node:worker_threads",
];

/** The one import @pletivo/runtime is allowed to make outside itself. */
const RUNTIME_ALLOWED_MODULE = "node:async_hooks";

interface CodeLine {
  /** 1-based line number in the file on disk, so a failure can be opened. */
  number: number;
  text: string;
}

interface SourceFile {
  /** Repo-relative, for failure messages. */
  label: string;
  absPath: string;
  source: string;
  /** The file's lines with comment lines dropped — see codeLines. */
  lines: CodeLine[];
}

/**
 * Drops whole-line comments. dev-cache.ts names 'bun:test' in a doc comment,
 * and a guard that reads prose as code cries wolf on the first one.
 */
function codeLines(source: string): CodeLine[] {
  return source
    .split("\n")
    .map((text, index) => ({ number: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    });
}

function readSources(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const rel of new Glob("**/*.ts").scanSync(dir)) {
    const absPath = path.join(dir, rel);
    const source = readFileSync(absPath, "utf8");
    files.push({
      label: path.relative(REPO_ROOT, absPath),
      absPath,
      source,
      lines: codeLines(source),
    });
  }
  return files.sort((a, b) => a.label.localeCompare(b.label));
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Every module specifier the file names — static, dynamic, require and
 * type-only. The transpiler covers the first three and, unlike a regex, does
 * not read the `await import(...)` inside the browser snippets hmr-client and
 * hydration emit as strings. It elides type-only imports, so those are picked
 * up separately from lines that open (or close) an import statement.
 */
function importSpecifiers(file: SourceFile): string[] {
  const specifiers = new Set<string>();
  for (const { path: specifier } of transpiler.scan(file.source).imports) specifiers.add(specifier);
  for (const { text } of file.lines) {
    const match =
      text.match(/^\s*(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/) ??
      text.match(/^\s*\}\s*from\s*["']([^"']+)["']/) ??
      text.match(/^\s*import\s*["']([^"']+)["']/);
    if (match) specifiers.add(match[1]!);
  }
  return [...specifiers];
}

/** Where a relative specifier lands, so an import can be checked for escaping its package. */
function resolveRelative(file: SourceFile, specifier: string): string {
  return path.resolve(path.dirname(file.absPath), specifier);
}

const runtimeFiles = readSources(RUNTIME_SRC);
const coreFiles = readSources(CORE_SRC);

describe("package boundaries", () => {
  test("only pletivo is publishable", () => {
    const rootManifest: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    if (typeof rootManifest !== "object" || rootManifest === null || Array.isArray(rootManifest)) {
      throw new Error("root package.json is not a JSON object");
    }
    const workspaces: unknown = Reflect.get(rootManifest, "workspaces");
    if (!Array.isArray(workspaces) || !workspaces.every((entry) => typeof entry === "string")) {
      throw new Error("root package.json workspaces must be a string array");
    }
    expect(workspaces).toContain("packages/*");
    const packageDirectories = readdirSync(path.join(REPO_ROOT, "packages"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((directory) => {
        try {
          readFileSync(path.join(REPO_ROOT, "packages", directory, "package.json"));
          return true;
        } catch {
          return false;
        }
      })
      .sort();
    const publishable: string[] = [];
    for (const directory of packageDirectories) {
      const file = path.join(REPO_ROOT, "packages", directory, "package.json");
      const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        throw new Error(`${file} is not a JSON object`);
      }
      if (Reflect.get(manifest, "private") !== true) publishable.push(directory);
    }
    expect(publishable).toEqual(["pletivo"]);
  });

  test("the guard actually reads both packages", () => {
    // A glob that matches nothing would pass every assertion below.
    expect(runtimeFiles.length).toBeGreaterThan(0);
    expect(coreFiles.length).toBeGreaterThan(0);
  });

  describe("@pletivo/runtime", () => {
    test(`imports nothing outside itself except ${RUNTIME_ALLOWED_MODULE}`, () => {
      const violations: string[] = [];
      for (const file of runtimeFiles) {
        for (const specifier of importSpecifiers(file)) {
          if (specifier === RUNTIME_ALLOWED_MODULE) continue;
          if (!specifier.startsWith(".")) {
            violations.push(`${file.label} imports "${specifier}" (only relative imports and ${RUNTIME_ALLOWED_MODULE} are allowed)`);
            continue;
          }
          const target = resolveRelative(file, specifier);
          if (!target.startsWith(RUNTIME_SRC + path.sep)) {
            violations.push(`${file.label} imports "${specifier}", which leaves packages/runtime/src`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe("@pletivo/core", () => {
    test("imports no host-only module", () => {
      const violations: string[] = [];
      for (const file of coreFiles) {
        for (const specifier of importSpecifiers(file)) {
          if (HOST_ONLY_MODULES.includes(specifier) || specifier.startsWith("bun:")) {
            violations.push(`${file.label} imports "${specifier}", which only exists on the Bun host`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    test("does not use the Bun global", () => {
      const violations: string[] = [];
      for (const file of coreFiles) {
        for (const { number, text } of file.lines) {
          const match = text.match(/(?<![\w$.])Bun\s*[.[]|\btypeof\s+Bun\b/);
          if (match) {
            violations.push(`${file.label}:${number} uses the Bun global — "${match[0].trim()}"`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  test("neither package imports the pletivo host", () => {
    const violations: string[] = [];
    for (const file of [...runtimeFiles, ...coreFiles]) {
      for (const specifier of importSpecifiers(file)) {
        const isHostPackage = specifier === "pletivo" || specifier.startsWith("pletivo/");
        const isHostPath = specifier.startsWith(".") && resolveRelative(file, specifier).startsWith(HOST_SRC + path.sep);
        if (isHostPackage || isHostPath) {
          violations.push(`${file.label} imports "${specifier}", which is the host`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
