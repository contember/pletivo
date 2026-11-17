/** Run Astro's config phase on Bun and freeze its Worker-supported result. */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  ARTIFACT_VERSION,
  type ArtifactConfig,
  type ArtifactModule,
  type ArtifactInput,
  type ArtifactMarkdownConfig,
  type PreparedSite,
} from "@pletivo/core/artifact";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import {
  invalidScopedStyleStrategy,
  isScopedStyleStrategy,
  resolveScopedStyleStrategy,
  type ScopedStyleStrategy,
} from "@pletivo/core/astro-host/scoped-style";
import { invalidCompressHTML, resolveCompressHTML } from "@pletivo/core/astro-host/compile-options";
import { initAstroHost, type AstroHost } from "../astro-host/runner";
import { srcDirMismatch } from "../astro-host/config-loader";
import { bundlePageScripts } from "../astro-host/page-scripts";
import { freezeViteVirtualModule } from "../astro-host/vite-plugins";
import { loadConfig, type PletivoConfig } from "../config";
import { PrepareError, prepareFailure, type PrepareDiagnostic } from "./error";
import { readProjectInputs } from "./inputs";
import { freezeMarkdown } from "./markdown";
import { bundleOnlyFiles, prepareIslandClients, prepareIslands, type AstroHydrations } from "./islands";
import { freezeRouting, type FrozenRouting } from "./routing";
import { compareStrings } from "@pletivo/core/compare-strings";
import { astroMarkdownSettings } from "@pletivo/core/content/markdown";
import { markdownLayoutOf } from "@pletivo/core/content/markdown-module";
import { isRouteFile } from "@pletivo/core/router";
import { isInsideRoot, normalizePath } from "./paths";
import { astroSourceFacts } from "./scripts";
import { prepareModuleGraph, type MarkdownLayoutImport, type PreparedGraph, type ProjectImportSource } from "./vendor";
import { classifySpecifier } from "./scan";

export { PrepareError, type PrepareDiagnostic } from "./error";

export interface PrepareOptions {
  /** Where to look for sources. Defaults to the project's configured `srcDir`. */
  srcDir?: string;
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".astro", ".wrangler", ".pletivo"]);

function isSkippedDotEntry(segment: string): boolean {
  return segment.startsWith(".") && segment !== ".well-known";
}

export async function prepare(root: string, options: PrepareOptions = {}): Promise<PreparedSite> {
  const projectRoot = realpathSync(path.resolve(root));
  // Digest before loading: an edit racing prepare must read as stale, never as current.
  const inputs = await readProjectInputs(projectRoot);
  const projectConfig = await loadConfig(projectRoot);
  const srcDir = options.srcDir ?? projectConfig.srcDir;
  const host = await initAstroHost(projectRoot, "build");
  const markdown = freezeMarkdown(astroMarkdownSettings(host?.config));
  const routing = freezeRouting(host?.config);
  const scopedStyle = freezeScopedStyle(host?.config);
  const compressHTML = freezeCompressHTML(host?.config);
  const fatal = [
    ...unsupportedProjectSemantics(projectConfig),
    ...unsupportedSemantics(host),
    ...srcDirDiagnostics(projectRoot, srcDir, host),
    ...markdown.diagnostics,
    ...routing.diagnostics,
    ...scopedStyle.diagnostics,
    ...compressHTML.diagnostics,
  ];
  if (fatal.length > 0) throw new PrepareError(fatal);

  const sources = await readSources(projectRoot, srcDir);
  const pluginModules = markdown.config === null
    ? []
    : [...markdown.config.remarkPlugins, ...markdown.config.rehypePlugins].map((plugin) => plugin.module);
  // First: the vendor graph must not walk what the islands bundle owns, whose packages may be CommonJS.
  const islands = await prepareIslands(projectRoot, host?.renderers ?? [], sources);
  const bundleOnly = islands === null ? new Set<string>() : bundleOnlyFiles(islands, sources);
  const graphSources = islands === null
    ? sources
    : sources.filter((source) => !islands.componentFiles.has(source.file) && !bundleOnly.has(source.file));
  const shared = islands === null
    ? []
    : graphSources.filter((source) => islands.bundledFiles.has(source.file)).map((source) => source.file);
  const graph = await prepareSharedGraph(projectRoot, graphSources, shared, pluginModules);
  // After the graph, which carries the package `.astro` components that may hydrate islands too.
  const clients = islands === null
    ? null
    : await prepareIslandClients(islands, await astroHydrations(projectRoot, srcDir, sources, graph.modules));
  const pageScript = await freezePageScripts(host, projectRoot);

  return {
    artifact: {
      version: ARTIFACT_VERSION,
      config: freezeConfig(host?.config, markdown.config, routing, scopedStyle.strategy, compressHTML.value),
      scripts: {
        headInline: [...(host?.injectedHeadScripts ?? [])],
        page: pageScript === null ? [] : [pageScript],
      },
      modules: islands === null ? graph.modules : [...graph.modules, ...islands.modules],
      resolutions: islands === null ? graph.resolutions : [...graph.resolutions, ...islands.resolutions],
      browserResolutions: graph.browserResolutions,
      ...(islands === null || clients === null ? {} : { islands: { ...islands.islands, clients: clients.clients } }),
    },
    inputs: clients === null ? inputs : withBundleInputs(inputs, clients.inputs),
  };
}

