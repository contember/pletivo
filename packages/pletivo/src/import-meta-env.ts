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
const PLACEHOLDER_PREFIX = "__pletivo_import_meta_env_";

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

  // Salted when the source already holds the prefix, so its own text cannot match a placeholder.
  const prefix = code.includes(PLACEHOLDER_PREFIX)
    ? `${PLACEHOLDER_PREFIX}${crypto.randomUUID().replaceAll("-", "")}_`
    : PLACEHOLDER_PREFIX;
  const placeholder = (i: number) => `${prefix}${i}__`;
  const definedPlaceholder = (i: number) => `${prefix}code_${i}__`;

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
 *
 * Being a Proxy, it is not structured-cloneable; spread it first (`{ ...import.meta.env }`).
 */
export function installImportMetaEnv(options: ImportMetaEnvOptions): void {
  Reflect.set(globalThis, IMPORT_META_ENV_GLOBAL, liveEnv(importMetaEnvBuiltins(options)));
}

/**
 * Built-in keys live on the target, other string keys in `process.env`. `defineProperty` on
 * an env key takes only what `process.env` itself accepts: a writable, enumerable,
 * configurable data property, stored as a string.
 */
function liveEnv(builtins: ImportMetaEnvBuiltins): ImportMetaEnvBuiltins {
  const onTarget = (key: string | symbol): boolean => typeof key === "symbol" || Object.hasOwn(builtins, key);
  const inEnv = (key: string | symbol): key is string =>
    typeof key === "string" && !Object.hasOwn(builtins, key) && Object.hasOwn(process.env, key);
  return new Proxy(builtins, {
    get: (target, key) => (onTarget(key) ? Reflect.get(target, key) : process.env[String(key)]),
    set: (target, key, value) => {
      if (onTarget(key)) return Reflect.set(target, key, value);
      process.env[String(key)] = String(value);
      return true;
    },
    has: (target, key) => onTarget(key) ? Reflect.has(target, key) : inEnv(key),
    deleteProperty: (target, key) => {
      if (onTarget(key)) return Reflect.deleteProperty(target, key);
      delete process.env[String(key)];
      return true;
    },
    defineProperty: (target, key, descriptor) => {
      if (onTarget(key)) return Reflect.defineProperty(target, key, descriptor);
      const plain =
        "value" in descriptor &&
        descriptor.writable !== false &&
        descriptor.enumerable !== false &&
        descriptor.configurable !== false;
      if (!plain) return false;
      process.env[String(key)] = String(descriptor.value);
      return true;
    },
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...Object.keys(process.env)])],
    getOwnPropertyDescriptor: (target, key) => {
      if (onTarget(key)) return Reflect.getOwnPropertyDescriptor(target, key);
      if (!inEnv(key)) return undefined;
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
