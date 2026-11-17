/**
 * Astro's framework renderers on the Bun host. The integrations' own server renderers
 * (`addRenderer()`) render framework components into `<astro-island>`s, which their
 * client entrypoints hydrate from the bundles `bundleRenderedIslands` writes.
 *
 * Set up after `astro:config:setup`. A project without renderers changes nothing: no
 * compiler, no plugin, and the runtime's islands stay off.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { configureAstroIslands } from "@pletivo/runtime/astro-islands/index";
import type { IslandClientUrls, IslandScripts, LoadedRenderer, RendererServer } from "@pletivo/runtime/astro-islands/types";
import { bundleAstroIslands, createIslandClientUrls, type AstroIslandComponent, type VirtualModuleSource } from "./astro-islands-bundle";
import { resolveViteId, serveViteVirtualImports, tryLoadViteId } from "./astro-host/vite-plugins";
import { frameworkCompilePlugin, loadFrameworkCompilers } from "./framework-compile";
import { configureRegisteredRenderers } from "./framework-components";
import { collectCssSideEffectImports, setVirtualCss } from "./js-imported-css";
import { configureProjectCompilers } from "./project-source-plugin";

/** The project's renderers, loaded once per process. */
interface LoadedProject {
  projectRoot: string;
  entries: readonly AstroRendererEntry[];
  renderers: readonly LoadedRenderer[];
  /** Every compiler, for the client bundles. */
  compilers: readonly FrameworkCompiler[];
  /**
   * The server render's compilers for the project's own source files, which `project-source-plugin`
   * runs: its loader claims them first. The non-JSX ones also run as a Bun plugin, for the rest.
   */
  projectCompilers: readonly FrameworkCompiler[];
  scripts: IslandScripts;
}

export interface AstroRenderers {
  projectRoot: string;
  base: string;
  beforeHydrationScripts: readonly string[];
  entries: readonly AstroRendererEntry[];
  compilers: readonly FrameworkCompiler[];
  /** Every hydrated component export rendered since setup or added, in first-seen order. */
  hydratedComponents(): AstroIslandComponent[];
  /** The components the `<astro-island>`s in `html` hydrate, of those rendered since setup. */
  componentsIn(html: string): AstroIslandComponent[];
  /** Components a page hydrates that this build did not render: one restored from the incremental cache. */
  addHydratedComponents(components: readonly AstroIslandComponent[]): void;
}

/** An island's `component-url`, which names one component export (`createIslandClientUrls`). */
const ISLAND_COMPONENT_URL = /<astro-island\s[^>]*?\bcomponent-url="([^"]+)"/g;

let loaded: LoadedProject | null = null;

/** Astro's directives with a prebuilt script, `astro/dist/runtime/client/<name>.prebuilt.js`. */
const DIRECTIVES = ["load", "idle", "visible", "media", "only"];

export interface SetupAstroRenderersOptions {
  projectRoot: string;
  renderers: readonly AstroRendererEntry[];
  /** The site's base path, as island URLs carry it. */
  base: string;
  beforeHydrationScripts: readonly string[];
}

/**
 * Wire the registered renderers into the server render, or switch islands off when there
 * are none. Loads compilers, server modules and scripts once per process: Bun plugins
 * cannot be unregistered, so a process serves the renderers of one project.
 */
