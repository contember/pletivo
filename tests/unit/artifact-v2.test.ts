import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  parsePreparedSite,
  serializePreparedSite,
  type PrepareReport,
  type PreparedSite,
} from "@pletivo/core/artifact";

const PREPARED: PreparedSite = {
  artifact: {
    version: ARTIFACT_VERSION,
    config: { site: "https://example.test" },
    scripts: {
      headInline: ["head-b", "head-a"],
      page: ["page-b", "page-a"],
    },
    modules: [
      {
        id: "artifact:package-b/component.astro",
        kind: "astro",
        source: "<p>component</p>",
        compilePath: "node_modules/package-b/component.astro",
      },
      {
        id: "artifact:package-a/index.js",
        kind: "js",
        source: "export default 'a';",
      },
    ],
    resolutions: [
      {
        importer: "project:src/pages/index.astro",
        specifier: "package-b/component.astro",
        target: { kind: "module", id: "artifact:package-b/component.astro" },
      },
      {
        importer: "artifact:package-b/component.astro",
        specifier: "astro/runtime/server/index.js",
        target: { kind: "external", specifier: "astro/runtime/server/index.js" },
      },
      {
        importer: "project:src/pages/other.astro",
        specifier: "package-a",
        target: { kind: "module", id: "artifact:package-a/index.js" },
      },
    ],
  },
};

const REORDERED: PreparedSite = {
  artifact: {
    resolutions: [
      {
        target: { id: "artifact:package-a/index.js", kind: "module" },
        specifier: "package-a",
        importer: "project:src/pages/other.astro",
      },
      {
        target: { specifier: "astro/runtime/server/index.js", kind: "external" },
        specifier: "astro/runtime/server/index.js",
        importer: "artifact:package-b/component.astro",
      },
      {
        target: { id: "artifact:package-b/component.astro", kind: "module" },
        specifier: "package-b/component.astro",
        importer: "project:src/pages/index.astro",
      },
    ],
    modules: [
      {
        source: "export default 'a';",
        kind: "js",
        id: "artifact:package-a/index.js",
      },
      {
        compilePath: "node_modules/package-b/component.astro",
        source: "<p>component</p>",
        kind: "astro",
        id: "artifact:package-b/component.astro",
      },
    ],
    scripts: {
      page: ["page-b", "page-a"],
      headInline: ["head-b", "head-a"],
    },
    config: { site: "https://example.test" },
    version: ARTIFACT_VERSION,
  },
};

function artifactWith(overrides: Record<string, unknown>): unknown {
  return {
    artifact: {
      version: ARTIFACT_VERSION,
      config: {},
      scripts: { headInline: [], page: [] },
      modules: [{ id: "artifact:entry.js", kind: "js", source: "export {};" }],
      resolutions: [],
      ...overrides,
    },
  };
}

function sparseArray(): unknown[] {
  const value: unknown[] = [];
  value.length = 1;
  return value;
}

function formatError(value: unknown): ArtifactFormatError {
  try {
    parsePreparedSite(value);
  } catch (error) {
    if (error instanceof ArtifactFormatError) return error;
    throw error;
  }
  throw new Error("expected ArtifactFormatError");
}

