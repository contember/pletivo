import { afterEach, describe, expect, test } from "bun:test";
import { ARTIFACT_VERSION, TAILWIND_MODULE_PREFIX, tailwindModuleSpecifier, type PreparedSite } from "@pletivo/core/artifact";
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
      { importer: STYLESHEET, specifier: tailwindModuleSpecifier("plugin", "fixture-plugin"), target: { kind: "module", id: PLUGIN_ID } },
      { importer: STYLESHEET, specifier: tailwindModuleSpecifier("config", "fixture-config"), target: { kind: "module", id: CONFIG_ID } },
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
    // The rule's resolution specifier: what an artifact prepared since answers it under.
    expect(error.specifier).toBe("@plugin not-prepared");
    expect(loadProjectArtifact(PREPARED).resolver.resolve(STYLESHEET, "@plugin fixture-plugin")).toEqual({ kind: "module", id: PLUGIN_ID });
  });

  test("an unanswered rule naming a project file fails against any artifact; a path into node_modules is missing", async () => {
    const failure = async (rule: string): Promise<UnresolvedImportError> => {
      const error = await renderPage({
        files: project(`@import "tailwindcss";\n${rule}\n`),
        loader: newLoader(),
        compiler,
        artifact: loadProjectArtifact(PREPARED),
        tailwind: await tailwindStylesheets(),
        pathname: "/",
      }).then(
        () => null,
        (reason: unknown) => reason,
      );
      if (!(error instanceof UnresolvedImportError)) throw new Error(`${rule} did not fail as unresolved: ${String(error)}`);
      return error;
    };
    const config = await failure('@config "../../tailwind.config.js";');
    expect(config.kind).toBe("tailwind-module-not-a-package");
    expect(config.specifier).toBe("@config ../../tailwind.config.js");
    expect((await failure('@plugin "../../../outside.js";')).kind).toBe("tailwind-module-not-a-package");
    const packaged = await failure('@plugin "../../node_modules/kit/plugin.js";');
    expect(packaged.kind).toBe("missing");
    expect(packaged.specifier).toBe("@plugin ../../node_modules/kit/plugin.js");
    // A monorepo's node_modules, hoisted above the project root.
    expect((await failure('@plugin "../../../../node_modules/kit/plugin.js";')).kind).toBe("missing");
    expect((await failure('@plugin "/repo/node_modules/kit/plugin.js";')).kind).toBe("missing");
    expect((await failure('@plugin "/repo/node_modules/../plugin.js";')).kind).toBe("tailwind-module-not-a-package");
  });

  test("a module of the same id with other source builds another isolate program", async () => {
    const loader = newLoader();
    const files = project('@import "tailwindcss";\n@plugin "fixture-plugin";\n');
    const withPlugin = (source: string) =>
      loadProjectArtifact({
        artifact: {
          ...PREPARED.artifact,
          modules: [{ id: PLUGIN_ID, kind: "js", source }],
          resolutions: [PREPARED.artifact.resolutions[0]],
        },
      });
    const plugin = (display: string) =>
      `export default function ({ addUtilities }) { addUtilities({ ".fixture-box": { display: "${display}" } }); }\n`;
    const stylesheets = await tailwindStylesheets();
    const first = await renderPage({ files, loader, compiler, artifact: withPlugin(plugin("grid")), tailwind: stylesheets, pathname: "/" });
    const second = await renderPage({ files, loader, compiler, artifact: withPlugin(plugin("flex")), tailwind: stylesheets, pathname: "/" });
    expect(first.html).toMatch(/\.fixture-box\s*\{\s*display: grid;/);
    expect(second.html).toMatch(/\.fixture-box\s*\{\s*display: flex;/);
    expect(tailwindIsolates(loader)).toBe(2);
  });

  test("an @import and a @plugin of the same package resolve apart", async () => {
    const loader = newLoader();
    const files = project('@import "tailwindcss";\n@import "fixture-plugin";\n@plugin "fixture-plugin";\n');
    files.set("node_modules/fixture-plugin/style.css", ".from-import { color: red; }\n");
    const prepared: PreparedSite = {
      artifact: {
        ...PREPARED.artifact,
        modules: [...PREPARED.artifact.modules, { id: "npm:fixture-plugin/style.css", kind: "css", source: ".from-import { color: red; }\n" }],
        resolutions: [
          ...PREPARED.artifact.resolutions,
          { importer: STYLESHEET, specifier: "fixture-plugin", target: { kind: "module", id: "npm:fixture-plugin/style.css" } },
        ],
      },
    };
    const { html } = await renderPage({
      files,
      loader,
      compiler,
      artifact: loadProjectArtifact(prepared),
      tailwind: await tailwindStylesheets(),
      pathname: "/",
    });
    expect(html).toContain(".from-import");
    expect(html).toMatch(/\.fixture-box\s*\{\s*display: grid;/);
  });

  test("a @plugin reached only through @reference names the limit", async () => {
    const loader = newLoader();
    // Tailwind follows a `@reference` from a stylesheet with no `@import` edges of its own.
    const files = project("");
    files.set("src/styles/part.css", '@reference "./ref.css";\n');
    files.set("src/styles/ref.css", '@plugin "fixture-plugin";\n');
    const stylesheets = await tailwindStylesheets();
    const render = (stylesheet: string) => {
      files.set("src/styles/global.css", stylesheet);
      return renderPage({
        files,
        loader,
        compiler,
        artifact: loadProjectArtifact(PREPARED),
        tailwind: stylesheets,
        pathname: "/",
      });
    };
    // In the host, and in the isolate a closure with its own rule compiles in.
    await expect(render('@import "tailwindcss";\n@import "./part.css";\n')).rejects.toThrow("not through @reference");
    await expect(render('@import "tailwindcss";\n@import "./part.css";\n@config "fixture-config";\n')).rejects.toThrow(
      "not through @reference",
    );
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