export async function setupAstroRenderers(options: SetupAstroRenderersOptions): Promise<AstroRenderers | null> {
  if (options.renderers.length === 0) {
    configureAstroIslands(null);
    configureProjectCompilers([]);
    configureRegisteredRenderers([]);
    return null;
  }
  const project = await loadProject(options.projectRoot, options.renderers);
  configureProjectCompilers(project.projectCompilers);
  configureRegisteredRenderers(project.entries.map((entry) => entry.name));

  const hydrated = new Map<string, AstroIslandComponent>();
  const byUrl = new Map<string, AstroIslandComponent>();
  const record = (component: AstroIslandComponent) => {
    const key = `${component.componentPath}\0${component.exportName}`;
    if (!hydrated.has(key)) hydrated.set(key, { componentPath: component.componentPath, exportName: component.exportName });
  };
  const urls = createIslandClientUrls({ base: options.base, beforeHydrationScripts: options.beforeHydrationScripts });
  const recordingUrls: IslandClientUrls = {
    component(componentPath, exportName) {
      const url = urls.component(componentPath, exportName);
      record({ componentPath, exportName });
      byUrl.set(url, { componentPath, exportName });
      return url;
    },
    renderer: (rendererName) => urls.renderer(rendererName),
    beforeHydration: urls.beforeHydration,
  };
  configureAstroIslands({ renderers: project.renderers, urls: recordingUrls, scripts: project.scripts });

  return {
    projectRoot: project.projectRoot,
    base: options.base,
    beforeHydrationScripts: options.beforeHydrationScripts,
    entries: project.entries,
    compilers: project.compilers,
    hydratedComponents: () => [...hydrated.values()],
    componentsIn(html) {
      const found = new Map<string, AstroIslandComponent>();
      for (const [, url] of html.matchAll(ISLAND_COMPONENT_URL)) {
        // A URL this process never issued is island markup it did not render, with nothing to bundle.
        const component = byUrl.get(url);
        if (component) found.set(url, component);
      }
      return [...found.values()];
    },
    addHydratedComponents(components) {
      for (const component of components) record(component);
    },
  };
}

/** Write the client bundles of `components`, at the URLs the pages reference. */
export async function bundleRenderedIslands(
  renderers: AstroRenderers,
  distDir: string,
  components: readonly AstroIslandComponent[],
): Promise<void> {
  if (components.length === 0) return;
  await bundleAstroIslands({
    projectRoot: renderers.projectRoot,
    distDir,
    base: renderers.base,
    beforeHydrationScripts: renderers.beforeHydrationScripts,
    components,
    renderers: renderers.entries,
    compilers: renderers.compilers,
    virtualModule: loadViteVirtualModule,
  });
}

/** The integrations' virtual modules, from the same Vite plugins that serve the server render. */
async function loadViteVirtualModule(specifier: string, importer: string): Promise<VirtualModuleSource | null> {
  const id = (await resolveViteId(specifier, importer)) ?? specifier;
  return (await tryLoadViteId(id)).loaded;
}

async function loadProject(projectRoot: string, entries: readonly AstroRendererEntry[]): Promise<LoadedProject> {
  if (loaded !== null) {
    const names = (list: readonly AstroRendererEntry[]) => list.map((entry) => entry.name).join(", ");
    if (loaded.projectRoot !== projectRoot || names(loaded.entries) !== names(entries)) {
      throw new Error(
        `This process already renders with the renderers of ${loaded.projectRoot} (${names(loaded.entries)}); ` +
          `framework compilers are Bun plugins, which cannot be unregistered. Build ${projectRoot} in its own process.`,
      );
    }
    return loaded;
  }

  const compilers = await loadFrameworkCompilers(projectRoot, entries);
  const renderers: LoadedRenderer[] = [];
  for (const entry of entries) {
    renderers.push({ name: entry.name, clientEntrypoint: entry.clientEntrypoint, ssr: await loadServerEntrypoint(entry, projectRoot) });
  }
  const scripts = await readIslandScripts(projectRoot);

  // Last, once nothing above can fail: a registered plugin stays for the life of the process.
  const others = compilers.filter((compiler) => !isJsxCompiler(compiler)).map(registeringItsCss);
  if (others.length > 0) {
    await Bun.plugin(
      frameworkCompilePlugin({
        compilers: others,
        target: "server",
        onCss(filename) {
          throw new Error(`${filename}: a compiled module's CSS must be imported by the module`);
        },
      }),
    );
  }

  loaded = {
    projectRoot,
    entries: [...entries],
    renderers,
    compilers,
    projectCompilers: [...compilers.filter(isJsxCompiler), ...others],
    scripts,
  };
  return loaded;
}