describe("Artifact V2", () => {
  test("parses a valid self-contained artifact round-trip", () => {
    const serialized = serializePreparedSite(PREPARED);
    const parsed = parsePreparedSite(JSON.parse(serialized));

    expect(serializePreparedSite(parsed)).toBe(serialized);
    expect(parsed.artifact.modules).toHaveLength(2);
    expect(parsed.artifact.resolutions).toHaveLength(3);
  });

  test("canonical serialization ignores module, resolution, and record insertion order", () => {
    expect(serializePreparedSite(REORDERED)).toBe(serializePreparedSite(PREPARED));
  });

  test("preserves semantic script order", () => {
    const parsed = parsePreparedSite(JSON.parse(serializePreparedSite(PREPARED)));

    expect(parsed.artifact.scripts.headInline).toEqual(["head-b", "head-a"]);
    expect(parsed.artifact.scripts.page).toEqual(["page-b", "page-a"]);
  });

  test("rejects a V1 envelope explicitly", () => {
    const v1 = {
      artifact: {
        version: 1,
        id: "old",
        config: { base: "/", trailingSlash: "ignore", build: { format: "directory" } },
        scripts: { headInline: [], page: [], beforeHydration: [] },
        virtualModules: {},
        vendor: {},
        generatedSources: {},
        diagnostics: [],
      },
      modules: {},
    };

    expect(() => parsePreparedSite(v1)).toThrow(ArtifactVersionError);
  });

  test("rejects an unknown artifact version", () => {
    expect(() => parsePreparedSite(artifactWith({ version: 99 }))).toThrow(
      ArtifactVersionError,
    );
  });

  const sparseCases = [
    {
      name: "modules",
      value: artifactWith({ modules: sparseArray() }),
      path: "$.artifact.modules[0]",
    },
    {
      name: "resolutions",
      value: artifactWith({ resolutions: sparseArray() }),
      path: "$.artifact.resolutions[0]",
    },
    {
      name: "headInline scripts",
      value: artifactWith({ scripts: { headInline: sparseArray(), page: [] } }),
      path: "$.artifact.scripts.headInline[0]",
    },
    {
      name: "page scripts",
      value: artifactWith({ scripts: { headInline: [], page: sparseArray() } }),
      path: "$.artifact.scripts.page[0]",
    },
  ];

  for (const scenario of sparseCases) {
    test(`rejects sparse ${scenario.name} arrays`, () => {
      expect(formatError(scenario.value).path).toBe(scenario.path);
    });
  }

  const strictCases = [
    {
      name: "missing module source",
      value: artifactWith({ modules: [{ id: "artifact:entry.js", kind: "js" }] }),
      path: "$.artifact.modules[0].source",
    },
    {
      name: "unknown nested target field",
      value: artifactWith({
        resolutions: [
          {
            importer: "project:a.ts",
            specifier: "entry",
            target: { kind: "module", id: "artifact:entry.js", unexpected: true },
          },
        ],
      }),
      path: "$.artifact.resolutions[0].target.unexpected",
    },
    {
      name: "invalid module source type",
      value: artifactWith({
        modules: [{ id: "artifact:entry.js", kind: "js", source: 42 }],
      }),
      path: "$.artifact.modules[0].source",
    },
    {
      name: "invalid config type",
      value: artifactWith({ config: { site: 42 } }),
      path: "$.artifact.config.site",
    },
    {
      name: "invalid script type",
      value: artifactWith({ scripts: { headInline: "script", page: [] } }),
      path: "$.artifact.scripts.headInline",
    },
    {
      name: "unknown target discriminant",
      value: artifactWith({
        resolutions: [
          {
            importer: "project:a.ts",
            specifier: "entry",
            target: { kind: "builtin", specifier: "entry" },
          },
        ],
      }),
      path: "$.artifact.resolutions[0].target.kind",
    },
    {
      name: "empty compilePath",
      value: artifactWith({
        modules: [
          { id: "artifact:entry.js", kind: "js", source: "export {};", compilePath: "" },
        ],
      }),
      path: "$.artifact.modules[0].compilePath",
    },
  ];

  for (const scenario of strictCases) {
    test(`reports a useful path for ${scenario.name}`, () => {
      expect(formatError(scenario.value).path).toBe(scenario.path);
    });
  }

  test("rejects duplicate module IDs", () => {
    expect(() =>
      parsePreparedSite(
        artifactWith({
          modules: [
            { id: "artifact:duplicate.js", kind: "js", source: "export const a = 1;" },
            { id: "artifact:duplicate.js", kind: "js", source: "export const b = 2;" },
          ],
        }),
      ),
    ).toThrow(ArtifactFormatError);
  });

  test("rejects duplicate importer/specifier edges", () => {
    const target = { kind: "module", id: "artifact:entry.js" };
    expect(() =>
      parsePreparedSite(
        artifactWith({
          resolutions: [
            { importer: "project:a.ts", specifier: "pkg", target },
            { importer: "project:a.ts", specifier: "pkg", target },
          ],
        }),
      ),
    ).toThrow(ArtifactFormatError);
  });

  test("allows the same specifier to resolve differently for different importers", () => {
    const parsed = parsePreparedSite(
      artifactWith({
        modules: [
          { id: "artifact:pkg-a.js", kind: "js", source: "export {};" },
          { id: "artifact:pkg-b.js", kind: "js", source: "export {};" },
        ],
        resolutions: [
          {
            importer: "project:a.ts",
            specifier: "pkg",
            target: { kind: "module", id: "artifact:pkg-a.js" },
          },
          {
            importer: "project:b.ts",
            specifier: "pkg",
            target: { kind: "module", id: "artifact:pkg-b.js" },
          },
        ],
      }),
    );

    expect(parsed.artifact.resolutions[0]?.target).toEqual({
      kind: "module",
      id: "artifact:pkg-a.js",
    });
    expect(parsed.artifact.resolutions[1]?.target).toEqual({
      kind: "module",
      id: "artifact:pkg-b.js",
    });
  });

  test("rejects dangling module targets", () => {
    expect(() =>
      parsePreparedSite(
        artifactWith({
          resolutions: [
            {
              importer: "project:a.ts",
              specifier: "missing",
              target: { kind: "module", id: "artifact:missing.js" },
            },
          ],
        }),
      ),
    ).toThrow(ArtifactFormatError);
  });

  test("rejects unknown module kinds", () => {
    expect(() =>
      parsePreparedSite(
        artifactWith({
          modules: [{ id: "artifact:entry.wasm", kind: "wasm", source: "" }],
        }),
      ),
    ).toThrow(ArtifactFormatError);
  });

  test("rejects malformed external targets", () => {
    expect(() =>
      parsePreparedSite(
        artifactWith({
          resolutions: [
            {
              importer: "artifact:entry.js",
              specifier: "runtime",
              target: { kind: "external", specifier: "" },
            },
          ],
        }),
      ),
    ).toThrow(ArtifactFormatError);
  });

  test("keeps diagnostics outside canonical executable data", () => {
    const report: PrepareReport = {
      diagnostics: [
        {
          severity: "warning",
          source: "integration",
          hook: "astro:config:setup",
          reason: "diagnostic-only-marker",
        },
      ],
    };
    const serialized = serializePreparedSite(PREPARED);

    expect(serialized).not.toContain(report.diagnostics[0]?.reason);
    expect(() => parsePreparedSite({ ...PREPARED, report })).toThrow(ArtifactFormatError);
  });
});
