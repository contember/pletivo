import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePreparedSite, serializePreparedSite } from "@pletivo/core/artifact";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import {
  __setEmitRenameForTests,
  emitArtifact,
} from "../../packages/pletivo/src/prepare/emit";
import { PrepareError, prepare } from "../../packages/pletivo/src/prepare/index";

const fixtures = path.join(import.meta.dir, "../fixture-prepare-v2");
const project = path.join(fixtures, "project");
const temporaryDirectories: string[] = [];

afterEach(() => {
  __resetForTests();
  __setEmitRenameForTests(null);
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true })));
});

describe("Artifact V2 producer", () => {
  test("closes virtual A to B to npm and preserves importer-aware nested packages", async () => {
    const prepared = await prepare(project);
    const virtualA = targetFor(prepared.site, "project:src/pages/index.tsx", "virtual:a");
    const virtualB = targetFor(prepared.site, virtualA, "virtual:b");
    const virtualLeaf = targetFor(prepared.site, virtualB, "virtual-leaf");
    expect(virtualA).toStartWith("virtual:");
    expect(virtualB).toStartWith("virtual:");
    expect(virtualLeaf).toStartWith("npm:");

    const parentA = targetFor(prepared.site, "project:src/pages/index.tsx", "parent-a");
    const parentB = targetFor(prepared.site, "project:src/pages/index.tsx", "parent-b");
    const sharedA = targetFor(prepared.site, parentA, "shared-instance");
    const sharedB = targetFor(prepared.site, parentB, "shared-instance");
    expect(sharedA).not.toBe(sharedB);
    expect(moduleById(prepared.site, sharedA).source).toContain('"one"');
    expect(moduleById(prepared.site, sharedB).source).toContain('"two"');

    const helper = targetFor(prepared.site, virtualA, "./helper.ts");
    expect(moduleById(prepared.site, helper).source).toContain(":helper");
  });

  test("resolves package exports with explicit Worker conditions", async () => {
    const prepared = await prepare(project);
    const workerModule = targetFor(
      prepared.site,
      "project:src/pages/index.tsx",
      "worker-conditions",
    );
    expect(moduleById(prepared.site, workerModule).source).toContain("workerd-condition");
    expect(moduleById(prepared.site, workerModule).source).not.toContain("bun-condition");
  });

  test("carries hoisted Astro and CSS graphs outside the project root", async () => {
    const prepared = await prepare(project);
    const card = prepared.site.artifact.modules.find((module) => module.compilePath?.endsWith("/Card.astro"));
    const css = prepared.site.artifact.modules.find((module) => module.compilePath?.endsWith("/card.css"));
    const theme = prepared.site.artifact.modules.find((module) => module.compilePath?.endsWith("/theme.css"));
    expect(card?.kind).toBe("astro");
    expect(card?.compilePath).toStartWith("../node_modules/");
    expect(css?.kind).toBe("css");
    expect(theme?.kind).toBe("css");
    if (!css || !theme) throw new Error("Expected both hoisted CSS modules");
    expect(targetFor(prepared.site, css.id, "./theme.css")).toBe(theme.id);
  });

  test("retains TSX and JSON loader kinds", async () => {
    const prepared = await prepare(project);
    const kinds = new Map(prepared.site.artifact.modules.map((module) => [module.compilePath, module.kind]));
    expect([...kinds].some(([file, kind]) => file?.endsWith("/format-pkg/index.tsx") && kind === "tsx")).toBe(true);
    expect([...kinds].some(([file, kind]) => file?.endsWith("/format-pkg/data.json") && kind === "json")).toBe(true);
  });

  test("uses collision-proof virtual IDs", async () => {
    const prepared = await prepare(project);
    const slash = targetFor(prepared.site, "project:src/pages/index.tsx", "virtual:a/b");
    const question = targetFor(prepared.site, "project:src/pages/index.tsx", "virtual:a?b");
    expect(slash).not.toBe(question);
    expect(moduleById(prepared.site, slash).source).toContain("slash");
    expect(moduleById(prepared.site, question).source).toContain("question");
  });

  test("rejects unresolved modules and unsupported loaders fatally", async () => {
    await expectPrepareError(path.join(fixtures, "fatal-unresolved"), "could not resolve");
    await expectPrepareError(path.join(fixtures, "fatal-loader"), "unsupported module extension");
  });

  test("rejects malformed carried and virtual modules with importer context", async () => {
    const malformedPackage = await capturedPrepareError(path.join(fixtures, "fatal-malformed-npm"));
    expect(malformedPackage.message).toContain("could not parse imports");
    expect(malformedPackage.message).toContain("importer \"npm:");
    __resetForTests();
    const malformedVirtual = await capturedPrepareError(path.join(fixtures, "fatal-malformed-virtual"));
    expect(malformedVirtual.message).toContain("could not parse imports");
    expect(malformedVirtual.message).toContain("importer \"virtual:");
  });

  test("rejects CommonJS JavaScript, CJS, and CTS modules", async () => {
    await expectPrepareError(path.join(fixtures, "fatal-commonjs-js"), "CommonJS module.exports");
    await expectPrepareError(path.join(fixtures, "fatal-commonjs-cjs"), "CommonJS .cjs");
    await expectPrepareError(path.join(fixtures, "fatal-commonjs-cts"), "CommonJS .cts");
  });

  test("rejects routing configuration the Workers host ignores", async () => {
    const error = await capturedPrepareError(path.join(fixtures, "fatal-routing"));
    expect(error.report.diagnostics.map((entry) => entry.hook)).toEqual([
      "base",
      "trailingSlash",
      "build.format",
    ]);
  });

  test("rejects Worker-relevant pletivo config and source directories outside the root", async () => {
    await expectPrepareError(path.join(fixtures, "fatal-pletivo-routing"), "base");
    await expectPrepareError(project, "source directory", { srcDir: ".." });
    await expectPrepareError(project, "source directory", { srcDir: path.resolve(fixtures) });
  });

  test("rejects injected routes, markdown plugins, redirects, and unsupported scripts", async () => {
    const error = await capturedPrepareError(path.join(fixtures, "fatal-semantics"));
    expect(error.report.diagnostics.map((entry) => entry.hook)).toEqual([
      "redirects",
      "markdown",
      "astro:config:setup",
      "before-hydration",
    ]);
  });

  test("emits the same canonical V2 site as JSON and TypeScript", async () => {
    const prepared = await prepare(project);
    const directory = await temporaryDirectory();
    const emitted = await emitArtifact(directory, prepared.site);
    const json = await fs.readFile(emitted.jsonPath, "utf8");
    const imported: unknown = await import(`${pathToFileURL(emitted.modulePath).href}?v=${Date.now()}`);
    const moduleSite = moduleExport(imported, "PREPARED");
    expect(serializePreparedSite(JSON.parse(json))).toBe(serializePreparedSite(moduleSite));
    expect(json).toBe(`${serializePreparedSite(prepared.site)}\n`);
    expect(json).not.toContain("diagnostics");
  });

  test("a failed CLI leaves an existing artifact unchanged", async () => {
    const directory = await temporaryDirectory();
    await fs.cp(path.join(fixtures, "fatal-routing"), directory, { recursive: true });
    const output = path.join(directory, "out");
    await fs.mkdir(output);
    const jsonPath = path.join(output, "pletivo-artifact.json");
    const modulePath = path.join(output, "pletivo-artifact.ts");
    await fs.writeFile(jsonPath, "old-json\n");
    await fs.writeFile(modulePath, "old-module\n");
    const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
    const child = Bun.spawn(["bun", cli, "prepare", "--out", "out"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).not.toBe(0);
    expect(await fs.readFile(jsonPath, "utf8")).toBe("old-json\n");
    expect(await fs.readFile(modulePath, "utf8")).toBe("old-module\n");
  });

  test("restores the old JSON and TypeScript pair when the second install fails", async () => {
    const prepared = await prepare(project);
    const directory = await temporaryDirectory();
    const jsonPath = path.join(directory, "pletivo-artifact.json");
    const modulePath = path.join(directory, "pletivo-artifact.ts");
    await fs.writeFile(jsonPath, "old-json\n");
    await fs.writeFile(modulePath, "old-module\n");
    __setEmitRenameForTests(async (source, destination) => {
      if (destination === modulePath && source.endsWith(".tmp")) {
        throw new Error("injected second install failure");
      }
      await fs.rename(source, destination);
    });

    await expect(emitArtifact(directory, prepared.site)).rejects.toThrow(
      "injected second install failure",
    );
    expect(await fs.readFile(jsonPath, "utf8")).toBe("old-json\n");
    expect(await fs.readFile(modulePath, "utf8")).toBe("old-module\n");
  });

  test("is deterministic independently of discovery order", async () => {
    const first = await prepare(project);
    __resetForTests();
    const second = await prepare(project);
    expect(serializePreparedSite(second.site)).toBe(serializePreparedSite(first.site));
    expect(first.site.artifact.scripts.headInline).toEqual([
      "window.first = true;\n",
      "window.second = true;\n",
    ]);
  });

  test("is independent of the checkout root, including absolute Vite ids", async () => {
    const first = await prepare(project);
    const directory = await temporaryDirectory();
    const copiedFixtures = path.join(directory, "fixture-prepare-v2");
    await fs.cp(fixtures, copiedFixtures, { recursive: true });
    __resetForTests();
    const copied = await prepare(path.join(copiedFixtures, "project"));
    expect(serializePreparedSite(copied.site)).toBe(serializePreparedSite(first.site));
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-prepare-v2-"));
  temporaryDirectories.push(directory);
  return directory;
}

function targetFor(site: unknown, importer: string, specifier: string): string {
  const parsed = parsePreparedSite(site);
  const edge = parsed.artifact.resolutions.find(
    (candidate) => candidate.importer === importer && candidate.specifier === specifier,
  );
  if (!edge || edge.target.kind !== "module") {
    throw new Error(`Missing module resolution ${importer} -> ${specifier}`);
  }
  return edge.target.id;
}

function moduleById(site: unknown, id: string) {
  const module = parsePreparedSite(site).artifact.modules.find((candidate) => candidate.id === id);
  if (!module) throw new Error(`Missing module ${id}`);
  return module;
}

async function expectPrepareError(
  root: string,
  message: string,
  options?: Parameters<typeof prepare>[1],
): Promise<void> {
  const error = await capturedPrepareError(root, options);
  expect(error.message).toContain(message);
  expect(error.report.diagnostics.every((entry) => entry.severity === "fatal")).toBe(true);
  __resetForTests();
}

async function capturedPrepareError(
  root: string,
  options?: Parameters<typeof prepare>[1],
): Promise<PrepareError> {
  try {
    await prepare(root, options);
  } catch (error) {
    if (error instanceof PrepareError) return error;
    throw error;
  }
  throw new Error(`Expected prepare to fail for ${root}`);
}

function moduleExport(moduleValue: unknown, name: string): unknown {
  if (typeof moduleValue !== "object" || moduleValue === null) {
    throw new Error("Generated artifact module did not export an object");
  }
  return Reflect.get(moduleValue, name);
}
