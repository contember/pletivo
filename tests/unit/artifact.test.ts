import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  digestArtifactInput,
  parsePreparedSite,
  serializePreparedSite,
  type ArtifactIslands,
  type ArtifactResolution,
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

  test("carries browser resolutions, which may only target carried modules", () => {
    const browserResolutions: ArtifactResolution[] = [
      {
        importer: "project:*",
        specifier: "entry",
        target: { kind: "module", id: "artifact:entry.js" },
      },
    ];
    const parsed = parsePreparedSite(JSON.parse(serializePreparedSite(artifactWith({ browserResolutions }))));
    expect(parsed.artifact.browserResolutions).toEqual(browserResolutions);
    expect(parsePreparedSite(artifactWith({})).artifact.browserResolutions).toBeUndefined();

    const external = artifactWith({
      browserResolutions: [
        { importer: "project:*", specifier: "astro:content", target: { kind: "external", specifier: "astro:content" } },
      ],
    });
    expect(formatError(external).path).toBe("$.artifact.browserResolutions[0].target.kind");
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

describe("site artifact islands", () => {
  const BUNDLE = [
    { id: "islands-bundle:0f/renderer.js", kind: "js", source: "export default {};" },
    { id: "islands-bundle:0f/Counter.js", kind: "js", source: "export default 1;" },
  ];
  const ISLANDS: ArtifactIslands = {
    projectRoot: "/srv/site",
    renderers: [
      { name: "@astrojs/vue", clientEntrypoint: "@astrojs/vue/client.js", server: "islands-bundle:0f/renderer.js" },
      { name: "@astrojs/react", clientEntrypoint: null, server: "islands-bundle:0f/renderer.js" },
    ],
    scripts: { island: "island()", directives: { visible: "v()", load: "l()" } },
    components: [{ file: "src/components/Counter.vue", module: "islands-bundle:0f/Counter.js" }],
    stylesheets: [{ file: "src/components/Counter.vue.pletivo-style.css", source: ".a{}" }],
    clients: [
      {
        url: "/_astro/Counter.AbC-12_x.js",
        source: 'import{a}from"./chunk-k1.js";export{a as default};',
        imports: ["/_astro/chunk-k1.js"],
        sources: ["src/components/Counter.vue"],
      },
      { url: "/_astro/chunk-k1.js", source: "export const a=1;", imports: [], sources: [] },
      { url: "/_astro/client.svelte.Zz9.js", source: "export default 1;", imports: [], sources: [] },
    ],
  };
  const [COUNTER_CLIENT, CHUNK_CLIENT] = ISLANDS.clients;

  function withIslands(islands: unknown): unknown {
    return artifactWith({ modules: BUNDLE, islands });
  }

  test("round-trips, keeping renderer order and sorting directives and client modules", () => {
    const shuffled = { ...ISLANDS, clients: [...ISLANDS.clients].reverse() };
    const parsed = parsePreparedSite(JSON.parse(serializePreparedSite(withIslands(shuffled))));
    expect(parsed.artifact.islands).toEqual(ISLANDS);
    expect(parsed.artifact.islands?.renderers.map((renderer) => renderer.name)).toEqual(["@astrojs/vue", "@astrojs/react"]);
    expect(Object.keys(parsed.artifact.islands?.scripts.directives ?? {})).toEqual(["load", "visible"]);
    expect(parsePreparedSite(artifactWith({})).artifact.islands).toBeUndefined();
  });

  const scenarios: { name: string; islands: unknown; path: string }[] = [
    { name: "an unknown field", islands: { ...ISLANDS, base: "/" }, path: "$.artifact.islands.base" },
    { name: "a Windows project root", islands: { ...ISLANDS, projectRoot: "C:\\site" }, path: "$.artifact.islands.projectRoot" },
    { name: "a relative project root", islands: { ...ISLANDS, projectRoot: "srv/site" }, path: "$.artifact.islands.projectRoot" },
    { name: "no renderers", islands: { ...ISLANDS, renderers: [] }, path: "$.artifact.islands.renderers" },
    {
      name: "a duplicate renderer",
      islands: { ...ISLANDS, renderers: [ISLANDS.renderers[0], ISLANDS.renderers[0]] },
      path: "$.artifact.islands.renderers[1].name",
    },
    {
      name: "a renderer server outside the islands bundle",
      islands: { ...ISLANDS, renderers: [{ ...ISLANDS.renderers[0], server: "artifact:entry.js" }] },
      path: "$.artifact.islands.renderers[0].server",
    },
    {
      name: "a component module that is not carried",
      islands: { ...ISLANDS, components: [{ file: "src/A.vue", module: "islands-bundle:0f/missing.js" }] },
      path: "$.artifact.islands.components[0].module",
    },
    {
      name: "a component path outside the project",
      islands: { ...ISLANDS, components: [{ file: "../A.vue", module: "islands-bundle:0f/Counter.js" }] },
      path: "$.artifact.islands.components[0].file",
    },
    {
      name: "a stylesheet that is not CSS",
      islands: { ...ISLANDS, stylesheets: [{ file: "src/A.js", source: "" }] },
      path: "$.artifact.islands.stylesheets[0].file",
    },
    {
      name: "a stylesheet at a component's path",
      islands: { ...ISLANDS, stylesheets: [{ file: "src/components/Counter.vue", source: "" }] },
      path: "$.artifact.islands.stylesheets[0].file",
    },
    { name: "no client modules", islands: { ...ISLANDS, clients: undefined }, path: "$.artifact.islands.clients" },
    {
      name: "a client module outside /_astro/",
      islands: { ...ISLANDS, clients: [{ ...CHUNK_CLIENT, url: "/assets/chunk-k1.js" }] },
      path: "$.artifact.islands.clients[0].url",
    },
    {
      name: "a client module in a subdirectory",
      islands: { ...ISLANDS, clients: [{ ...CHUNK_CLIENT, url: "/_astro/../chunk-k1.js" }] },
      path: "$.artifact.islands.clients[0].url",
    },
    {
      name: "a client module that is not JavaScript",
      islands: { ...ISLANDS, clients: [{ ...CHUNK_CLIENT, url: "/_astro/chunk-k1.css" }] },
      path: "$.artifact.islands.clients[0].url",
    },
    {
      name: "a duplicate client module",
      islands: { ...ISLANDS, clients: [CHUNK_CLIENT, CHUNK_CLIENT] },
      path: "$.artifact.islands.clients[1].url",
    },
    {
      name: "a client module that imports one the artifact does not carry",
      islands: { ...ISLANDS, clients: [COUNTER_CLIENT] },
      path: "$.artifact.islands.clients[0].imports[0]",
    },
    {
      name: "a client source outside the project",
      islands: { ...ISLANDS, clients: [{ ...CHUNK_CLIENT, sources: ["../secret.js"] }] },
      path: "$.artifact.islands.clients[0].sources[0]",
    },
    {
      name: "a client module with an unknown field",
      islands: { ...ISLANDS, clients: [{ ...CHUNK_CLIENT, kind: "chunk" }] },
      path: "$.artifact.islands.clients[0].kind",
    },
    {
      name: "a directive that is not a string",
      islands: { ...ISLANDS, scripts: { island: "", directives: { load: 1 } } },
      path: "$.artifact.islands.scripts.directives.load",
    },
  ];
  for (const scenario of scenarios) {
    test(`rejects ${scenario.name}, by path`, () => {
      expect(formatError(withIslands(scenario.islands)).path).toBe(scenario.path);
    });
  }

  test("accepts an absolute POSIX, Windows drive or UNC project root", () => {
    for (const projectRoot of ["/srv/site", "C:/work/site", "//server/share/site"]) {
      expect(parsePreparedSite(withIslands({ ...ISLANDS, projectRoot })).artifact.islands?.projectRoot).toBe(projectRoot);
    }
  });

  test("lets only an islands bundle module import a Node built-in", () => {
    const importing = (importer: string) =>
      artifactWith({
        modules: BUNDLE,
        resolutions: [{ importer, specifier: "node:crypto", target: { kind: "external", specifier: "node:crypto" } }],
      });
    expect(parsePreparedSite(importing("islands-bundle:0f/Counter.js")).artifact.resolutions).toHaveLength(1);
    expect(formatError(importing("project:src/pages/index.astro")).path).toBe("$.artifact.resolutions[0].importer");
    expect(formatError(importing("artifact:entry.js")).path).toBe("$.artifact.resolutions[0].importer");
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

  test("accepts workspace inputs, sorted with the project's own", () => {
    const inputs = [
      { path: "package.json", digest: DIGEST_A },
      { path: "workspace:bun.lock", digest: DIGEST_B },
      { path: "workspace:package.json", digest: DIGEST_A },
    ];

    expect(parsePreparedSite(withInputs(inputs)).inputs).toEqual(inputs);
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
      name: "a workspace parent segment",
      inputs: [{ path: "workspace:../bun.lock", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "an empty workspace path",
      inputs: [{ path: "workspace:", digest: DIGEST_A }],
      path: "$.inputs[0].path",
    },
    {
      name: "an unknown prefix",
      inputs: [{ path: "root:bun.lock", digest: DIGEST_A }],
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
