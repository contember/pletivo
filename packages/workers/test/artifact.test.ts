import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactVersionError,
  parsePreparedSite,
  type PreparedSite,
  type SiteArtifact,
} from "@pletivo/core/artifact";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { compileProject } from "../src/compile-project.ts";
import { ArtifactTargetError } from "../src/artifact.ts";
import { finalizeHtml } from "../src/page-css.ts";
import { astroWasmModule } from "./astro-wasm.ts";

/**
 * The artifact seam, driven with a hand-written artifact rather than with
 * `pletivo prepare` — the two halves have to be provable apart, and this is the half
 * a Worker runs.
 *
 * `tests/integration/prepare.test.ts` is the producing half, and the vendor fixture in
 * `fixture-parity.test.ts` is both of them against `pletivo build`'s actual bytes.
 */

const compiler = createAstroCompiler(await astroWasmModule());

function artifactOf(partial: Partial<SiteArtifact>): SiteArtifact {
  return {
    version: ARTIFACT_VERSION,
    id: "test",
    config: { base: "/", trailingSlash: "ignore", build: { format: "directory" } },
    scripts: { headInline: [], page: [], beforeHydration: [] },
    virtualModules: {},
    vendor: {},
    generatedSources: {},
    diagnostics: [],
    ...partial,
  };
}

const PROJECT = new Map<string, string>([
  [
    "src/pages/index.astro",
    `---
import { Badge } from "widgets/components";
import { shout } from "widgets";
---
<html><head><title>t</title></head><body><Badge /><p>{shout("hi")}</p></body></html>
`,
  ],
]);

const PREPARED: PreparedSite = {
  artifact: artifactOf({
    vendor: {
      "widgets/components": "node_modules/widgets/components/index.ts",
      "node_modules/widgets/components/tone.js": "node_modules/widgets/components/tone.ts",
      widgets: "vendor.widgets.js",
    },
    virtualModules: { "virtual:widget-tokens": "virtual.widget-tokens.js" },
    generatedSources: {
      "node_modules/widgets/components/index.ts": `export { default as Badge } from "./Badge.astro";\n`,
      "node_modules/widgets/components/Badge.astro": `---
import tokens from "virtual:widget-tokens";
import { TONE } from "./tone.js";
---
<span>{tokens.label}{TONE}</span>
<style>span { color: red; }</style>
`,
      "node_modules/widgets/components/tone.ts": `export const TONE: string = "loud";\n`,
    },
  }),
  modules: {
    "vendor.widgets.js": `import { upper } from "./vendor.widgets.helper.js";\nexport const shout = (s) => upper(s);\n`,
    "vendor.widgets.helper.js": `export const upper = (s) => s.toUpperCase();\n`,
    "vendor.unused.js": `export const nobody = 1;\n`,
    "virtual.widget-tokens.js": `export default { label: "L" };\n`,
  },
};

// Pruned to the page, so the artifact's targets have to be reached and walked rather
// than named by a pass over the map: `widgets/components` names a *generated source*,
// and everything it imports is only in the bundle because the walk followed it there.
const compiled = await compileProject({
  files: PROJECT,
  entries: ["src/pages/index.astro"],
  compiler,
  artifact: PREPARED,
});

