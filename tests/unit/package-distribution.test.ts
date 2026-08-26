import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  actualModuleSpecifiers,
  mergeDependencies,
  packagePletivo,
  rewriteInternalSpecifiers,
  stagePackage,
  validatePackageVersion,
} from "../../scripts/package-pletivo";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-distribution-test-"));

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

async function readObject(file: string): Promise<object> {
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return value;
}

async function extract(tarball: string, destination: string): Promise<string> {
  await fs.mkdir(destination, { recursive: true });
  const result = Bun.spawnSync(["tar", "-xzf", tarball, "-C", destination], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`tar extraction failed:\n${result.stdout.toString()}${result.stderr.toString()}`);
  }
  return path.join(destination, "package");
}

async function inventory(root: string): Promise<string[]> {
  const rows: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const stat = await fs.lstat(file);
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      if (entry.isDirectory()) {
        rows.push(`${relative}/\t${mode}\t-`);
        pending.push(file);
      } else if (entry.isFile()) {
        const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
        rows.push(`${relative}\t${mode}\t${hash}`);
      } else {
        throw new Error(`unexpected tarball entry type: ${relative}`);
      }
    }
  }
  return rows.sort();
}

describe("pletivo package distribution", () => {
  test("rewrites only real internal module specifiers", () => {
    const source = `import value from "@pletivo/core/value";
export { thing } from "@pletivo/runtime/thing";
export type { Shape } from "@pletivo/core/types";
type Lazy = import("@pletivo/runtime/lazy").Lazy;
const loaded = import("@pletivo/core/dynamic");
const workerSpecifier = "@pletivo/runtime/jsx-runtime";
const template = \`@pletivo/core/not-an-import\`;
`;
    const rewritten = rewriteInternalSpecifiers("fixture.ts", source);
    expect(actualModuleSpecifiers("fixture.ts", rewritten)).toEqual([
      "#pletivo/core/value",
      "#pletivo/runtime/thing",
      "#pletivo/core/types",
      "#pletivo/runtime/lazy",
      "#pletivo/core/dynamic",
    ]);
    expect(rewritten).toContain('const workerSpecifier = "@pletivo/runtime/jsx-runtime"');
    expect(rewritten).toContain("`@pletivo/core/not-an-import`");
  });

  test("rewrites and detects dynamic imports with attributes", () => {
    const source = `const data = import("@pletivo/core/data", { with: { type: "json" } });\n`;
    const rewritten = rewriteInternalSpecifiers("attributes.ts", source);
    expect(rewritten).toBe(
      `const data = import("#pletivo/core/data", { with: { type: "json" } });\n`,
    );
    expect(actualModuleSpecifiers("attributes.ts", source)).toEqual(["@pletivo/core/data"]);
    expect(actualModuleSpecifiers("attributes.ts", rewritten)).toEqual(["#pletivo/core/data"]);
  });

  test("detects unsupported internal require forms instead of rewriting them", () => {
    const source = `import legacy = require("@pletivo/core/legacy");
const runtime = require("@pletivo/runtime/legacy");
`;
    expect(rewriteInternalSpecifiers("legacy.ts", source)).toBe(source);
    expect(actualModuleSpecifiers("legacy.ts", source)).toEqual([
      "@pletivo/core/legacy",
      "@pletivo/runtime/legacy",
    ]);
  });

  test("rejects incompatible dependency ranges", () => {
    expect(() => mergeDependencies({ unified: "^11" }, { unified: "^12" })).toThrow(
      'dependency conflict for unified: "^11" versus "^12"',
    );
  });

  test("accepts only stable SemVer versions", () => {
    for (const version of ["0.0.0", "1.2.3", "10.20.30"]) {
      expect(() => validatePackageVersion(version)).not.toThrow();
    }
    for (const version of [
      "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03",
      "1.2.3-alpha", "1.2.3-01", "1.2.3-.a", "1.2.3+build", "v1.2.3",
    ]) {
      expect(() => validatePackageVersion(version)).toThrow("stable SemVer");
    }
  });

  test("stages wrappers and one private canonical core/runtime tree", async () => {
    const stage = path.join(temporary, "stage");
    await stagePackage(stage, "7.6.5");
    const manifest = await readObject(path.join(stage, "package.json"));
    expect(Reflect.get(manifest, "version")).toBe("7.6.5");
    expect(Reflect.get(manifest, "files")).toEqual(["src", "README.md"]);
    expect(Reflect.get(manifest, "imports")).toEqual({
      "#pletivo/core/*": "./src/_internal/core/*.ts",
      "#pletivo/runtime/*": "./src/_internal/runtime/*.ts",
    });
    expect(JSON.stringify(Reflect.get(manifest, "dependencies"))).not.toContain("@pletivo/");
    expect(JSON.stringify(manifest)).not.toContain("workspace:*");
    expect(Reflect.get(manifest, "exports")).toEqual({
      ".": "./src/index.ts",
      "./jsx-runtime": "./src/runtime/jsx-runtime.ts",
      "./jsx-dev-runtime": "./src/runtime/jsx-runtime.ts",
      "./hooks": "./src/runtime/hooks.ts",
      "./content": "./src/content/index.ts",
      "./astro-shim": "./src/runtime/astro-shim.ts",
    });
    expect(await fs.readFile(path.join(stage, "src/runtime/jsx-runtime.ts"), "utf8"))
      .toBe('export * from "#pletivo/runtime/jsx-runtime";\n');
    expect(await fs.readFile(path.join(stage, "src/_internal/runtime/jsx-runtime.ts"), "utf8"))
      .toContain("export function jsx");
    expect(await fs.readFile(path.join(stage, "src/_internal/core/router.ts"), "utf8"))
      .toContain("export function");
  });

  test("refuses a nonempty output directory", async () => {
    const output = path.join(temporary, "nonempty-output");
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "keep.txt"), "keep");
    await expect(packagePletivo({ version: "1.2.3", output })).rejects.toThrow(
      "output directory must be empty",
    );
    expect(await fs.readFile(path.join(output, "keep.txt"), "utf8")).toBe("keep");
  });

  test("packs a deterministic source inventory twice", async () => {
    const firstOutput = path.join(temporary, "pack-one");
    const secondOutput = path.join(temporary, "pack-two");
    const firstTarball = await packagePletivo({ version: "9.8.7", output: firstOutput });
    const secondTarball = await packagePletivo({ version: "9.8.7", output: secondOutput });
    expect(path.isAbsolute(firstTarball)).toBe(true);
    expect(path.dirname(firstTarball)).toBe(firstOutput);
    expect(path.basename(firstTarball)).toBe("pletivo-9.8.7.tgz");

    const firstPackage = await extract(firstTarball, path.join(temporary, "extract-one"));
    const secondPackage = await extract(secondTarball, path.join(temporary, "extract-two"));
    expect(await inventory(firstPackage)).toEqual(await inventory(secondPackage));
    const files = await inventory(firstPackage);
    expect(files.some((entry) => entry.startsWith("src/_internal/core/"))).toBe(true);
    expect(files.some((entry) => entry.startsWith("src/_internal/runtime/"))).toBe(true);
    expect(files.some((entry) => {
      const separator = entry.indexOf("\t");
      return separator !== -1 && entry.slice(0, separator).endsWith(".js");
    })).toBe(false);
  }, 30_000);
});
