import { afterEach, describe, expect, test } from "bun:test";
import { ARTIFACT_VERSION, TAILWIND_MODULE_PREFIX, type PreparedSite } from "@pletivo/core/artifact";
import { loadProjectArtifact } from "../src/artifact.ts";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { UnresolvedImportError } from "../src/compile-project.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

const compiler = createAstroCompiler(await astroWasmModule());
const loaders: FileLoader[] = [];
afterEach(async () => {
  for (const loader of loaders.splice(0)) await loader.cleanup();
});

function newLoader(): FileLoader {
  const loader = new FileLoader();
  loaders.push(loader);
  return loader;
}

const STYLESHEET = "project:src/styles/global.css";
const PLUGIN_ID = `${TAILWIND_MODULE_PREFIX}fixture-plugin`;
const CONFIG_ID = `${TAILWIND_MODULE_PREFIX}fixture-config`;

/** What `pletivo prepare` makes of a plugin package: one ES module, the plugin as its default export. */
const PLUGIN_MODULE = `
export default function fixturePlugin({ addBase, addUtilities, matchUtilities }) {
  addBase({ h1: { "--fixture-base": "on" } });
  addUtilities({ ".fixture-box": { display: "grid" } });
  matchUtilities({ "fixture-pad": (value) => ({ padding: value }) }, { values: { sm: "1px", lg: "9px" } });
}
`;
const CONFIG_MODULE = `export default { theme: { extend: { colors: { brand: "#123456" } } } };\n`;

function project(stylesheet: string): Map<string, string> {
  return new Map([
    [
      "src/pages/index.astro",
      `---\nimport "../styles/global.css";\n---\n<html><body><h1 class="fixture-box fixture-pad-lg text-brand">hi</h1></body></html>\n`,
    ],
    ["src/pages/other.astro", `---\nimport "../styles/global.css";\n---\n<p class="fixture-pad-sm">other</p>\n`],
    ["src/styles/global.css", stylesheet],
  ]);
}

const PREPARED: PreparedSite = {
  artifact: {
    version: ARTIFACT_VERSION,
    config: {},
    scripts: { headInline: [], page: [] },
    modules: [
      { id: PLUGIN_ID, kind: "js", source: PLUGIN_MODULE },
      { id: CONFIG_ID, kind: "js", source: CONFIG_MODULE },
    ],
    resolutions: [
      { importer: STYLESHEET, specifier: "fixture-plugin", target: { kind: "module", id: PLUGIN_ID } },
      { importer: STYLESHEET, specifier: "fixture-config", target: { kind: "module", id: CONFIG_ID } },
    ],
  },
};

const TAILWIND_MAIN = "pletivo-tailwind-main.js";

function tailwindIsolates(loader: FileLoader): number {
  return [...loader.bundles.values()].filter((bundle) => bundle.mainModule === TAILWIND_MAIN).length;
}

describe.skipIf(tailwindDir() === null)("Tailwind @plugin and @config", () => {
  test("renders a page with a plugin's base, static and functional utilities and a config's theme", async () => {
    const loader = newLoader();
    const options = {
      files: project('@import "tailwindcss";\n@plugin "fixture-plugin";\n@config "fixture-config";\n'),
      loader,
      compiler,
      artifact: loadProjectArtifact(PREPARED),
      tailwind: await tailwindStylesheets(),
    };
    const { html } = await renderPage({ ...options, pathname: "/" });

    expect(html).toContain("--fixture-base: on");
    expect(html).toMatch(/\.fixture-box\s*\{\s*display: grid;/);
    expect(html).toMatch(/\.fixture-pad-lg\s*\{\s*padding: 9px;/);
    expect(html).not.toContain(".fixture-pad-sm");
    expect(html).toContain("#123456");
    expect(html).not.toContain("@plugin");

    // A second page reuses the isolate: only the candidates changed.
    const other = await renderPage({ ...options, pathname: "/other" });
    expect(other.html).toMatch(/\.fixture-pad-sm\s*\{\s*padding: 1px;/);
    expect(tailwindIsolates(loader)).toBe(1);
    const [tailwind] = [...loader.bundles.values()].filter((bundle) => bundle.mainModule === TAILWIND_MAIN);
    expect(tailwind?.globalOutbound).toBeNull();
  });

  test("returns a plugin's throw as an error, not a failed isolate start", async () => {
    const loader = newLoader();
    const prepared: PreparedSite = {
      artifact: {
        ...PREPARED.artifact,
        modules: [{ id: PLUGIN_ID, kind: "js", source: 'export default function () { throw new Error("plugin broke"); }\n' }],
        resolutions: [PREPARED.artifact.resolutions[0]],
      },
    };
    await expect(
      renderPage({
        files: project('@import "tailwindcss";\n@plugin "fixture-plugin";\n'),
        loader,
        compiler,
        artifact: loadProjectArtifact(prepared),
        tailwind: await tailwindStylesheets(),
        pathname: "/",
      }),
    ).rejects.toThrow("plugin broke");
  });

  test("a rule the artifact does not answer is a missing import", async () => {
    const loader = newLoader();
    const rendering = renderPage({
      files: project('@import "tailwindcss";\n@plugin "not-prepared";\n'),
      loader,
      compiler,
      artifact: loadProjectArtifact(PREPARED),
      tailwind: await tailwindStylesheets(),
      pathname: "/",
    });
    const error = await rendering.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(UnresolvedImportError);
    if (!(error instanceof UnresolvedImportError)) return;
    expect(error.kind).toBe("missing");
    expect(error.importer).toBe(STYLESHEET);
    expect(error.specifier).toBe("not-prepared");
  });

  test("a commented-out rule and a project without plugins compile in the host", async () => {
    const loader = newLoader();
    const { html } = await renderPage({
      files: project('@import "tailwindcss";\n/* @plugin "fixture-plugin"; */\n'),
      loader,
      compiler,
      tailwind: await tailwindStylesheets(),
      pathname: "/",
    });
    expect(html).toContain("<h1");
    expect(html).not.toContain(".fixture-box");
    expect(loader.bundles.size).toBeGreaterThan(0);
    expect(tailwindIsolates(loader)).toBe(0);
  });
});
