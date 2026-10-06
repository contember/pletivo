import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  type ArtifactModule,
  type ArtifactResolution,
  type PreparedSite,
} from "@pletivo/core/artifact";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { createCompileCache } from "../src/compile-cache.ts";
import { compileProject, UnsupportedFileError } from "../src/compile-project.ts";
import {
  ModuleIdentityCollisionError,
  UnsupportedArtifactExternalError,
} from "../src/artifact.ts";
import { loadProjectArtifact } from "../src/project-artifact.ts";
import { finalizeHtml, pageCss } from "../src/page-css.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { codeOf, hasModule, importsOf, nameOf, stylesheetsOf, stylesOf } from "./compiled.ts";

const compiler = createAstroCompiler(await astroWasmModule());

const IDs = {
  sameA: "npm:a/same.js",
  sameB: "npm:b/same.js",
  root: "virtual:root",
  data: "virtual:data.json",
  chip: "virtual:Chip.tsx",
  card: "npm:widget/Card.astro",
  base: "npm:widget/Base.astro",
  css: "npm:widget/card.css",
  theme: "npm:widget/theme.css",
  slash: "virtual:a/b",
  underscore: "virtual:a_b",
  unused: "npm:unused/index.js",
};

const MODULES: ArtifactModule[] = [
  { id: IDs.sameA, kind: "js", source: `export const SAME = "a";\n` },
  { id: IDs.sameB, kind: "js", source: `export const SAME = "b";\n` },
  {
    id: IDs.root,
    kind: "ts",
    source: `import data from "./data.json";\nimport Chip from "./Chip.tsx";\nexport { data, Chip };\n`,
  },
  { id: IDs.data, kind: "json", source: `{"label":"ok"}` },
  {
    id: IDs.chip,
    kind: "tsx",
    source: `export default function Chip({ label }: { label: string }) { return <b>{label}</b>; }\n`,
  },
  {
    id: IDs.card,
    kind: "astro",
    compilePath: "../node_modules/widget/Card.astro",
    source: `---\nimport Base from "./Base.astro";\nimport "./card.css";\n---\n<Base><span>card</span></Base>\n<style>span { color: red; }</style>\n`,
  },
  {
    id: IDs.base,
    kind: "astro",
    compilePath: "../node_modules/widget/Base.astro",
    source: `<section><slot /></section>\n<style>section { display: block; }</style>\n`,
  },
  { id: IDs.css, kind: "css", source: `@import "./theme.css";\n.card { color: blue; }\n` },
  { id: IDs.theme, kind: "css", source: `:root { --theme: blue; }\n` },
  { id: IDs.slash, kind: "js", source: `export default "slash";\n` },
  { id: IDs.underscore, kind: "js", source: `export default "underscore";\n` },
  { id: IDs.unused, kind: "js", source: `export const UNUSED = true;\n` },
];

const RESOLUTIONS: ArtifactResolution[] = [
  edge("project:src/pages/index.astro", "same", IDs.sameA),
  edge("project:src/pages/index.astro", "virtual:root", IDs.root),
  edge("project:src/pages/index.astro", "widget/Card.astro", IDs.card),
  edge("project:src/pages/index.astro", "widget/card.css", IDs.css),
  edge("project:src/pages/index.astro", "virtual:a/b", IDs.slash),
  edge("project:src/pages/index.astro", "virtual:a_b", IDs.underscore),
  edge("project:src/pages/other.astro", "same", IDs.sameB),
  edge(IDs.root, "./data.json", IDs.data),
  edge(IDs.root, "./Chip.tsx", IDs.chip),
  edge(IDs.card, "./Base.astro", IDs.base),
  edge(IDs.card, "./card.css", IDs.css),
  edge(IDs.css, "./theme.css", IDs.theme),
];

const PREPARED: PreparedSite = {
  artifact: {
    version: ARTIFACT_VERSION,
    config: { site: "https://example.test" },
    scripts: { headInline: ["window.ready = true;"], page: ["import 'ready';"] },
    modules: MODULES,
    resolutions: RESOLUTIONS,
  },
};