/** A file both record, such as a `package.json` a component imports, keeps the digest read first. */
function withBundleInputs(inputs: readonly ArtifactInput[], bundle: readonly ArtifactInput[]): ArtifactInput[] {
  const recorded = new Set(inputs.map((input) => input.path));
  return [...inputs, ...bundle.filter((input) => !recorded.has(input.path))].sort((left, right) =>
    compareStrings(left.path, right.path),
  );
}

/**
 * The vendor graph. When it fails only because of files framework components share with live
 * modules, each that fails it on its own is refused by name, rather than the package it imports.
 */
async function prepareSharedGraph(
  projectRoot: string,
  sources: readonly ProjectImportSource[],
  shared: readonly string[],
  pluginModules: readonly string[],
): Promise<PreparedGraph> {
  const graphOf = (files: readonly ProjectImportSource[]) =>
    prepareModuleGraph(projectRoot, files, freezeViteVirtualModule, pluginModules);
  try {
    return await graphOf(sources);
  } catch (error) {
    if (!(error instanceof PrepareError) || shared.length === 0) throw error;
    const sharedFiles = new Set(shared);
    const unshared = sources.filter((source) => !sharedFiles.has(source.file));
    try {
      await graphOf(unshared);
    } catch {
      // It fails without them too: not theirs.
      throw error;
    }
    const diagnostics: PrepareDiagnostic[] = [];
    for (const file of shared) {
      try {
        await graphOf([...unshared, ...sources.filter((source) => source.file === file)]);
      } catch (fileError) {
        if (!(fileError instanceof PrepareError)) throw fileError;
        diagnostics.push({
          source: normalizePath(path.relative(projectRoot, file)),
          hook: "islands",
          reason:
            "framework components and the project's live modules both import it, and its imports cannot be carried " +
            `for the live ones on the Workers host: ${fileError.message}`,
        });
      }
    }
    throw diagnostics.length === 0 ? error : new PrepareError(diagnostics);
  }
}

