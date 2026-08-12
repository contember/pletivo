/**
 * npm, turned into something a Worker Loader can run.
 *
 * Two shapes come out, and which one a package gets is decided by what is in it
 * rather than by a list:
 *
 *  - **A bundle.** Plain JavaScript and TypeScript go through `Bun.build` into one
 *    self-contained module. That is the ordinary case and it is what makes deep
 *    packages viable at all — `marked` is 39 files and arrives as one.
 *  - **Sources.** A package that ships `.astro` cannot be bundled: the Astro compiler
 *    derives a component's `astro-{scope}` hash from the *filename* it is given, and
 *    the host worker's CSS pipeline needs to see the `<style>` blocks separately. So
 *    the whole relative graph is carried as sources, keyed by the path the Bun host
 *    would have compiled them at, and the host worker compiles them like project
 *    files. `astro-icon/components` is this case, and so is every component library.
 *
 * Either way the *set* is closed: a vendored source's own bare imports are queued and
 * vendored too, so nothing is left pointing at node_modules.
 */

import os from "node:os";
import path from "node:path";
import { classifySpecifier, extensionOf, specifierUses, specifiersOf, type SpecifierUse } from "./scan";

/** What a bare specifier landed on, in the vocabulary of `SiteArtifact`. */
export interface VendorOutput {
  /** Resolved specifier -> a generated-source path or a module name. */
  vendor: Record<string, string>;
  /** Project-root-relative path -> source text, compiled by the host worker. */
  generatedSources: Record<string, string>;
  /** Module name -> JavaScript, put in the bundle as-is. */
  modules: Record<string, string>;
  /** Virtual specifiers reached through a vendored source, for the freezing pass. */
  virtualSpecifiers: Set<string>;
  /** Specifier -> why it could not be carried. */
  refused: Map<string, string>;
}

export interface VendorRequest {
  specifier: string;
  /** Absolute path of the file that named it — where resolution starts. */
  importer: string;
  /** Which of its exports that file wanted. Merged across every importer. */
  use: SpecifierUse;
}

/** Merge one importer's demands into what a specifier is bundled for. */
function mergeUse(into: SpecifierUse, from: SpecifierUse): void {
  if (from.whole) into.whole = true;
  for (const name of from.names) into.names.add(name);
}

/** The demands a source file makes, as vendor requests. */
export function requestsFrom(file: string, source: string): VendorRequest[] {
  const out: VendorRequest[] = [];
  for (const [specifier, use] of specifierUses(file, source)) {
    if (classifySpecifier(specifier) !== "vendor") continue;
    out.push({ specifier, importer: file, use });
  }
  return out;
}

/** Extensions the host worker compiles itself, so they can travel as sources. */
const SOURCE_EXTENSIONS = new Set([".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs"]);
/** Extensions that are only ever a stylesheet: carried whole, collected by the CSS pipeline. */
const STYLE_EXTENSIONS = new Set([".css"]);

/**
 * Resolve and carry every bare specifier reachable from `requests`.
 *
 * `root` is the project root, and every generated-source key is relative to it — the
 * same way a virtual file map is keyed, and the same way the Bun host names a module
 * when it computes a scope hash.
 */