const PROJECT = new Map<string, string>([
  [
    "src/pages/index.astro",
    `---
import { SAME } from "same";
import { data, Chip } from "virtual:root";
import Card from "widget/Card.astro";
import "widget/card.css";
import slash from "virtual:a/b";
import underscore from "virtual:a_b";
---
<Card /><Chip label={data.label} /><p>{SAME}{slash}{underscore}</p>
`,
  ],
  ["src/pages/other.astro", `---\nimport { SAME } from "same";\n---\n<p>{SAME}</p>\n`],
]);

function edge(importer: string, specifier: string, id: string): ArtifactResolution {
  return { importer, specifier, target: { kind: "module", id } };
}

function bodyOf(
  compiled: Awaited<ReturnType<typeof compileProject>>,
  logicalFile: string,
): string {
  const body = codeOf(compiled, logicalFile);
  if (body === undefined) throw new Error(`Missing module body for ${logicalFile}`);
  return body;
}

describe("Artifact V2 compiler consumer", () => {
  test("uses project importer IDs and importer-dependent resolutions", async () => {
    const index = await compileProject({
      files: PROJECT,
      entries: ["src/pages/index.astro"],
      compiler,
      artifact: loadProjectArtifact(PREPARED),
    });
    const other = await compileProject({
      files: PROJECT,
      entries: ["src/pages/other.astro"],
      compiler,
      artifact: loadProjectArtifact(PREPARED),
    });

    expect(importsOf(index, "src/pages/index.astro")).toContain(IDs.sameA);
    expect(bodyOf(index, "src/pages/index.astro")).toContain(
      `"./${nameOf(IDs.sameA)}"`,
    );
    expect(bodyOf(other, "src/pages/other.astro")).toContain(
      `"./${nameOf(IDs.sameB)}"`,
    );
  });

  test("walks a transitive virtual graph and deliberately compiles JSON and TSX", async () => {
    const compiled = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED) });

    expect(bodyOf(compiled, IDs.data)).toBe(`export default {"label":"ok"};\n`);
    expect(bodyOf(compiled, IDs.chip)).not.toContain(": { label: string }");
    expect(bodyOf(compiled, IDs.chip)).toContain(
      `"./pletivo-jsx-runtime.js"`,
    );
    expect(hasModule(compiled, IDs.unused)).toBe(false);
  });

  test("keeps package Astro and CSS in one ordered graph", async () => {
    const compiled = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED) });

    expect(importsOf(compiled, "src/pages/index.astro")).toEqual([
      IDs.sameA,
      IDs.root,
      IDs.card,
      IDs.slash,
      IDs.underscore,
    ]);
    expect(importsOf(compiled, IDs.card)).toEqual([IDs.base]);
    expect(stylesheetsOf(compiled, "src/pages/index.astro")).toEqual([IDs.css]);
    expect(stylesheetsOf(compiled, IDs.card)).toEqual([IDs.css]);
    expect(stylesheetsOf(compiled, IDs.css)).toEqual([IDs.theme]);
    expect(compiled.styleGraph.styleEdges).toContainEqual({ importer: IDs.css, target: IDs.theme });
    expect(stylesOf(compiled, IDs.card)?.blocks[0]?.css).toContain("astro-");
  });

  test("makes every rewritten module import agree with its canonical edge", async () => {
    const compiled = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED) });
    for (const edge of [...compiled.styleGraph.executionEdges, ...compiled.styleGraph.styleEdges]) {
      const importerBody = compiled.program.modules[nameOf(edge.importer)];
      expect(importerBody, edge.importer).toBeString();
      // A stylesheet's own `@import` edges stay out of its empty Loader module.
      if (importerBody === "export {};\n") continue;
      expect(importerBody, edge.importer).toContain(`"./${nameOf(edge.target)}"`);
    }
    expect(bodyOf(compiled, IDs.root)).toContain(
      `import data from "./${nameOf(IDs.data)}"`,
    );
    expect(bodyOf(compiled, IDs.root)).toContain(
      `import Chip from "./${nameOf(IDs.chip)}"`,
    );
  });

  test("uses logical artifact IDs for Astro render tracking even when compile paths collide", async () => {
    const source = `<p>shared</p>\n<style is:global>.shared { color: red; }</style>\n`;
    const firstId = "npm:first/Shared.astro";
    const secondId = "npm:second/Shared.astro";
    const prepared: PreparedSite = {
      artifact: {
        version: ARTIFACT_VERSION,
        config: {},
        scripts: { headInline: [], page: [] },
        modules: [
          { id: firstId, kind: "astro", source, compilePath: "shared/Shared.astro" },
          { id: secondId, kind: "astro", source, compilePath: "shared/Shared.astro" },
        ],
        resolutions: [
          edge("project:src/pages/index.js", "first", firstId),
          edge("project:src/pages/index.js", "second", secondId),
        ],
      },
    };
    const cache = createCompileCache();
    const compiled = await compileProject({
      files: new Map([["src/pages/index.js", `import First from "first";\nimport Second from "second";\nexport { First, Second };\n`]]),
      entries: ["src/pages/index.js"],
      compiler,
      artifact: loadProjectArtifact(prepared),
      cache,
    });

    expect(bodyOf(compiled, firstId)).toContain(`, '${firstId}', undefined);`);
    expect(bodyOf(compiled, secondId)).toContain(`, '${secondId}', undefined);`);
    expect(bodyOf(compiled, secondId)).not.toContain(`, '${firstId}', undefined);`);
    expect(pageCss({
      entry: "project:src/pages/index.js",
      graph: compiled.styleGraph,
      html: "",
      renderedModules: new Set([secondId]),
    })).toContain(".shared");
  });

  test("resolves artifact-relative names before host aliases", async () => {
    const root = "virtual:relative-root";
    const target = "virtual:relative-runtime";
    const prepared: PreparedSite = {
      artifact: {
        version: ARTIFACT_VERSION,
        config: {},
        scripts: { headInline: [], page: [] },
        modules: [
          { id: root, kind: "js", source: `import value from "./pletivo-runtime.js";\nexport default value;\n` },
          { id: target, kind: "js", source: `export default "artifact";\n` },
        ],
        resolutions: [
          edge("project:src/pages/index.js", "root", root),
          edge(root, "./pletivo-runtime.js", target),
        ],
      },
    };
    const compiled = await compileProject({
      files: new Map([["src/pages/index.js", `import value from "root";\nexport default value;\n`]]),
      entries: ["src/pages/index.js"],
      artifact: loadProjectArtifact(prepared),
      compiler,
    });
    expect(bodyOf(compiled, root)).toContain(`"./${nameOf(target)}"`);
    expect(importsOf(compiled, root)).toEqual([target]);
  });

  test("assigns names from raw aliases to their resolved env external", async () => {
    const prepared: PreparedSite = {
      artifact: {
        version: ARTIFACT_VERSION,
        config: {},
        scripts: { headInline: [], page: [] },
        modules: [],
        resolutions: [
          { importer: "project:src/pages/index.js", specifier: "public-env", target: { kind: "external", specifier: "astro:env/client" } },
          { importer: "project:src/pages/index.js", specifier: "private-env", target: { kind: "external", specifier: "astro:env/server" } },
        ],
      },
    };
    const compiled = await compileProject({
      files: new Map([["src/pages/index.js", `const before = true;\nimport { PUBLIC as browser } from "public-env";\nimport { TOKEN } from "private-env";\nexport { before, browser, TOKEN };\n`]]),
      entries: ["src/pages/index.js"],
      artifact: loadProjectArtifact(prepared),
      compiler,
    });
    expect(compiled.program.requirements.env).toEqual({ client: ["PUBLIC"], server: ["TOKEN"] });
    expect(compiled.program.requirements.env).toEqual(compiled.program.requirements.env);
  });

  test("uses collision-proof names derived from full ModuleIds", async () => {
    const first = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED) });
    const second = await compileProject({ files: new Map([...PROJECT].reverse()), entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED) });

    expect(nameOf(IDs.slash)).not.toBe(nameOf(IDs.underscore));
    expect(nameOf(IDs.slash)).toBe(nameOf(IDs.slash));
    expect(nameOf(IDs.underscore)).toBe(nameOf(IDs.underscore));
  });

  test("recomputes artifact resolution and graph effects on a compile-cache hit", async () => {
    const cache = createCompileCache();
    const cold = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED), cache });
    const unchangedWarm = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(PREPARED), cache });
    const changed: PreparedSite = {
      artifact: {
        ...PREPARED.artifact,
        resolutions: PREPARED.artifact.resolutions.map((resolution) =>
          resolution.importer === "project:src/pages/index.astro" && resolution.specifier === "same"
            ? edge(resolution.importer, resolution.specifier, IDs.sameB)
            : resolution,
        ),
      },
    };
    const warm = await compileProject({ files: PROJECT, entries: ["src/pages/index.astro"], compiler, artifact: loadProjectArtifact(changed), cache });

    expect(unchangedWarm.program.requirements).toEqual(cold.program.requirements);
    expect(unchangedWarm.styleGraph).toEqual(cold.styleGraph);
    expect(bodyOf(cold, "src/pages/index.astro")).toContain(`"./${nameOf(IDs.sameA)}"`);
    expect(bodyOf(warm, "src/pages/index.astro")).toContain(`"./${nameOf(IDs.sameB)}"`);
    expect(importsOf(warm, "src/pages/index.astro")).toContain(IDs.sameB);
    expect(importsOf(warm, "src/pages/index.astro")).not.toContain(IDs.sameA);
  });

  test("rejects unsupported externals and absent artifact resolutions loudly", async () => {
    const unknownExternal: PreparedSite = {
      artifact: {
        version: ARTIFACT_VERSION,
        config: {},
        scripts: { headInline: [], page: [] },
        modules: [],
        resolutions: [
          {
            importer: "project:src/pages/index.astro",
            specifier: "unsafe",
            target: { kind: "external", specifier: "node:fs" },
          },
        ],
      },
    };
    expect(() => loadProjectArtifact(unknownExternal)).toThrow(UnsupportedArtifactExternalError);
    await expect(
      compileProject({
        files: new Map([["src/pages/a.astro", `---\nimport "missing-package";\n---\n<p>a</p>\n`]]),
        entries: ["src/pages/a.astro"],
        compiler,
      }),
    ).rejects.toThrow(/src\/pages\/a\.astro.*missing-package/);
  });

  test("strictly rejects wrong-version and dangling artifacts", () => {
    const wrongVersion = JSON.parse(JSON.stringify(PREPARED));
    wrongVersion.artifact.version = 1;
    expect(() => loadProjectArtifact(wrongVersion)).toThrow(ArtifactVersionError);

    const dangling = JSON.parse(JSON.stringify(PREPARED));
    dangling.artifact.resolutions[0].target.id = "npm:missing/index.js";
    expect(() => loadProjectArtifact(dangling)).toThrow(ArtifactFormatError);
  });

  test("reserves Worker-owned ModuleId namespaces", () => {
    const prepared: PreparedSite = {
      artifact: {
        version: ARTIFACT_VERSION,
        config: {},
        scripts: { headInline: [], page: [] },
        modules: [{ id: "project:src/pages/index.js", kind: "js", source: "export {};\n" }],
        resolutions: [],
      },
    };
    expect(() => loadProjectArtifact(prepared)).toThrow(ModuleIdentityCollisionError);
  });

  test("rejects conflicting project descriptors under one normalized ModuleId", async () => {
    await expect(
      compileProject({
        files: new Map([
          ["src/pages/../index.js", `export default "first";\n`],
          ["src/index.js", `export default "second";\n`],
        ]),
        compiler,
      }),
    ).rejects.toBeInstanceOf(ModuleIdentityCollisionError);
  });
});

describe("injected scripts and strict parsing", () => {
  test("emits the two supported script stages after page CSS", () => {
    const html = finalizeHtml(
      "<html><head><title>t</title></head><body><p>x</p></body></html>",
      [".site{color:blue}"],
      PREPARED.artifact.scripts,
    );
    expect(html).toContain(
      `<style>.site{color:blue}</style>\n<script>window.ready = true;</script>\n` +
        `<script type="module">import 'ready';</script>\n</head>`,
    );
  });

  test("round-trips the V2 fixture", () => {
    expect(loadProjectArtifact(JSON.parse(JSON.stringify(PREPARED))).prepared).toEqual(PREPARED);
  });

  test("exposes unresolved imports as UnsupportedFileError", async () => {
    await expect(
      compileProject({
        files: new Map([["src/pages/a.ts", `import "missing";`]]),
        entries: ["src/pages/a.ts"],
        compiler,
      }),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});
