import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  digestArtifactInput,
  parsePreparedSite,
  serializePreparedSite,
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

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"0123456789abcdef".repeat(4)}`;

function withInputs(inputs: unknown): unknown {
  return { ...PREPARED, inputs };
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

describe("site artifact", () => {
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

  test("rejects unknown envelope fields", () => {
    expect(() => parsePreparedSite({ ...PREPARED, report: { diagnostics: [] } })).toThrow(ArtifactFormatError);
  });
});

describe("site artifact inputs", () => {
  test("accepts sorted inputs and keeps them through canonical serialization", () => {
    const inputs = [
      { path: "astro.config.mjs", digest: DIGEST_A },
      { path: "config/site.json", digest: DIGEST_B },
      { path: "package.json", digest: DIGEST_A },
    ];
    const parsed = parsePreparedSite(withInputs(inputs));

    expect(parsed.inputs).toEqual(inputs);
    expect(parsePreparedSite(JSON.parse(serializePreparedSite(parsed))).inputs).toEqual(inputs);
  });

  test("accepts an envelope without inputs", () => {
    const parsed = parsePreparedSite(PREPARED);

    expect(parsed.inputs).toBeUndefined();
    expect(serializePreparedSite(parsed)).not.toContain("inputs");
  });

  test("inputs never change the serialized artifact", () => {
    const withProvenance = parsePreparedSite(withInputs([{ path: "package.json", digest: DIGEST_A }]));

    expect(JSON.stringify(withProvenance.artifact)).toBe(JSON.stringify(parsePreparedSite(PREPARED).artifact));
  });

  const inputCases = [
    { name: "a non-array", inputs: {}, path: "$.inputs" },
    { name: "a sparse entry", inputs: sparseArray(), path: "$.inputs[0]" },
    {
      name: "an uppercase digest",
      inputs: [{ path: "package.json", digest: `sha256:${"A".repeat(64)}` }],
      path: "$.inputs[0].digest",
    },
    {
      name: "a short digest",
      inputs: [{ path: "package.json", digest: `sha256:${"a".repeat(63)}` }],
      path: "$.inputs[0].digest",
    },
    {
      name: "a digest without the algorithm prefix",
      inputs: [{ path: "package.json", digest: "a".repeat(64) }],
      path: "$.inputs[0].digest",
    },
    {
      name: "an unsorted list",
      inputs: [
        { path: "package.json", digest: DIGEST_A },
        { path: "astro.config.mjs", digest: DIGEST_A },
      ],
      path: "$.inputs[1].path",
    },
    {
      name: "a duplicate path",
      inputs: [
        { path: "package.json", digest: DIGEST_A },
        { path: "package.json", digest: DIGEST_B },
      ],
      path: "$.inputs[1].path",
    },
    {
      name: "a parent segment",
      inputs: [{ path: "../package.json", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "a current-directory segment",
      inputs: [{ path: "./package.json", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "a leading slash",
      inputs: [{ path: "/package.json", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "a backslash-separated parent segment",
      inputs: [{ path: "..\\x", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "a drive-letter path",
      inputs: [{ path: "C:\\x", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "an empty path",
      inputs: [{ path: "", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "an unknown entry field",
      inputs: [{ path: "package.json", digest: DIGEST_A, size: 12 }],
      path: "$.inputs[0].size",
    },
    {
      name: "a missing digest",
      inputs: [{ path: "package.json" }],
      path: "$.inputs[0].digest",
    },
  ];

  for (const scenario of inputCases) {
    test(`rejects ${scenario.name}`, () => {
      expect(formatError(withInputs(scenario.inputs)).path).toBe(scenario.path);
    });
  }

  test("digests bytes as prefixed lowercase SHA-256", async () => {
    expect(await digestArtifactInput(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await digestArtifactInput(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
