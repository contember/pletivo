/**
 * `import.meta.env` as Astro defines it. Bun aliases `import.meta.env` to `process.env`,
 * which lacks Astro's built-in keys (`BASE_URL`, `MODE`, `DEV`, …), so every project
 * module the host loads has `import.meta.env` rewritten to a global holding both.
 */

import type { AstroConfig } from "@pletivo/core/astro-host/types";

/** The same global name the Workers host substitutes `import.meta.env` with. */
const IMPORT_META_ENV_GLOBAL = "__pletivoImportMetaEnv";

/** Textual, like the Workers host's: it rewrites inside string literals too. */
const IMPORT_META_ENV = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;

/** Falls back to Bun's own value where nothing installed it, e.g. a container render. */
const REPLACEMENT = `(globalThis.${IMPORT_META_ENV_GLOBAL} ?? process.env)`;

export function substituteImportMetaEnv(code: string): string {
  return code.replace(IMPORT_META_ENV, REPLACEMENT);
}

export interface ImportMetaEnvOptions {
  mode: "dev" | "build";
  /** pletivo's own `base`, used when there is no Astro config. */
  base: string;
  astroConfig?: AstroConfig;
}

/**
 * Installs the values a rewritten `import.meta.env` reads: every `process.env` variable
 * (what Bun already exposed, and what Astro exposes server-side) plus Astro's built-ins.
 * Call before any project module is imported.
 */
export function installImportMetaEnv(options: ImportMetaEnvOptions): void {
  const dev = options.mode === "dev";
  const astro = options.astroConfig;
  Reflect.set(globalThis, IMPORT_META_ENV_GLOBAL, {
    ...process.env,
    BASE_URL: astro ? astroBaseUrl(astro.base, astro.trailingSlash) : withLeadingSlash(options.base),
    MODE: dev ? "development" : "production",
    DEV: dev,
    PROD: !dev,
    SSR: true,
    SITE: astro?.site,
    ASSETS_PREFIX: astro?.build.assetsPrefix,
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
