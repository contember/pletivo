/** Run Astro's config phase on Bun and freeze its Worker-supported result. */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  ARTIFACT_VERSION,
  type ArtifactConfig,
  type PrepareDiagnostic,
  type PreparedSite,
  type PrepareReport,
} from "@pletivo/core/artifact";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { initAstroHost, type AstroHost } from "../astro-host/runner";
import { freezeViteVirtualModule } from "../astro-host/vite-plugins";
import { loadConfig, type PletivoConfig } from "../config";
import {
  PrepareGraphError,
  prepareModuleGraph,
  type PreparedGraph,
  type ProjectImportSource,
} from "./vendor";

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly report: PrepareReport,
  ) {
    super(`[pletivo prepare] ${message}`);
    this.name = "PrepareError";
  }
}

export interface PrepareOptions {
  /** Where to look for sources. Defaults to the project's configured `srcDir`. */
  srcDir?: string;
  /** Compilation-path prefix used by parity harnesses whose source map has a parent root. */
  pathPrefix?: string;
}

export interface PrepareResult {
  site: PreparedSite;
  report: PrepareReport;
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".astro", ".wrangler", ".pletivo"]);

export async function prepare(root: string, options: PrepareOptions = {}): Promise<PrepareResult> {
  const projectRoot = realpathSync(path.resolve(root));
  const projectConfig = await loadConfig(projectRoot);
  const srcDir = options.srcDir ?? projectConfig.srcDir;
  const host = await initAstroHost(projectRoot, "build");
  const fatal = [
    ...unsupportedProjectSemantics(projectConfig),
    ...unsupportedSemantics(host),
  ];
  if (fatal.length > 0) throw prepareFailure(fatal);

  const sources = await readSources(projectRoot, srcDir);
  let graph: PreparedGraph;
  try {
    graph = await prepareModuleGraph(
      projectRoot,
      sources,
      async (specifier, importer) => freezeViteVirtualModule(specifier, importer),
      options.pathPrefix,
    );
  } catch (error) {
    if (!(error instanceof PrepareGraphError)) throw error;
    throw prepareFailure([
      {
        severity: "fatal",
        source: error.source,
        hook: error.hook,
        reason: error.reason,
      },
    ]);
  }

  const site: PreparedSite = {
    artifact: {
      version: ARTIFACT_VERSION,
      config: freezeConfig(host?.config),
      scripts: {
        headInline: [...(host?.injectedHeadScripts ?? [])],
        page: [...(host?.injectedPageScripts ?? [])],
      },
      modules: graph.modules,
      resolutions: graph.resolutions,
    },
  };
  return { site, report: { diagnostics: [] } };
}

async function readSources(root: string, srcDir: string): Promise<ProjectImportSource[]> {
  const base = path.resolve(root, srcDir);
  const lexicalRelative = normalizePath(path.relative(root, base));
  if (!isInsideProject(lexicalRelative)) {
    throw prepareFailure([
      {
        severity: "fatal",
        source: "pletivo.config",
        hook: "srcDir",
        reason: `source directory ${JSON.stringify(srcDir)} escapes the project root`,
      },
    ]);
  }
  if (!existsSync(base)) {
    throw prepareFailure([
      {
        severity: "fatal",
        source: normalizePath(path.relative(root, base)) || srcDir,
        hook: "scan",
        reason: "source directory does not exist",
      },
    ]);
  }
  const physicalRoot = realpathSync(root);
  const physicalBase = realpathSync(base);
  const physicalRelative = normalizePath(path.relative(physicalRoot, physicalBase));
  if (!isInsideProject(physicalRelative)) {
    throw prepareFailure([
      {
        severity: "fatal",
        source: "pletivo.config",
        hook: "srcDir",
        reason: `source directory ${JSON.stringify(srcDir)} resolves outside the project root`,
      },
    ]);
  }
  const sources: ProjectImportSource[] = [];
  for await (const rel of new Glob("**/*").scan({ cwd: physicalBase, dot: false })) {
    if (rel.split("/").some((segment) => SKIPPED_DIRS.has(segment))) continue;
    const projectPath = path.posix.join(physicalRelative, rel);
    const file = path.join(physicalBase, rel);
    sources.push({
      id: `project:${projectPath}`,
      file,
      source: await Bun.file(file).text(),
    });
  }
  return sources.sort((left, right) => compareStrings(left.id, right.id));
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
    config.hashAssets === false,
    "hashAssets",
    "hashAssets=false conflicts with the Workers content-addressed asset contract",
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
  diagnostics.push({ severity: "fatal", source: "pletivo.config", hook, reason });
}

function freezeConfig(config: AstroConfig | undefined): ArtifactConfig {
  return config?.site ? { site: config.site } : {};
}

function unsupportedSemantics(host: AstroHost | null): PrepareDiagnostic[] {
  if (!host) return [];
  const diagnostics: PrepareDiagnostic[] = [];
  for (const failure of host.setupErrors) {
    diagnostics.push({
      severity: "fatal",
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
    host.config.trailingSlash !== undefined && host.config.trailingSlash !== "ignore",
    "trailingSlash",
    `trailingSlash ${JSON.stringify(host.config.trailingSlash)} is not supported; use "ignore"`,
  );
  addConfigDiagnostic(
    diagnostics,
    host.config.build?.format !== undefined && host.config.build.format !== "directory",
    "build.format",
    `build.format ${JSON.stringify(host.config.build?.format)} is not supported; use "directory"`,
  );
  const redirects = host.config.redirects ?? {};
  addConfigDiagnostic(
    diagnostics,
    Object.keys(redirects).length > 0,
    "redirects",
    `${Object.keys(redirects).length} configured redirect(s) cannot be carried`,
  );
  const pluginCount = markdownPluginCount(host.config.markdown);
  addConfigDiagnostic(
    diagnostics,
    pluginCount > 0,
    "markdown",
    `${pluginCount} remark/rehype plugin(s) are live functions and cannot be carried`,
  );
  for (const route of host.injectedRoutes) {
    diagnostics.push({
      severity: "fatal",
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
  diagnostics.push({ severity: "fatal", source: "astro.config", hook, reason });
}

function addScriptDiagnostic(
  diagnostics: PrepareDiagnostic[],
  stage: string,
  count: number,
): void {
  if (count === 0) return;
  diagnostics.push({
    severity: "fatal",
    source: "injectScript",
    hook: stage,
    reason: `${count} script(s) use an injection stage the Workers host cannot preserve`,
  });
}

function markdownPluginCount(markdown: unknown): number {
  if (typeof markdown !== "object" || markdown === null) return 0;
  let count = 0;
  for (const key of ["remarkPlugins", "rehypePlugins"]) {
    const value: unknown = Reflect.get(markdown, key);
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

function prepareFailure(diagnostics: PrepareDiagnostic[]): PrepareError {
  const report = { diagnostics };
  const summary = diagnostics.map((entry) => `${entry.source} (${entry.hook}): ${entry.reason}`).join("; ");
  return new PrepareError(summary, report);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isInsideProject(relative: string): boolean {
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