export async function vendorSpecifiers(
  root: string,
  requests: VendorRequest[],
  /** Prepended to every generated-source key. Only a harness whose file map is not rooted at the project needs it. */
  pathPrefix = "",
): Promise<VendorOutput> {
  const out: VendorOutput = {
    vendor: {},
    generatedSources: {},
    modules: {},
    virtualSpecifiers: new Set(),
    refused: new Map(),
  };
  const queue = [...requests];
  const seen = new Set<string>();
  /** Bundled after the walk, so every importer's demands are known first. */
  const pending = new Map<string, { entry: string; use: SpecifierUse }>();

  while (queue.length > 0) {
    const request = queue.shift();
    if (request === undefined) continue;
    const already = pending.get(request.specifier);
    if (already) {
      mergeUse(already.use, request.use);
      continue;
    }
    if (seen.has(request.specifier)) continue;
    seen.add(request.specifier);

    let resolved: string;
    try {
      resolved = Bun.resolveSync(request.specifier, path.dirname(request.importer));
    } catch (error) {
      out.refused.set(
        request.specifier,
        `could not be resolved from ${path.relative(root, request.importer)}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      continue;
    }

    const extension = extensionOf(resolved);
    if (STYLE_EXTENSIONS.has(extension)) {
      const key = await carrySource(root, resolved, out, pathPrefix);
      if (key !== null) out.vendor[request.specifier] = key;
      continue;
    }

    if (await graphHasAstro(resolved)) {
      const entry = await carryGraph(root, resolved, out, queue, pathPrefix);
      if (entry !== null) out.vendor[request.specifier] = entry;
      continue;
    }

    pending.set(request.specifier, {
      entry: resolved,
      use: { names: new Set(request.use.names), whole: request.use.whole },
    });
  }

  for (const [specifier, { entry, use }] of pending) {
    const name = await bundlePackage(specifier, entry, use, out);
    if (name !== null) out.vendor[specifier] = name;
  }

  return out;
}

/**
 * Whether anything reachable from `entry` by a relative import is an `.astro` file.
 *
 * The question the two shapes turn on, asked of the graph rather than of the package
 * name — a package can ship components under one export and plain JavaScript under
 * another, and only the one being imported matters.
 */
async function graphHasAstro(entry: string): Promise<boolean> {
  for (const file of await relativeGraph(entry)) {
    if (file.endsWith(".astro")) return true;
  }
  return false;
}

/** Every file reachable from `entry` through relative imports, `entry` included. */
async function relativeGraph(entry: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE_EXTENSIONS.has(extensionOf(file))) continue;
    found.push(file);
    let source: string;
    try {
      source = await Bun.file(file).text();
    } catch {
      continue;
    }
    for (const specifier of specifiersOf(file, source)) {
      if (classifySpecifier(specifier) !== "relative") continue;
      try {
        queue.push(Bun.resolveSync(specifier, path.dirname(file)));
      } catch {
        // Unresolvable from here is the Bun host's problem to report, not prepare's.
      }
    }
  }
  return found;
}

/**
 * Carry a package's whole relative graph as sources, queueing its bare imports.
 *
 * Relative specifiers get an entry of their own whenever the path they spell is not
 * the path they land on — `./cache.js` naming a `cache.ts` is TypeScript's own
 * convention and nothing in a file map would find it.
 */
async function carryGraph(
  root: string,
  entry: string,
  out: VendorOutput,
  queue: VendorRequest[],
  pathPrefix: string,
): Promise<string | null> {
  const entryKey = await carrySource(root, entry, out, pathPrefix);
  if (entryKey === null) return null;

  for (const file of await relativeGraph(entry)) {
    const key = await carrySource(root, file, out, pathPrefix);
    if (key === null) continue;
    const source = out.generatedSources[key];
    const uses = specifierUses(file, source);
    for (const specifier of specifiersOf(file, source)) {
      const kind = classifySpecifier(specifier);
      if (kind === "virtual") {
        out.virtualSpecifiers.add(specifier);
        continue;
      }
      if (kind === "unsupported") {
        out.refused.set(specifier, `${projectKey(root, file) ?? file} imports it, and no Worker can answer it`);
        continue;
      }
      if (kind === "vendor") {
        queue.push({ specifier, importer: file, use: uses.get(specifier) ?? WHOLE });
        continue;
      }
      if (kind !== "relative") continue;
      let target: string;
      try {
        target = Bun.resolveSync(specifier, path.dirname(file));
      } catch {
        continue;
      }
      // What `resolveSpecifier` in the host worker will make of it, so the two agree
      // on the key even when the extension does not.
      const spelled = path.posix.normalize(path.posix.join(path.posix.dirname(key), specifier));
      const landed = await carrySource(root, target, out, pathPrefix);
      if (landed !== null && landed !== spelled) out.vendor[spelled] = landed;
    }
  }
  return entryKey;
}

/** Read one file into `generatedSources`, keyed the way a virtual file map keys it. */
async function carrySource(
  root: string,
  file: string,
  out: VendorOutput,
  pathPrefix: string,
): Promise<string | null> {
  const key = projectKey(root, file, pathPrefix);
  if (key === null) {
    out.refused.set(file, "sits outside the project root, so no file-map key names it");
    return null;
  }
  if (key in out.generatedSources) return key;
  try {
    out.generatedSources[key] = await Bun.file(file).text();
  } catch (error) {
    out.refused.set(file, error instanceof Error ? error.message : String(error));
    return null;
  }
  return key;
}

/**
 * A file's key in the virtual file map.
 *
 * `null` when it climbs out of the project root: `resolveSpecifier` drops a `..`, so
 * such a key can never be resolved, and a package hoisted above the root has to be
 * reported rather than carried under a name that is quietly wrong.
 */
function projectKey(root: string, file: string, pathPrefix = ""): string | null {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === "") return null;
  return pathPrefix ? `${pathPrefix}/${relative}` : relative;
}

/** Nothing may be dropped: what a namespace import or a dynamic `import()` asks for. */
const WHOLE: SpecifierUse = { names: new Set(), whole: true };

/**
 * Bundle a package into one module.
 *
 * `target: "browser"` with the `workerd` condition, because that is what the isolate
 * is: no `node:` shims beyond what `nodejs_compat` gives, and a package whose only
 * entry is CommonJS still comes out as ESM.
 *
 * The entry point is a *generated* re-export of exactly the names the project asked
 * for, whenever it asked by name. That is not only smaller — it is what keeps
 * `Bun.build` honest. Pointed at `@iconify/utils`' own entry it emits an export list
 * of 83 names and defines a handful, and the Loader answers "Export 'buildParsedSVG'
 * is not defined in module"; pointed at `export { getIconData, iconToSVG } from "…"`
 * it emits a module that runs.
 */
async function bundlePackage(
  specifier: string,
  entry: string,
  use: SpecifierUse,
  out: VendorOutput,
): Promise<string | null> {
  const name = moduleNameFor(specifier);
  if (name in out.modules) return name;

  const byName = !use.whole && use.names.size > 0;
  const source = byName
    ? `export { ${[...use.names].sort().join(", ")} } from ${JSON.stringify(entry)};\n`
    : null;
  const entrypoint = source === null ? entry : await writeSyntheticEntry(entry, source);

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entrypoint],
      format: "esm",
      target: "browser",
      conditions: ["workerd", "worker"],
      minify: false,
      sourcemap: "none",
      external: ["node:*"],
    });
  } catch (error) {
    out.refused.set(specifier, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    if (entrypoint !== entry) await Bun.file(entrypoint).unlink();
  }
  if (!result.success || result.outputs.length === 0) {
    out.refused.set(specifier, result.logs.map((log) => String(log)).join("; ") || "produced no output");
    return null;
  }
  const code = await result.outputs[0].text();
  const missing = byName ? [...use.names].filter((wanted) => !exportsName(code, wanted)) : [];
  if (missing.length > 0) {
    out.refused.set(specifier, `the bundle does not export ${missing.join(", ")}`);
    return null;
  }
  out.modules[name] = code;
  return name;
}

/**
 * Where a generated entry lives while `Bun.build` reads it.
 *
 * Outside node_modules, deliberately. The re-export names the package's real entry by
 * absolute path, so resolution works from anywhere — but a file written *inside* the
 * package is treated as part of it, and `Bun.build` then tree-shakes the re-export
 * away and leaves the name in the export clause: the same "Export 'getIconData' is
 * not defined in module" the package's own entry produces.
 */
async function writeSyntheticEntry(entry: string, source: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `pletivo-vendor-${process.pid}-${syntheticEntries++}.mjs`,
  );
  await Bun.write(file, source);
  return file;
}

let syntheticEntries = 0;

/** Whether a bundle names `wanted` in an export clause. */
function exportsName(code: string, wanted: string): boolean {
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of match[1].split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      if ((parts[1] ?? parts[0]).trim() === wanted) return true;
    }
  }
  return new RegExp(`export\\s+(?:default\\s|(?:async\\s+)?function\\s+${wanted}\\b|const\\s+${wanted}\\b|class\\s+${wanted}\\b)`).test(code);
}

/** A bundle name that is legal, stable, and readable in an isolate stack trace. */
export function moduleNameFor(specifier: string): string {
  return `vendor.${specifier.replace(/[^A-Za-z0-9._-]/g, "_")}.js`;
}

/** The same, for a frozen virtual module. Kept apart so the two cannot collide. */
export function virtualModuleNameFor(specifier: string): string {
  return `virtual.${specifier.replace(/[^A-Za-z0-9._-]/g, "_")}.js`;
}