function isJsxCompiler(compiler: FrameworkCompiler): boolean {
  return compiler.extensions.includes(".jsx") || compiler.extensions.includes(".tsx");
}

/**
 * A server compiler whose module links its CSS the way Vite's `?vue&type=style` import does.
 * The CSS is an in-memory stylesheet beside the component, never written, so its relative
 * `url()` and `@import` resolve from the component's directory. The JS-imported-CSS graph
 * gets the compiled code with an import of it, and links it to every page that reaches the
 * module; the module Bun runs has no such import, since the file does not exist.
 */
function registeringItsCss(compiler: FrameworkCompiler): FrameworkCompiler {
  return {
    framework: compiler.framework,
    extensions: compiler.extensions,
    async compile(input) {
      const output = await compiler.compile(input);
      if (output === null) return null;
      let graphCode = output.code;
      if (output.css !== null) {
        const cssFile = `${input.filename}.pletivo-style.css`;
        setVirtualCss(cssFile, output.css);
        graphCode = `import ${JSON.stringify(cssFile)};\n${output.code}`;
      }
      // Every compile, so an edit that drops the `<style>` or an import also drops its edge.
      await collectCssSideEffectImports(input.filename, graphCode, `framework:${input.filename}`);
      return { code: output.code, loader: output.loader, css: null };
    },
  };
}

async function loadServerEntrypoint(entry: AstroRendererEntry, projectRoot: string): Promise<RendererServer> {
  let file: string;
  try {
    file = path.isAbsolute(entry.serverEntrypoint) ? entry.serverEntrypoint : Bun.resolveSync(entry.serverEntrypoint, projectRoot);
  } catch (error) {
    throw new Error(`renderer "${entry.name}": its serverEntrypoint ${entry.serverEntrypoint} cannot be resolved from ${projectRoot}`, {
      cause: error,
    });
  }
  await serveViteVirtualImports(file);
  const mod: unknown = await import(file);
  const server = isRecord(mod) ? mod.default : undefined;
  if (!isRendererServer(server)) {
    throw new Error(`renderer "${entry.name}": ${file} does not default-export check() and renderToStaticMarkup()`);
  }
  return server;
}

/** Astro's `SSRLoadedRendererValue`: the functions are called as Astro calls them, so only their presence is checked. */
function isRendererServer(value: unknown): value is RendererServer {
  if (!isRecord(value)) return false;
  return (
    typeof value.check === "function" &&
    typeof value.renderToStaticMarkup === "function" &&
    (value.supportsAstroStaticSlot === undefined || typeof value.supportsAstroStaticSlot === "boolean") &&
    (value.renderHydrationScript === undefined || typeof value.renderHydrationScript === "function")
  );
}

/** The prebuilt scripts Astro inlines ahead of islands, from the project's own `astro`. */
async function readIslandScripts(projectRoot: string): Promise<IslandScripts> {
  let astroDir: string;
  try {
    astroDir = path.dirname(Bun.resolveSync("astro/package.json", projectRoot));
  } catch (error) {
    throw new Error(
      `Astro framework renderers need the project's astro package for Astro's island scripts, ` +
        `but astro cannot be resolved from ${projectRoot}`,
      { cause: error },
    );
  }
  const directives: Record<string, string> = {};
  for (const name of DIRECTIVES) {
    directives[name] = await readPrebuiltScript(path.join(astroDir, "dist/runtime/client", `${name}.prebuilt.js`));
  }
  return {
    island: await readPrebuiltScript(path.join(astroDir, "dist/runtime/server/astro-island.prebuilt.js")),
    directives,
  };
}

async function readPrebuiltScript(file: string): Promise<string> {
  if (!existsSync(file)) throw new Error(`Astro's prebuilt island script ${file} is missing; is astro installed completely?`);
  const mod: unknown = await import(file);
  const script = isRecord(mod) ? mod.default : undefined;
  if (typeof script !== "string") throw new Error(`Astro's prebuilt island script ${file} does not default-export a string`);
  return script;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
