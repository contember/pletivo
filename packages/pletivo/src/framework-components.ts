/**
 * Refuses a `.astro` module that imports a component of a UI framework whose
 * renderer the project has not registered — the components Astro hands to a
 * framework renderer, which only that framework's integration provides.
 *
 * A `.svelte` or `.vue` file is one by its extension. A `.tsx`/`.jsx` file is one
 * when Bun compiles its JSX for that framework's runtime: its `jsxImportSource`,
 * from a pragma in the file or else from the nearest tsconfig, which is how Bun
 * itself decides. Without its renderer such a module never renders — React's hooks
 * throw outside a React render, Solid has no runtime JSX export, Preact and Vue
 * return vnodes — so it fails here by name instead of somewhere inside the framework.
 * What this edge cannot see (npm packages, barrel files, TSX pages) the runtime
 * refuses when it meets the framework's element.
 */

import fs from "fs";
import path from "path";
import { frameworkOfFile } from "@pletivo/runtime/framework-components";
import {
  foreignJsxMessage,
  frameworkOfJsxImportSource,
  jsxImportSourcePragma,
} from "@pletivo/core/framework-jsx";

const JSX_EXTENSIONS = new Set([".tsx", ".jsx"]);

/** The renderer each framework's integration registers. Vue JSX has none here: no compiler for it is loaded. */
const RENDERER_BY_FRAMEWORK: Readonly<Record<string, string>> = {
  Svelte: "@astrojs/svelte",
  Vue: "@astrojs/vue",
  React: "@astrojs/react",
  Preact: "@astrojs/preact",
  Solid: "@astrojs/solid-js",
};

let registeredRenderers: ReadonlySet<string> = new Set();

/** The renderers the project registered with `addRenderer()`; their frameworks' components are let through. */
export function configureRegisteredRenderers(names: readonly string[]): void {
  registeredRenderers = new Set(names);
}

interface Refusal {
  message: string;
  /** The integration that would render the component, or `null` when none would. */
  renderer: string | null;
}
const TSCONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

export interface JsxImportSource {
  value: string;
  /** Where it was set, for the error. */
  origin: string;
}

/** Nearest tsconfig's `jsxImportSource` per directory, memoized like Bun's own tsconfig. */
const tsconfigByDir = new Map<string, JsxImportSource | null>();

/**
 * Throw when the compiled `.astro` module at `file` imports framework components.
 * `specifiers` are scanned from the compiler's output, so they are the ones Bun will execute.
 */
export function assertRenderableImports(file: string, specifiers: readonly string[]): void {
  const fromDir = path.dirname(file);
  const refusals: Refusal[] = [];
  for (const specifier of specifiers) {
    const target = resolveImport(specifier, fromDir);
    if (target === null) continue;
    const refusal = frameworkComponent(target);
    if (refusal !== null) refusals.push({ ...refusal, message: `${refusal.message}, imported by ${relative(file)}` });
  }
  if (refusals.length > 0) {
    const missing = [...new Set(refusals.flatMap((refusal) => (refusal.renderer === null ? [] : [refusal.renderer])))];
    const advice =
      missing.length > 0
        ? `Astro renders these through the renderer of the framework's integration; add ${missing.join(", ")} to the integrations in astro.config.`
        : "Astro renders these through a framework renderer, and pletivo compiles no Vue JSX.";
    throw new Error(`${refusals.map((refusal) => refusal.message).join("\n")}\n${advice}`);
  }
}

function resolveImport(specifier: string, fromDir: string): string | null {
  // `astro:content`, `node:path`, the compiler's `?astro&type=` style imports.
  if (specifier.includes("?") || (!path.isAbsolute(specifier) && /^[a-z][a-z0-9+.-]*:/i.test(specifier))) {
    return null;
  }
  try {
    return Bun.resolveSync(specifier, fromDir);
  } catch {
    return null;
  }
}

function frameworkComponent(file: string): Refusal | null {
  const byExtension = frameworkOfFile(file);
  if (byExtension !== null) {
    return refusal(byExtension, `pletivo cannot render ${byExtension} components: ${relative(file)}`);
  }
  // A package ships compiled JavaScript; only the project's own JSX is compiled here.
  if (!JSX_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return null;
  const source = jsxImportSourceOf(file);
  const framework = source === null ? null : frameworkOfJsxImportSource(source.value);
  if (source === null || framework === null) return null;
  return refusal(framework, foreignJsxMessage(framework, relative(file), source.value, source.origin));
}

/** `null` when the framework's renderer is registered and renders the component. */
function refusal(framework: string, message: string): Refusal | null {
  const renderer = RENDERER_BY_FRAMEWORK[framework] ?? null;
  if (renderer !== null && registeredRenderers.has(renderer)) return null;
  return { message, renderer };
}

function jsxImportSourceOf(file: string): JsxImportSource | null {
  const pragma = jsxImportSourcePragma(fs.readFileSync(file, "utf8"));
  if (pragma.kind === "leading") return { value: pragma.importSource, origin: "its @jsxImportSource pragma" };
  // A pragma further down may override the tsconfig; the runtime refuses what this misses.
  if (pragma.kind === "unknown") return null;
  return nearestTsconfig(path.dirname(file));
}

export function nearestTsconfig(dir: string): JsxImportSource | null {
  const memo = tsconfigByDir.get(dir);
  if (memo !== undefined) return memo;
  let found: JsxImportSource | null = null;
  const config = TSCONFIG_NAMES.map((name) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
  if (config !== undefined) {
    const value = tsconfigJsxImportSource(config, new Set());
    found = value === null ? null : { value, origin: relative(config) };
  } else if (path.dirname(dir) !== dir) {
    found = nearestTsconfig(path.dirname(dir));
  }
  tsconfigByDir.set(dir, found);
  return found;
}

/** `compilerOptions.jsxImportSource` through the `extends` chain; `null` when unset or unreadable. */
function tsconfigJsxImportSource(file: string, seen: Set<string>): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  let config: unknown;
  try {
    config = Bun.JSONC.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(config)) return null;
  const options = config.compilerOptions;
  if (isRecord(options) && typeof options.jsxImportSource === "string") return options.jsxImportSource;
  const parents = typeof config.extends === "string" ? [config.extends] : Array.isArray(config.extends) ? config.extends : [];
  // A later entry of an `extends` array overrides an earlier one.
  for (const parent of [...parents].reverse()) {
    if (typeof parent !== "string") continue;
    const parentFile = resolveExtends(parent, path.dirname(file));
    const value = parentFile === null ? null : tsconfigJsxImportSource(parentFile, seen);
    if (value !== null) return value;
  }
  return null;
}

function resolveExtends(specifier: string, fromDir: string): string | null {
  const candidates = specifier.endsWith(".json") ? [specifier] : [specifier, `${specifier}.json`];
  for (const candidate of candidates) {
    if (candidate.startsWith(".") || path.isAbsolute(candidate)) {
      const file = path.resolve(fromDir, candidate);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
      continue;
    }
    try {
      return Bun.resolveSync(candidate, fromDir);
    } catch {
      // try the next spelling
    }
  }
  return null;
}

function relative(file: string): string {
  return path.relative(process.cwd(), file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
