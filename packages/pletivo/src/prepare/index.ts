/**
 * `pletivo prepare` — run the config/integration phase where it can run, once.
 *
 * `astro:config:setup` is arbitrary Node: the static dogfood site's own config walks 93 YAML files
 * before a hook fires, and astro-icon's Vite plugin reads a 552 kB icon pack off disk
 * inside `load()`. None of that works in an isolate, and none of it needs to run more
 * than once per deploy — so it runs here, on Bun, and what it produced is frozen into
 * the artifact `@pletivo/workers` consumes.
 *
 * The host is `initAstroHost(root, "build")`, unchanged. Nothing in this directory
 * re-implements a hook; it reads what the runner already collected and decides which
 * of it survives serialization (`docs/todos/020 §2` is the table).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import type {
  ArtifactConfig,
  ArtifactDiagnostic,
  PreparedSite,
  SiteArtifact,
} from "@pletivo/core/artifact";
import { ARTIFACT_VERSION } from "@pletivo/core/artifact";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { initAstroHost } from "../astro-host/runner";
import { freezeViteVirtualModule } from "../astro-host/vite-plugins";
import { loadConfig } from "../config";
import { stripTypes } from "../transpile";
import { classifySpecifier, specifiersOf } from "./scan";
import {
  requestsFrom,
  vendorSpecifiers,
  virtualModuleNameFor,
  type VendorRequest,
} from "./vendor";

/** A project this host refuses to prepare, rather than prepare incompletely. */
export class PrepareError extends Error {
  constructor(message: string) {
    super(`[pletivo prepare] ${message}`);
    this.name = "PrepareError";
  }
}

export interface PrepareOptions {
  /** Where to look for sources. Defaults to the project's configured `srcDir`. */
  srcDir?: string;
  /**
   * Prepended to every path the artifact names.
   *
   * A deployed project's file map is keyed from its own root, so this is empty and
   * stays empty. The parity harness keys one file map per fixture *under the repo
   * root* — because the Bun host names a module relative to `process.cwd()` and the
   * `astro-{scope}` hash follows — and this is how the artifact agrees with it.
   */
  pathPrefix?: string;
}

/** Directories that hold build products or dependencies rather than project sources. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".astro", ".wrangler", ".pletivo"]);

/**
 * Freeze one project into an artifact.
 *
 * Reads the filesystem and npm, and runs every integration's `astro:config:setup`.
 * The caller is expected to be a CLI on Bun; nothing here can run in a Worker, which
 * is the entire premise.
 */
export async function prepare(root: string, options: PrepareOptions = {}): Promise<PreparedSite> {
  const projectConfig = await loadConfig(root);
  const srcDir = options.srcDir ?? projectConfig.srcDir;
  const host = await initAstroHost(root, "build");
  const diagnostics: ArtifactDiagnostic[] = [];

  if (host && host.setupErrors.length > 0) {
    throw new PrepareError(
      "these integrations' astro:config:setup threw, so the artifact would be missing " +
        `whatever they contribute: ${host.setupErrors.map((failure) => failure.name).join(", ")}`,
    );
  }
  if (host && host.injectedPageSsrScripts.length > 0) {
    // `build.ts:177` runs these with `new Function`, and workerd has no `eval`. Nothing
    // downstream could report this, so it stops here rather than rendering a page that
    // is quietly missing whatever the script set up.
    throw new PrepareError(
      `injectScript('page-ssr') needs eval, and a Worker has none — ` +
        `${host.injectedPageSsrScripts.length} script(s) would be silently dropped`,
    );
  }

  const sources = await readSources(root, srcDir);
  const requests: VendorRequest[] = [];
  const virtualSpecifiers = new Set<string>();
  /** Where a virtual specifier was first seen, which is what a `resolveId` may read. */
  const virtualImporters = new Map<string, string>();

  for (const [file, source] of sources) {
    const absolute = path.join(root, file);
    // npm goes through `requestsFrom`, which also reads *which* exports were asked for.
    requests.push(...requestsFrom(absolute, source));
    for (const specifier of specifiersOf(file, source)) {
      switch (classifySpecifier(specifier)) {
        case "virtual":
          virtualSpecifiers.add(specifier);
          if (!virtualImporters.has(specifier)) virtualImporters.set(specifier, absolute);
          break;
        case "unsupported":
          diagnostics.push({
            source: file,
            hook: "import",
            reason: `imports ${specifier}, which no Worker can answer — the page will not render`,
          });
          break;
        default:
          break;
      }
    }
  }

  const vendored = await vendorSpecifiers(root, requests, options.pathPrefix ?? "");
  for (const specifier of vendored.virtualSpecifiers) {
    virtualSpecifiers.add(specifier);
    if (!virtualImporters.has(specifier)) virtualImporters.set(specifier, root);
  }
  for (const [specifier, reason] of vendored.refused) {
    diagnostics.push({ source: specifier, hook: "vendor", reason });
  }

  const modules: Record<string, string> = { ...vendored.modules };
  const virtualModules: Record<string, string> = {};
  for (const specifier of [...virtualSpecifiers].sort()) {
    const frozen = await freezeViteVirtualModule(
      specifier,
      virtualImporters.get(specifier) ?? root,
    );
    if (!frozen) {
      diagnostics.push({
        source: specifier,
        hook: "vite.load",
        reason: "no registered Vite plugin resolved or loaded it, so nothing could be frozen",
      });
      continue;
    }
    const name = virtualModuleNameFor(specifier);
    // The Loader takes JavaScript. A plugin that returns TypeScript — the default
    // assumption in `loaderForVirtualId` — has to be stripped here, because the
    // isolate has no transpiler and the host worker only strips project files.
    modules[name] = frozen.loader === "ts" ? stripTypes(frozen.code) : frozen.code;
    virtualModules[specifier] = name;
  }

  diagnostics.push(...configDiagnostics(host?.config));
  if (host) diagnostics.push(...unsupportedHookDiagnostics(host));

  const artifact: SiteArtifact = {
    version: ARTIFACT_VERSION,
    id: "",
    config: freezeConfig(host?.config),
    scripts: {
      headInline: [...(host?.injectedHeadScripts ?? [])],
      page: [...(host?.injectedPageScripts ?? [])],
      beforeHydration: [...(host?.injectedBeforeHydrationScripts ?? [])],
    },
    virtualModules,
    vendor: vendored.vendor,
    generatedSources: vendored.generatedSources,
    diagnostics,
  };
  artifact.id = await artifactId(artifact, modules);
  return { artifact, modules };
}