describe("a prepared artifact inside compileProject", () => {
  test("compiles a package's .astro at the path the artifact names it", () => {
    expect(compiled.moduleNames.has("node_modules/widgets/components/Badge.astro")).toBe(true);
    // The scope hash is derived from that path, so the `<style>` block has to be
    // collected under it too — that is what makes both hosts emit the same class.
    const styles = compiled.styles.get("node_modules/widgets/components/Badge.astro");
    expect(styles?.blocks.map((block) => block.css)).toEqual(["span:where(.astro-tgdqk3ug){color:red}"]);
  });

  test("points a bare specifier at the generated source it names", () => {
    const page = compiled.modules[compiled.moduleNames.get("src/pages/index.astro") ?? ""];
    const index = compiled.moduleNames.get("node_modules/widgets/components/index.ts");
    expect(page).toContain(`from "./${index}"`);
    expect(page).not.toContain("widgets/components");
  });

  test("redirects a package's own `./x.js` to the `x.ts` it lands on", () => {
    const badge = compiled.modules[
      compiled.moduleNames.get("node_modules/widgets/components/Badge.astro") ?? ""
    ];
    const tone = compiled.moduleNames.get("node_modules/widgets/components/tone.ts");
    expect(badge).toContain(`from "./${tone}"`);
    // …and the TypeScript annotation in it is gone, because the Loader cannot parse one.
    expect(compiled.modules[tone ?? ""]).toBe(`export const TONE = "loud";\n`);
  });

  test("answers a frozen virtual module, which no file map could hold", () => {
    const badge = compiled.modules[
      compiled.moduleNames.get("node_modules/widgets/components/Badge.astro") ?? ""
    ];
    expect(badge).toContain(`from "./virtual.widget-tokens.js"`);
    expect(compiled.modules["virtual.widget-tokens.js"]).toBe(`export default { label: "L" };\n`);
  });

  test("carries a vendored module and everything it imports, and nothing else", () => {
    expect(compiled.modules["vendor.widgets.js"]).toContain("shout");
    expect(compiled.modules["vendor.widgets.helper.js"]).toContain("upper");
    // The artifact holds it, the project never asks for it, so the bundle — and
    // therefore the isolate's content address — does not pay for it.
    expect("vendor.unused.js" in compiled.modules).toBe(false);
  });

  test("reports a target that names nothing, instead of leaving the import unresolved", async () => {
    const broken: PreparedSite = {
      artifact: artifactOf({ vendor: { widgets: "vendor.gone.js" } }),
      modules: {},
    };
    const files = new Map([["src/pages/a.astro", `---\nimport "widgets";\n---\n<p>a</p>\n`]]);
    expect(
      compileProject({ files, entries: ["src/pages/a.astro"], compiler, artifact: broken }),
    ).rejects.toThrow(ArtifactTargetError);
  });

  test("refuses an artifact from another generation rather than half-reading it", () => {
    const stale: PreparedSite = {
      artifact: { ...artifactOf({}), version: ARTIFACT_VERSION + 1 },
      modules: {},
    };
    expect(compileProject({ files: new Map(), compiler, artifact: stale })).rejects.toThrow(
      ArtifactVersionError,
    );
  });
});

describe("injected scripts in the finished page", () => {
  const page = "<html><head><title>t</title></head><body><p>x</p></body></html>";

  test("emits head-inline as a plain script and page as a module, in that order", () => {
    const html = finalizeHtml(page, [], {
      headInline: ["window.a = 1;"],
      page: ["import 'b';"],
      beforeHydration: ["never()"],
    });
    expect(html).toContain(
      `<script>window.a = 1;</script>\n<script type="module">import 'b';</script>\n</head>`,
    );
    // Moot until this host has islands, and dropped rather than emitted where it
    // would run unconditionally.
    expect(html).not.toContain("never()");
  });

  test("puts them after the page CSS, which is where writeHtml puts them", () => {
    const html = finalizeHtml(page, [".site{color:blue}", ".x{color:red}"], {
      headInline: ["window.a = 1;"],
      page: [],
      beforeHydration: [],
    });
    // Both stylesheets before the scripts, and the page's own sheet before the scoped
    // block it has to lose to.
    expect(html).toContain(
      "<style>.site{color:blue}</style>\n<style>.x{color:red}</style>\n<script>",
    );
    expect(html.indexOf("<style>")).toBeLessThan(html.indexOf("<script>"));
  });

  test("leaves a page with no head alone rather than inventing one", () => {
    const html = finalizeHtml("<p>x</p>", [], {
      headInline: ["window.a = 1;"],
      page: [],
      beforeHydration: [],
    });
    expect(html).toBe("<p>x</p>");
  });
});

describe("parsePreparedSite", () => {
  test("round-trips what prepare writes", () => {
    const parsed = parsePreparedSite(JSON.parse(JSON.stringify(PREPARED)));
    expect(parsed).toEqual(PREPARED);
  });

  test("rejects a body that only looks like one", () => {
    expect(parsePreparedSite({ artifact: PREPARED.artifact })).toBeNull();
    expect(parsePreparedSite({ artifact: { version: 1 }, modules: {} })).toBeNull();
    expect(parsePreparedSite({ ...PREPARED, modules: { a: 1 } })).toBeNull();
    expect(parsePreparedSite(null)).toBeNull();
  });
});
