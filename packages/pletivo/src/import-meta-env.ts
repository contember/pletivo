/**
 * `import.meta.env` as Astro defines it. Bun aliases `import.meta.env` to `process.env`,
 * which lacks Astro's built-in keys (`BASE_URL`, `MODE`, `DEV`, …), so the host rewrites
 * `import.meta.env` in the modules it loads to a global holding both.
 */

import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { IMPORT_META_ENV_GLOBAL } from "@pletivo/core/import-meta-env";

/** Falls back to Bun's own value where nothing installed it, e.g. a container render. */
const REPLACEMENT = `(globalThis.${IMPORT_META_ENV_GLOBAL} ?? process.env)`;

const OCCURRENCE = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;
const placeholder = (i: number) => `__pletivo_import_meta_env_${i}__`;
const definedPlaceholder = (i: number) => `__pletivo_import_meta_env_code_${i}__`;

export type SourceLoader = "ts" | "tsx" | "js" | "jsx";

/**
 * Rewrites the `import.meta.env` expressions in `code`, leaving strings, templates,
 * comments and JSX text alone. Each textual occurrence gets a numbered placeholder
 * identifier; Bun's transpiler `define` renames only the ones that are expressions, which
 * tells which to rewrite. The source is patched in place, so JSX, types and line numbers
 * stay for the loader that compiles it next.
 */
export function substituteImportMetaEnv(code: string, loader: SourceLoader): string {
  const occurrences = [...code.matchAll(OCCURRENCE)];
  if (occurrences.length === 0) return code;

  let marked = "";
  let last = 0;
  const define: Record<string, string> = {};
  occurrences.forEach((match, i) => {
    marked += code.slice(last, match.index) + placeholder(i);
    last = match.index + match[0].length;
    define[placeholder(i)] = definedPlaceholder(i);
  });
  marked += code.slice(last);

  let compiled: string;
  try {
    compiled = new Bun.Transpiler({ loader, define }).transformSync(marked);
  } catch {
    // Unparseable: leave it to the loader, which reports the error against the real file.
    return code;
  }

  let result = "";
  last = 0;
  occurrences.forEach((match, i) => {
    const isCode = compiled.includes(definedPlaceholder(i));
    result += code.slice(last, match.index) + (isCode ? REPLACEMENT : match[0]);
    last = match.index + match[0].length;
  });
  return result + code.slice(last);
}

export interface ImportMetaEnvOptions {
  mode: "dev" | "build";
  /** pletivo's own `base`, used when there is no Astro config. */
  base: string;
  astroConfig?: AstroConfig;
}

export type ImportMetaEnvBuiltins = Record<string, unknown>;

/** Astro's built-in `import.meta.env` keys, from `create-vite.ts` and Vite's own. */
export function importMetaEnvBuiltins(options: ImportMetaEnvOptions): ImportMetaEnvBuiltins {
  const dev = options.mode === "dev";
  const astro = options.astroConfig;
  return {
    BASE_URL: astro ? astroBaseUrl(astro.base, astro.trailingSlash) : withLeadingSlash(options.base),
    MODE: dev ? "development" : "production",
    DEV: dev,
    PROD: !dev,
    SSR: true,
    SITE: astro?.site,
    ASSETS_PREFIX: astro?.build.assetsPrefix,
  };
}

/**
 * Installs what a rewritten `import.meta.env` reads: Astro's built-ins over the live
 * `process.env`, so a variable set later (an integration hook, project code) is seen and
 * a write lands in `process.env`, as with Bun's own `import.meta.env`. `.env` files are
 * Bun's: read at process start by `NODE_ENV` (`.env.development` when unset), not by
 * `MODE` as Vite reads them. Call before any project module is imported.
 */
export function installImportMetaEnv(options: ImportMetaEnvOptions): void {
  Reflect.set(globalThis, IMPORT_META_ENV_GLOBAL, liveEnv(importMetaEnvBuiltins(options)));
}

function liveEnv(builtins: ImportMetaEnvBuiltins): ImportMetaEnvBuiltins {
  const isBuiltin = (key: string | symbol): key is string =>
    typeof key === "string" && Object.hasOwn(builtins, key);
  return new Proxy(builtins, {
    get: (target, key) => (isBuiltin(key) ? target[key] : typeof key === "string" ? process.env[key] : undefined),
    set: (target, key, value) => {
      if (isBuiltin(key)) target[key] = value;
      else if (typeof key === "string") process.env[key] = String(value);
      return true;
    },
    has: (_target, key) => isBuiltin(key) || (typeof key === "string" && key in process.env),
    deleteProperty: (_target, key) => {
      if (typeof key === "string" && !isBuiltin(key)) delete process.env[key];
      return true;
    },
    ownKeys: (target) => [...new Set([...Object.keys(target), ...Object.keys(process.env)])],
    getOwnPropertyDescriptor: (target, key) => {
      if (isBuiltin(key)) return Reflect.getOwnPropertyDescriptor(target, key);
      if (typeof key !== "string" || !(key in process.env)) return undefined;
      return { value: process.env[key], writable: true, enumerable: true, configurable: true };
    },
  });
}

/** Astro normalizes `base` by `trailingSlash` before it becomes `BASE_URL`. */
function astroBaseUrl(base: string, trailingSlash: string): string {
  if (trailingSlash === "never") return withLeadingSlash(base.replace(/\/+$/, ""));
  if (trailingSlash === "always") return withLeadingSlash(base.endsWith("/") ? base : `${base}/`);
  return withLeadingSlash(base);
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
