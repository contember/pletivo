import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parsePreparedSite, serializePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { emitArtifact } from "../../packages/pletivo/src/prepare/emit";
import { PrepareError, prepare } from "../../packages/pletivo/src/prepare/index";

const fixtures = path.join(import.meta.dir, "../fixture-prepare");
const project = path.join(fixtures, "project");
const vendorProject = path.resolve(import.meta.dir, "../../packages/workers/test/fixture-vendor");
const temporaryDirectories: string[] = [];

afterEach(() => {
  __resetForTests();
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true })));
});

describe("pletivo prepare", () => {
  test("closes extensionless virtual A to B to npm and preserves importer-aware nested packages", async () => {
    const site = await prepare(project);
    const virtualA = targetFor(site, "project:src/pages/index.tsx", "virtual:a");
    const virtualB = targetFor(site, virtualA, "virtual:b");
    const virtualLeaf = targetFor(site, virtualB, "virtual-leaf");
    expect(virtualA).toStartWith("virtual:");
    expect(virtualB).toStartWith("virtual:");
    expect(virtualLeaf).toStartWith("npm:");

    const parentA = targetFor(site, "project:src/pages/index.tsx", "parent-a");
    const parentB = targetFor(site, "project:src/pages/index.tsx", "parent-b");
    const sharedA = targetFor(site, parentA, "shared-instance");
    const sharedB = targetFor(site, parentB, "shared-instance");
    expect(sharedA).not.toBe(sharedB);
    expect(moduleById(site, sharedA).source).toContain('"one"');
    expect(moduleById(site, sharedB).source).toContain('"two"');

    const helper = targetFor(site, virtualA, "./helper.ts");
    expect(moduleById(site, helper).source).toContain(":helper");
  });

  test("resolves package exports with explicit Worker conditions", async () => {
    const site = await prepare(project);
    const workerModule = targetFor(
      site,
      "project:src/pages/index.tsx",
      "worker-conditions",
    );
    expect(moduleById(site, workerModule).source).toContain("workerd-condition");
    expect(moduleById(site, workerModule).source).not.toContain("bun-condition");
  });

  test("carries hoisted Astro and CSS graphs outside the project root", async () => {
    const site = await prepare(project);
    const card = site.artifact.modules.find((module) => module.compilePath?.endsWith("/Card.astro"));
    const css = site.artifact.modules.find((module) => module.compilePath?.endsWith("/card.css"));
    const theme = site.artifact.modules.find((module) => module.compilePath?.endsWith("/theme.css"));
    expect(card?.kind).toBe("astro");
    expect(card?.compilePath).toStartWith("../node_modules/");
    expect(css?.kind).toBe("css");
    expect(theme?.kind).toBe("css");
    if (!css || !theme) throw new Error("Expected both hoisted CSS modules");
    expect(targetFor(site, css.id, "./theme.css")).toBe(theme.id);
  });

  test("retains TSX and JSON loader kinds", async () => {
    const site = await prepare(project);
    const kinds = new Map(site.artifact.modules.map((module) => [module.compilePath, module.kind]));
    expect([...kinds].some(([file, kind]) => file?.endsWith("/format-pkg/index.tsx") && kind === "tsx")).toBe(true);
    expect([...kinds].some(([file, kind]) => file?.endsWith("/format-pkg/data.json") && kind === "json")).toBe(true);
  });

  test("uses collision-proof virtual IDs", async () => {
    const site = await prepare(project);
    const slash = targetFor(site, "project:src/pages/index.tsx", "virtual:a/b");
    const question = targetFor(site, "project:src/pages/index.tsx", "virtual:a?b");
    expect(slash).not.toBe(question);
    expect(moduleById(site, slash).source).toContain("slash");
    expect(moduleById(site, question).source).toContain("question");
  });

  test("rejects unresolved modules and unsupported loaders fatally", async () => {
    await expectPrepareError(path.join(fixtures, "fatal-unresolved"), "could not resolve");
    await expectPrepareError(path.join(fixtures, "fatal-loader"), "unsupported module extension");
  });

  test.each(["raw", "inline", "url", "lang=text&raw", "url&v=1", "raw=true"])(
    "leaves project ?%s imports to the consumer while validating their files",
    async (query) => {
      const directory = await temporaryDirectory();
      await fs.mkdir(path.join(directory, "src/pages"), { recursive: true });
      await fs.writeFile(path.join(directory, "src/data.txt"), "query import body\n");
      await fs.writeFile(
        path.join(directory, "src/pages/index.ts"),
        `import value from "../data.txt?${query}"; export default value;\n`,
      );
      const site = await prepare(directory);
      expect(site.artifact.modules).toEqual([]);
      expect(site.artifact.resolutions).toEqual([]);

      await fs.unlink(path.join(directory, "src/data.txt"));
      __resetForTests();
      await expectPrepareError(directory, "could not resolve");
    },
  );

  test("does not silently accept unsupported project query imports", async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(path.join(directory, "src/pages"), { recursive: true });
    await fs.writeFile(path.join(directory, "src/data.txt"), "query import body\n");
    await fs.writeFile(
      path.join(directory, "src/pages/index.ts"),
      'import value from "../data.txt?unknown"; export default value;\n',
    );
    await expectPrepareError(directory, "could not resolve");
  });

  for (const query of ["raw", "inline", "url"]) {
    test.each([
      { specifier: "../data", file: "data.ts", source: "export default 1;", accepted: true },
      { specifier: "../data", file: "data/index.ts", source: "export default 1;", accepted: true },
      { specifier: "../data", file: "data.json", source: "{}", accepted: false },
      { specifier: "../data", file: "data.css", source: "p {}", accepted: false },
      { specifier: "../data", file: "data/index.json", source: "{}", accepted: false },
      { specifier: "../data.mjs", file: "data.ts", source: "export default 1;", accepted: true },
      { specifier: "../data.cjs", file: "data.mts", source: "export default 1;", accepted: true },
      { specifier: "../data.js", file: "data.jsx", source: "export default 1;", accepted: false },
      { specifier: "../data.json", file: "data.json", source: "{}", accepted: true },
    ])(`matches consumer resolution for $specifier?${query} with $file`, async ({ specifier, file, source, accepted }) => {
      const directory = await temporaryDirectory();
      await fs.mkdir(path.join(directory, "src/pages"), { recursive: true });
      const target = path.join(directory, "src", file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
      await fs.writeFile(
        path.join(directory, "src/pages/index.ts"),
        `import value from "${specifier}?${query}"; export default value;\n`,
      );
      if (!accepted) {
        await expectPrepareError(directory, "could not resolve");
        return;
      }
      const site = await prepare(directory);
      expect(site.artifact.modules).toEqual([]);
      expect(site.artifact.resolutions).toEqual([]);
    });
  }

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
    expect(error.diagnostics.map((entry) => entry.hook)).toEqual([
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
    expect(error.diagnostics.map((entry) => entry.hook)).toEqual([
      "redirects",
      "markdown",
      "astro:config:setup",
      "before-hydration",
    ]);
  });

  test("emits the canonical site as a TypeScript module", async () => {
    const site = await prepare(project);
    const directory = await temporaryDirectory();
    const emitted = await emitArtifact(directory, site);
    const imported: unknown = await import(`${pathToFileURL(emitted.modulePath).href}?v=${Date.now()}`);
    const emittedSite = moduleExport(imported, "PREPARED");
    expect(JSON.stringify(emittedSite)).toBe(serializePreparedSite(site));
    expect(await fs.readdir(directory)).toEqual(["pletivo-artifact.ts"]);
  });

  test("a failed CLI leaves an existing artifact unchanged", async () => {
    const directory = await temporaryDirectory();
    await fs.cp(path.join(fixtures, "fatal-routing"), directory, { recursive: true });
    const output = path.join(directory, "out");
    await fs.mkdir(output);
    const modulePath = path.join(output, "pletivo-artifact.ts");
    await fs.writeFile(modulePath, "old-module\n");
    const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
    const child = Bun.spawn(["bun", cli, "prepare", "--out", "out"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).not.toBe(0);
    expect(await fs.readFile(modulePath, "utf8")).toBe("old-module\n");
  });

  test("is deterministic independently of discovery order", async () => {
    const first = await prepare(project);
    __resetForTests();
    const second = await prepare(project);
    expect(serializePreparedSite(second)).toBe(serializePreparedSite(first));
    expect(first.artifact.scripts.headInline).toEqual([
      "window.first = true;\n",
      "window.second = true;\n",
    ]);
  });

  test("is independent of the checkout root, including absolute Vite ids", async () => {
    const first = await prepare(project);
    const directory = await temporaryDirectory();
    const copiedFixtures = path.join(directory, "fixture-prepare");
    await fs.cp(fixtures, copiedFixtures, { recursive: true });
    __resetForTests();
    const copied = await prepare(path.join(copiedFixtures, "project"));
    expect(serializePreparedSite(copied)).toBe(serializePreparedSite(first));
  });

  test("records only the Astro config for the bare fixture", async () => {
    const site = await prepare(project);
    const digest = createHash("sha256").update(await fs.readFile(path.join(project, "astro.config.mjs"))).digest("hex");
    expect(site.inputs).toEqual([{ path: "astro.config.mjs", digest: `sha256:${digest}` }]);
  });

  test("records the digests of the config, package manifest, and text lockfiles", async () => {
    const directory = await temporaryDirectory();
    const copiedFixtures = path.join(directory, "fixture-prepare");
    await fs.cp(fixtures, copiedFixtures, { recursive: true });
    const copiedProject = path.join(copiedFixtures, "project");
    await fs.writeFile(path.join(copiedProject, "package.json"), '{ "name": "prepare-inputs", "private": true }\n');
    await fs.writeFile(path.join(copiedProject, "bun.lock"), "{}\n");
    await fs.writeFile(path.join(copiedProject, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
    await fs.writeFile(path.join(copiedProject, "bun.lockb"), new Uint8Array([0, 1, 2]));
    await fs.writeFile(path.join(copiedProject, "pletivo.config.ts"), "export default {};\n");

    const site = await prepare(copiedProject);
    const expected = await Promise.all(
      ["astro.config.mjs", "bun.lock", "package-lock.json", "package.json", "pletivo.config.ts"].map(async (file) => ({
        path: file,
        digest: `sha256:${createHash("sha256").update(await fs.readFile(path.join(copiedProject, file))).digest("hex")}`,
      })),
    );
    expect(site.inputs).toEqual(expected);

    const emitted = await emitArtifact(await temporaryDirectory(), site);
    const imported: unknown = await import(`${pathToFileURL(emitted.modulePath).href}?v=${Date.now()}`);
    expect(parsePreparedSite(moduleExport(imported, "PREPARED")).inputs).toEqual(expected);
  });
});

describe("pletivo prepare on the vendor fixture", () => {
  let site: PreparedSite;

  beforeAll(async () => {
    site = await prepare(vendorProject);
  });

  test("freezes only config fields the Workers host consumes", () => {
    expect(site.artifact.config).toEqual({ site: "https://vendor.example" });
  });

  test("freezes supported injectScript bodies in semantic order", () => {
    expect(site.artifact.scripts).toEqual({
      headInline: ['window.__vendorDemo = "ready";\n'],
      page: [],
    });
  });

  test("carries npm source graphs with package-local identities and compile paths", () => {
    const paths = site.artifact.modules.map((module) => module.compilePath);
    expect(paths).toContain("node_modules/pletivo-vendor-demo/components/Badge.astro");
    expect(paths).toContain("node_modules/pletivo-vendor-demo/components/palette.ts");
    expect(paths).toContain("node_modules/pletivo-vendor-demo/index.js");
    expect(paths).toContain("node_modules/pletivo-vendor-demo/internal/title-case.js");
    expect(site.artifact.modules.every((module) => module.id.startsWith("npm:") || module.id.startsWith("virtual:"))).toBe(true);
  });

  test("keeps relative extension remapping importer-aware", () => {
    const palette = site.artifact.modules.find((module) => module.compilePath?.endsWith("/palette.ts"));
    const badge = site.artifact.modules.find((module) => module.compilePath?.endsWith("/Badge.astro"));
    if (!palette || !badge) throw new Error("Expected both vendor fixture modules");
    expect(site.artifact.resolutions).toContainEqual({
      importer: badge.id,
      specifier: "./palette.js",
      target: { kind: "module", id: palette.id },
    });
  });

  test("freezes virtual module source and its project resolution", () => {
    const frozen = site.artifact.modules.find((module) => module.id.startsWith("virtual:"));
    expect(frozen?.source).toContain('"positive":"#0a7d32"');
    expect(frozen?.kind).toBe("ts");
    expect(site.artifact.resolutions.some((edge) =>
      edge.specifier === "virtual:vendor-demo" && edge.target.kind === "module" && edge.target.id === frozen?.id
    )).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-prepare-"));
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
