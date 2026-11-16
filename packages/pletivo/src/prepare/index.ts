/** Run Astro's config phase on Bun and freeze its Worker-supported result. */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  ARTIFACT_VERSION,
  type ArtifactConfig,
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
import { initAstroHost, type AstroHost } from "../astro-host/runner";
import { bundlePageScripts } from "../astro-host/page-scripts";
import { freezeViteVirtualModule } from "../astro-host/vite-plugins";
import { loadConfig, type PletivoConfig } from "../config";
import { PrepareError, prepareFailure, type PrepareDiagnostic } from "./error";
import { readProjectInputs } from "./inputs";
import { freezeMarkdown } from "./markdown";
import { freezeRouting, type FrozenRouting } from "./routing";
import { compareStrings } from "@pletivo/core/compare-strings";
import { astroMarkdownSettings, markdownPageLayoutReason, parseFrontmatter } from "@pletivo/core/content/markdown";
import { isInsideRoot, normalizePath } from "./paths";
import { processedScripts } from "./scripts";
import { prepareModuleGraph, type ProjectImportSource } from "./vendor";

export { PrepareError, type PrepareDiagnostic } from "./error";

export interface PrepareOptions {
  /** Where to look for sources. Defaults to the project's configured `srcDir`. */
  srcDir?: string;
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".astro", ".wrangler", ".pletivo"]);

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
  const fatal = [
    ...unsupportedProjectSemantics(projectConfig),
    ...unsupportedSemantics(host),
    ...markdown.diagnostics,
    ...routing.diagnostics,
    ...scopedStyle.diagnostics,
  ];
  if (fatal.length > 0) throw new PrepareError(fatal);

  const sources = await readSources(projectRoot, srcDir);
  const pageLayouts = markdownPageLayouts(projectRoot, srcDir, sources);
  if (pageLayouts.length > 0) throw new PrepareError(pageLayouts);
  const pluginModules = markdown.config === null
    ? []
    : [...markdown.config.remarkPlugins, ...markdown.config.rehypePlugins].map((plugin) => plugin.module);
  const graph = await prepareModuleGraph(projectRoot, sources, freezeViteVirtualModule, pluginModules);
  const pageScript = await freezePageScripts(host, projectRoot);

  return {
    artifact: {
      version: ARTIFACT_VERSION,
      config: freezeConfig(host?.config, markdown.config, routing, scopedStyle.strategy),
      scripts: {
        headInline: [...(host?.injectedHeadScripts ?? [])],
        page: pageScript === null ? [] : [pageScript],
      },
      modules: graph.modules,
      resolutions: graph.resolutions,
      browserResolutions: graph.browserResolutions,
    },
    inputs,
  };
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
  for await (const rel of new Glob("**/*").scan({ cwd: physicalBase, dot: false })) {
    if (rel.split("/").some((segment) => SKIPPED_DIRS.has(segment))) continue;
    const projectPath = path.posix.join(physicalRelative, rel);
    const file = path.join(physicalBase, rel);
    const source = await Bun.file(file).text();
    const scripts = rel.endsWith(".astro") ? await processedScripts(file, source) : [];
    sources.push({
      id: `project:${projectPath}`,
      file,
      source,
      ...(scripts.length > 0 ? { scripts } : {}),
    });
  }
  return sources.sort((left, right) => compareStrings(left.id, right.id));
}

/** `.md` pages carrying a `layout:` no host applies yet. Content entries live outside `pages/`. */
function markdownPageLayouts(
  root: string,
  srcDir: string,
  sources: readonly ProjectImportSource[],
): PrepareDiagnostic[] {
  const pagesDir = path.join(realpathSync(path.resolve(root, srcDir)), "pages") + path.sep;
  const diagnostics: PrepareDiagnostic[] = [];
  for (const { file, source } of sources) {
    if (!file.startsWith(pagesDir) || !file.endsWith(".md")) continue;
    const page = normalizePath(path.relative(root, file));
    const reason = markdownPageLayoutReason(page, parseFrontmatter(source).frontmatter);
    if (reason) diagnostics.push({ source: page, hook: "layout", reason });
  }
  return diagnostics;
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

function freezeConfig(
  config: AstroConfig | undefined,
  markdown: ArtifactMarkdownConfig | null,
  routing: FrozenRouting,
  scopedStyleStrategy: ScopedStyleStrategy | undefined,
): ArtifactConfig {
  const frozen: ArtifactConfig = {};
  if (config?.site) frozen.site = config.site;
  if (markdown !== null) frozen.markdown = markdown;
  if (routing.i18n !== null) frozen.i18n = routing.i18n;
  if (routing.trailingSlash !== null) frozen.trailingSlash = routing.trailingSlash;
  if (routing.redirects.length > 0) frozen.redirects = routing.redirects;
  if (scopedStyleStrategy !== undefined) frozen.scopedStyleStrategy = scopedStyleStrategy;
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