/** Bundled here, on Bun, because the Worker cannot resolve a package or a Vite plugin. */
async function freezePageScripts(host: AstroHost | null, projectRoot: string): Promise<string | null> {
  if (!host) return null;
  try {
    return await bundlePageScripts(host.injectedPageScripts, projectRoot);
  } catch (error) {
    throw prepareFailure("astro.config", "injectScript", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Every `.astro` file a render can reach and what it hydrates: the sources, the project's own
 * outside `srcDir` (a layout beside it) and the package components the graph carries.
 */
async function astroHydrations(
  projectRoot: string,
  srcDir: string,
  sources: readonly ProjectImportSource[],
  carried: readonly ArtifactModule[],
): Promise<AstroHydrations[]> {
  const files: AstroHydrations[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    seen.add(source.file);
    if (source.hydrated !== undefined) files.push({ file: source.file, hydrated: source.hydrated });
  }
  const read = async (file: string, source: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const { hydrated } = await astroSourceFacts(file, source);
    if (hydrated.length > 0) files.push({ file, hydrated });
  };
  const srcBase = realpathSync(path.resolve(projectRoot, srcDir));
  for await (const rel of new Glob("**/*.astro").scan({ cwd: projectRoot, dot: true })) {
    if (isSkippedPath(rel)) continue;
    const file = path.join(projectRoot, rel);
    if (file.startsWith(srcBase + path.sep)) continue;
    await read(file, await Bun.file(file).text());
  }
  for (const module of carried) {
    if (module.kind === "astro" && module.compilePath !== undefined) await read(path.resolve(projectRoot, module.compilePath), module.source);
  }
  return files;
}

/** A build product, a dependency or a dot entry, which no source walk reads. */
function isSkippedPath(rel: string): boolean {
  return rel.split("/").some((segment) => SKIPPED_DIRS.has(segment) || isSkippedDotEntry(segment));
}

async function readSources(root: string, srcDir: string): Promise<ProjectImportSource[]> {
  const base = path.resolve(root, srcDir);
  const lexicalRelative = normalizePath(path.relative(root, base));
  if (!isInsideRoot(lexicalRelative)) {
    throw prepareFailure(
      "pletivo.config",
      "srcDir",
      `source directory ${JSON.stringify(srcDir)} escapes the project root`,
    );
  }
  if (!existsSync(base)) {
    throw prepareFailure(lexicalRelative || srcDir, "scan", "source directory does not exist");
  }
  const physicalRoot = realpathSync(root);
  const physicalBase = realpathSync(base);
  const physicalRelative = normalizePath(path.relative(physicalRoot, physicalBase));
  if (!isInsideRoot(physicalRelative)) {
    throw prepareFailure(
      "pletivo.config",
      "srcDir",
      `source directory ${JSON.stringify(srcDir)} resolves outside the project root`,
    );
  }
  const sources: ProjectImportSource[] = [];
  // `dot`, so `src/pages/.well-known` (a route directory, as in Astro) is carried; other dot entries are not.
  for await (const rel of new Glob("**/*").scan({ cwd: physicalBase, dot: true })) {
    if (isSkippedPath(rel)) continue;
    const projectPath = path.posix.join(physicalRelative, rel);
    const file = path.join(physicalBase, rel);
    const source = await Bun.file(file).text();
    const facts = rel.endsWith(".astro") ? await astroSourceFacts(file, source) : null;
    const markdownLayout = markdownLayoutImport(rel, source);
    sources.push({
      id: `project:${projectPath}`,
      file,
      source,
      ...(facts !== null && facts.scripts.length > 0 ? { scripts: facts.scripts } : {}),
      ...(facts !== null && facts.hydrated.length > 0 ? { hydrated: facts.hydrated } : {}),
      ...(markdownLayout === null ? {} : { markdownLayout }),
    });
  }
  return sources.sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * A `.md` file's bare `layout:`, which its compiled module imports (`markdownModule`).
 * A project layout is carried as a source; one named as a package must be vendored.
 * An invalid one is named when the file compiles.
 */
function markdownLayoutImport(rel: string, source: string): MarkdownLayoutImport | null {
  if (!rel.endsWith(".md")) return null;
  let layout: string | null;
  try {
    layout = markdownLayoutOf(source, rel);
  } catch {
    return null;
  }
  if (layout === null || classifySpecifier(layout) === "relative") return null;
  return { specifier: layout, route: rel.startsWith("pages/") && isRouteFile(rel.slice("pages/".length)) };
}

function unsupportedProjectSemantics(config: PletivoConfig): PrepareDiagnostic[] {
  const diagnostics: PrepareDiagnostic[] = [];
  addProjectConfigDiagnostic(
    diagnostics,
    config.base !== "/",
    "base",
    `base ${JSON.stringify(config.base)} is not supported; use "/"`,
  );
  addProjectConfigDiagnostic(
    diagnostics,
    config.publicDir !== "public",
    "publicDir",
    `publicDir ${JSON.stringify(config.publicDir)} is not carried by the Workers artifact`,
  );
  addProjectConfigDiagnostic(
    diagnostics,
    config.hashAssets === true,
    "hashAssets",
    "hashAssets=true renames public/ files, which the Workers host serves under their own names",
  );
  addProjectConfigDiagnostic(
    diagnostics,
    config.notFoundPage !== undefined,
    "notFoundPage",
    `custom notFoundPage ${JSON.stringify(config.notFoundPage)} is not routed by the Workers host`,
  );
  const imageService = config.image?.service;
  const imageServiceName = typeof imageService === "string" ? imageService : imageService?.name;
  addProjectConfigDiagnostic(
    diagnostics,
    imageServiceName !== undefined && imageServiceName !== "cloudflare",
    "image.service",
    `image service ${JSON.stringify(imageServiceName)} is not preserved; use "cloudflare"`,
  );
  return diagnostics;
}

function addProjectConfigDiagnostic(
  diagnostics: PrepareDiagnostic[],
  unsupported: boolean,
  hook: string,
  reason: string,
): void {
  if (!unsupported) return;
  diagnostics.push({ source: "pletivo.config", hook, reason });
}

function freezeScopedStyle(config: AstroConfig | undefined): {
  strategy: ScopedStyleStrategy | undefined;
  diagnostics: PrepareDiagnostic[];
} {
  const configured = config?.scopedStyleStrategy;
  if (configured !== undefined && !isScopedStyleStrategy(configured)) {
    return {
      strategy: undefined,
      diagnostics: [{ source: "astro.config", hook: "scopedStyleStrategy", reason: invalidScopedStyleStrategy(configured) }],
    };
  }
  return { strategy: resolveScopedStyleStrategy(config), diagnostics: [] };
}

function freezeCompressHTML(config: AstroConfig | undefined): {
  value: boolean | undefined;
  diagnostics: PrepareDiagnostic[];
} {
  const configured = config?.compressHTML;
  if (configured !== undefined && typeof configured !== "boolean") {
    return {
      value: undefined,
      diagnostics: [{ source: "astro.config", hook: "compressHTML", reason: invalidCompressHTML(configured) }],
    };
  }
  return { value: resolveCompressHTML(config), diagnostics: [] };
}

function freezeConfig(
  config: AstroConfig | undefined,
  markdown: ArtifactMarkdownConfig | null,
  routing: FrozenRouting,
  scopedStyleStrategy: ScopedStyleStrategy | undefined,
  compressHTML: boolean | undefined,
): ArtifactConfig {
  const frozen: ArtifactConfig = {};
  if (config?.site) frozen.site = config.site;
  if (markdown !== null) frozen.markdown = markdown;
  if (routing.i18n !== null) frozen.i18n = routing.i18n;
  if (routing.trailingSlash !== null) frozen.trailingSlash = routing.trailingSlash;
  if (routing.redirects.length > 0) frozen.redirects = routing.redirects;
  if (scopedStyleStrategy !== undefined) frozen.scopedStyleStrategy = scopedStyleStrategy;
  if (compressHTML !== undefined) frozen.compressHTML = compressHTML;
  return frozen;
}

function unsupportedSemantics(host: AstroHost | null): PrepareDiagnostic[] {
  if (!host) return [];
  const diagnostics: PrepareDiagnostic[] = [];
  for (const failure of host.setupErrors) {
    diagnostics.push({
      source: failure.name,
      hook: "astro:config:setup",
      reason: failure.error instanceof Error ? failure.error.message : String(failure.error),
    });
  }
  addConfigDiagnostic(
    diagnostics,
    host.config.base !== undefined && host.config.base !== "/",
    "base",
    `base ${JSON.stringify(host.config.base)} is not supported; use "/"`,
  );
  addConfigDiagnostic(
    diagnostics,
    host.config.build?.format !== undefined && host.config.build.format !== "directory",
    "build.format",
    `build.format ${JSON.stringify(host.config.build?.format)} is not supported; use "directory"`,
  );
  for (const route of host.injectedRoutes) {
    diagnostics.push({
      source: "injectRoute",
      hook: "astro:config:setup",
      reason: `${route.pattern} is not routed by the Workers host`,
    });
  }
  addScriptDiagnostic(diagnostics, "before-hydration", host.injectedBeforeHydrationScripts.length);
  addScriptDiagnostic(diagnostics, "page-ssr", host.injectedPageSsrScripts.length);
  return diagnostics;
}

function srcDirDiagnostics(projectRoot: string, srcDir: string, host: AstroHost | null): PrepareDiagnostic[] {
  const reason = srcDirMismatch(projectRoot, srcDir, host?.configuredSrcDir);
  return reason === null ? [] : [{ source: "astro.config", hook: "srcDir", reason }];
}

function addConfigDiagnostic(
  diagnostics: PrepareDiagnostic[],
  unsupported: boolean,
  hook: string,
  reason: string,
): void {
  if (!unsupported) return;
  diagnostics.push({ source: "astro.config", hook, reason });
}

function addScriptDiagnostic(
  diagnostics: PrepareDiagnostic[],
  stage: string,
  count: number,
): void {
  if (count === 0) return;
  diagnostics.push({
    source: "injectScript",
    hook: stage,
    reason: `${count} script(s) use an injection stage the Workers host cannot preserve`,
  });
}
