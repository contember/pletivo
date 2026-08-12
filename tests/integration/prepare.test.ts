import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { serializePreparedSite, type PrepareReport, type PreparedSite } from "@pletivo/core/artifact";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { prepare } from "../../packages/pletivo/src/prepare/index";

const fixtureRoot = path.resolve(import.meta.dir, "../../packages/workers/test/fixture-vendor");
let site: PreparedSite;
let report: PrepareReport;

describe("pletivo prepare", () => {
  beforeAll(async () => {
    __resetForTests();
    const prepared = await prepare(fixtureRoot);
    site = prepared.site;
    report = prepared.report;
  });

  afterAll(() => {
    __resetForTests();
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
    expect(palette).toBeDefined();
    expect(badge).toBeDefined();
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

  test("is deterministic and keeps diagnostics outside executable data", async () => {
    const serialized = serializePreparedSite(site);
    __resetForTests();
    const again = await prepare(fixtureRoot);
    expect(serializePreparedSite(again.site)).toBe(serialized);
    expect(serialized).not.toContain("diagnostics");
    expect(report.diagnostics).toEqual([]);
  });

  test("uses pathPrefix only for compiler filename identity", async () => {
    __resetForTests();
    const shifted = await prepare(fixtureRoot, { pathPrefix: "some/where" });
    const badge = shifted.site.artifact.modules.find((module) =>
      module.compilePath?.endsWith("node_modules/pletivo-vendor-demo/components/Badge.astro"),
    );
    expect(badge?.id).toMatch(/^npm:/);
    expect(badge?.compilePath).toStartWith("some/where/");
  });
});