/** Every source file under `srcDir`, keyed the way a virtual file map keys it. */
async function readSources(root: string, srcDir: string): Promise<Map<string, string>> {
  const base = path.join(root, srcDir);
  const sources = new Map<string, string>();
  if (!existsSync(base)) throw new PrepareError(`no source directory at ${base}`);
  for await (const rel of new Glob("**/*").scan({ cwd: base, dot: false })) {
    if (rel.split("/").some((segment) => SKIPPED_DIRS.has(segment))) continue;
    const key = path.posix.join(srcDir.split(path.sep).join("/"), rel);
    sources.set(key, await Bun.file(path.join(base, rel)).text());
  }
  return sources;
}

function freezeConfig(config: AstroConfig | undefined): ArtifactConfig {
  const trailingSlash = config?.trailingSlash;
  return {
    ...(config?.site ? { site: config.site } : {}),
    base: config?.base ?? "/",
    trailingSlash:
      trailingSlash === "always" || trailingSlash === "never" ? trailingSlash : "ignore",
    build: { format: config?.build?.format ?? "directory" },
  };
}

/** Config the artifact carries faithfully and the Workers host does not read yet. */
function configDiagnostics(config: AstroConfig | undefined): ArtifactDiagnostic[] {
  const out: ArtifactDiagnostic[] = [];
  if (config && config.base !== "/") {
    out.push({
      source: "astro.config",
      hook: "base",
      reason: `base is ${JSON.stringify(config.base)}, and the Workers host serves every project at "/"`,
    });
  }
  const redirects = config?.redirects ?? {};
  if (Object.keys(redirects).length > 0) {
    out.push({
      source: "astro.config",
      hook: "redirects",
      reason: `${Object.keys(redirects).length} redirect(s) are not routed by the Workers host`,
    });
  }
  const plugins = markdownPluginCount(config?.markdown);
  if (plugins > 0) {
    out.push({
      source: "astro.config",
      hook: "markdown",
      reason: `${plugins} remark/rehype plugin(s) are live functions; markdown renders without them`,
    });
  }
  return out;
}

/**
 * How many remark/rehype plugins the resolved config carries.
 *
 * Read through `Reflect.get` because `markdown` reaches `AstroConfig` through its
 * index signature — an integration may have put it there, and none of it is typed.
 */
function markdownPluginCount(markdown: unknown): number {
  if (typeof markdown !== "object" || markdown === null) return 0;
  let count = 0;
  for (const key of ["remarkPlugins", "rehypePlugins"]) {
    const value: unknown = Reflect.get(markdown, key);
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

/** Hooks that ran and produced something the artifact cannot carry yet. */
function unsupportedHookDiagnostics(host: {
  injectedRoutes: Array<{ pattern: string }>;
}): ArtifactDiagnostic[] {
  return host.injectedRoutes.map((route) => ({
    source: "injectRoute",
    hook: "astro:config:setup",
    reason: `${route.pattern} is not routed by the Workers host`,
  }));
}

/**
 * Content address of the whole artifact, data and code alike.
 *
 * Names the artifact in a log and, because the modules ride in the bundle, moves in
 * lockstep with `bundleHash` — two artifacts with the same id produce the same
 * isolate.
 */
async function artifactId(
  artifact: SiteArtifact,
  modules: Record<string, string>,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({ ...artifact, id: "" }));
  for (const name of Object.keys(modules).sort()) hasher.update(`\0${name}\0${modules[name]}`);
  return hasher.digest("hex").slice(0, 32);
}
