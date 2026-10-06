/** Run Astro's config phase on Bun and freeze its Worker-supported result. */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { ARTIFACT_VERSION, type ArtifactConfig, type PreparedSite } from "@pletivo/core/artifact";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { initAstroHost, type AstroHost } from "../astro-host/runner";
import { freezeViteVirtualModule } from "../astro-host/vite-plugins";
import { loadConfig, type PletivoConfig } from "../config";
import { PrepareError, prepareFailure, type PrepareDiagnostic } from "./error";
import { readPrepareInputs } from "./inputs";
import { compareStrings, isInsideRoot, normalizePath } from "./paths";
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
  const inputs = await readPrepareInputs(projectRoot);
  const projectConfig = await loadConfig(projectRoot);
  const srcDir = options.srcDir ?? projectConfig.srcDir;
  const host = await initAstroHost(projectRoot, "build");
  const fatal = [
    ...unsupportedProjectSemantics(projectConfig),
    ...unsupportedSemantics(host),
  ];
  if (fatal.length > 0) throw new PrepareError(fatal);

  const sources = await readSources(projectRoot, srcDir);
  const graph = await prepareModuleGraph(projectRoot, sources, freezeViteVirtualModule);

  return {
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
    inputs,
  };
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
  diagnostics.push({ source: "pletivo.config", hook, reason });
}

function freezeConfig(config: AstroConfig | undefined): ArtifactConfig {
  return config?.site ? { site: config.site } : {};
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

function markdownPluginCount(markdown: unknown): number {
  if (typeof markdown !== "object" || markdown === null) return 0;
  let count = 0;
  for (const key of ["remarkPlugins", "rehypePlugins"]) {
    const value: unknown = Reflect.get(markdown, key);
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

