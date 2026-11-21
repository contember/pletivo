/**
 * `astro:config/client` and `astro:config/server`: the resolved Astro config, serialized as
 * Astro's manifest plugin (`manifest/virtual-module.ts`) serializes it.
 */

import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { resolveCompressHTML } from "@pletivo/core/astro-host/compile-options";
import { resolveI18nConfig } from "@pletivo/core/i18n/config";

type Serializable = string | number | boolean | undefined | null | URL | Serializable[] | { [key: string]: Serializable };

export function astroConfigModuleSource(config: AstroConfig, context: "client" | "server"): string {
  const compressHTML = resolveCompressHTML(config) ?? true;
  const exports: Record<string, Serializable> =
    context === "client"
      ? {
          base: config.base,
          i18n: i18nOf(config, "client"),
          build: { format: config.build.format },
          trailingSlash: config.trailingSlash,
          compressHTML,
          site: config.site,
        }
      : {
          build: { server: config.build.server, client: config.build.client, format: config.build.format },
          cacheDir: cacheDirOf(config),
          outDir: config.outDir,
          publicDir: config.publicDir,
          srcDir: config.srcDir,
          root: config.root,
          base: config.base,
          i18n: i18nOf(config, "server"),
          trailingSlash: config.trailingSlash,
          site: config.site,
          compressHTML,
        };
  return Object.entries(exports).map(([key, value]) => `export const ${key} = ${stringify(value)};`).join("\n") + "\n";
}

/** The config's `i18n` with its routing as Astro's `fromRoutingStrategy` gives it back. */
function i18nOf(config: AstroConfig, context: "client" | "server"): Serializable {
  const raw = config.i18n;
  const resolved = resolveI18nConfig(raw);
  if (raw === undefined || resolved === null) return undefined;
  const { prefixDefaultLocale, redirectToDefaultLocale, fallbackType } = resolved.routing;
  const routing: Serializable =
    raw.routing === "manual"
      ? "manual"
      : {
          prefixDefaultLocale,
          // Astro's strategy only says "no redirect" for a prefixed default locale.
          redirectToDefaultLocale: !(prefixDefaultLocale && !redirectToDefaultLocale),
          fallbackType,
        };
  const locales = raw.locales.map((locale): Serializable => (typeof locale === "string" ? locale : { path: locale.path, codes: [...locale.codes] }));
  const fallback: Serializable = Object.keys(resolved.fallback).length > 0 ? { ...resolved.fallback } : undefined;
  return context === "client"
    ? { defaultLocale: raw.defaultLocale, locales, routing, fallback }
    : { defaultLocale: raw.defaultLocale, routing, locales, fallback };
}

/** Astro's `cacheDir`, default `./node_modules/.astro/`, resolved against the root. */
function cacheDirOf(config: AstroConfig): URL {
  const cacheDir = config.cacheDir;
  if (cacheDir instanceof URL) return cacheDir;
  if (cacheDir === undefined) return new URL("node_modules/.astro/", config.root);
  if (typeof cacheDir !== "string") throw new Error("astro config: cacheDir must be a string or a URL");
  return new URL(cacheDir.endsWith("/") ? cacheDir : `${cacheDir}/`, config.root);
}

/** Astro's `stringify`: JSON, with a URL as `new URL(…)`. */
function stringify(value: Serializable): string {
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item)).join(", ")}]`;
  if (value instanceof URL) return `new URL(${JSON.stringify(value)})`;
  if (value !== null && typeof value === "object") {
    return `{\n${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${stringify(item)}`).join(",\n")}\n}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}
