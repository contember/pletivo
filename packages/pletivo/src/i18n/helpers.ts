/**
 * Pure helpers shared between the route expander, the `astro:i18n`
 * virtual module runtime, and the `Astro.currentLocale` resolution in
 * the render shim. Every function takes the `ResolvedI18nConfig` as an
 * explicit argument so callers control binding.
 *
 * The public surface mirrors Astro's `astro:i18n` exports one-to-one,
 * which keeps the virtual-module shim trivial (it just imports from
 * here and closes over the injected config).
 */

import type { ResolvedI18nConfig } from "./config";

export interface LocaleUrlOptions {
  /** Include trailing slash (default: undefined → follows `trailingSlash`). */
  trailingSlash?: "always" | "never" | "ignore";
  /** Override `normalizeLocale` behavior (Astro compat — no-op here). */
  normalizeLocale?: boolean;
  /** Override pathname separator — Astro always uses `/`. */
  prependWith?: string;
}

/**
 * Resolve `locale` → path segment. Astro accepts either a code (`"es"`)
 * or an already-resolved path (`"spanish"`); we accept both too, so
 * `getPathByLocale("spanish")` and `getPathByLocale("es")` agree.
 */
export function getPathByLocale(
  config: ResolvedI18nConfig,
  locale: string,
): string {
  const resolved =
    config.byCode.get(locale) ?? config.byPath.get(locale);
  if (!resolved) {
    throw new Error(
      `Astro: getPathByLocale: unknown locale "${locale}". ` +
        `Known locales: ${[...config.byCode.keys()].join(", ")}`,
    );
  }
  return resolved.path;
}

/**
 * Inverse of `getPathByLocale`: resolve a URL path segment back to its
 * canonical locale code. Used by the runtime when the URL carries the
 * aliased path and we need to report `Astro.currentLocale`.
 */
export function getLocaleByPath(
  config: ResolvedI18nConfig,
  path: string,
): string {
  const resolved = config.byPath.get(path);
  if (!resolved) {
    throw new Error(
      `Astro: getLocaleByPath: unknown path "${path}". ` +
        `Known paths: ${[...config.byPath.keys()].join(", ")}`,
    );
  }
  return resolved.code;
}

/**
 * Build a site-relative URL for `locale` + `path`. Respects the
 * `prefixDefaultLocale` routing flag — the default locale may or may
 * not get a `/<locale>/` prefix depending on config.
 *
 * Matches Astro's `getRelativeLocaleUrl` semantics:
 *   - Accepts either the locale code or its aliased path
 *   - Joins `base` (from astro config) on front
 *   - Strips leading slashes from `path` before joining
 */
export function getRelativeLocaleUrl(
  config: ResolvedI18nConfig,
  base: string,
  locale: string,
  path: string = "",
  _opts: LocaleUrlOptions = {},
): string {
  const resolved =
    config.byCode.get(locale) ?? config.byPath.get(locale);
  if (!resolved) {
    throw new Error(
      `Astro: getRelativeLocaleUrl: unknown locale "${locale}"`,
    );
  }

  const includePrefix =
    resolved.code !== config.defaultLocale.code ||
    config.routing.prefixDefaultLocale;

  const segments: string[] = [];
  const normalizedBase = trimSlashes(base);
  if (normalizedBase) segments.push(normalizedBase);
  if (includePrefix) segments.push(resolved.path);
  const cleanedPath = trimSlashes(path);
  if (cleanedPath) segments.push(cleanedPath);

  const joined = segments.join("/");
  return joined ? `/${joined}` : "/";
}

/**
 * Absolute variant — requires `site` from AstroConfig. Returns relative
 * form when `site` is undefined, matching Astro's behavior.
 */
export function getAbsoluteLocaleUrl(
  config: ResolvedI18nConfig,
  base: string,
  site: string | undefined,
  locale: string,
  path: string = "",
  opts: LocaleUrlOptions = {},
): string {
  const relative = getRelativeLocaleUrl(config, base, locale, path, opts);
  if (!site) return relative;
  const siteUrl = site.endsWith("/") ? site.slice(0, -1) : site;
  return `${siteUrl}${relative}`;
}

/**
 * Return every configured locale's relative URL for the same `path`,
 * in the order the locales appear in config.
 */
export function getRelativeLocaleUrlList(
  config: ResolvedI18nConfig,
  base: string,
  path: string = "",
  opts: LocaleUrlOptions = {},
): string[] {
  return config.locales.map((l) =>
    getRelativeLocaleUrl(config, base, l.code, path, opts),
  );
}

export function getAbsoluteLocaleUrlList(
  config: ResolvedI18nConfig,
  base: string,
  site: string | undefined,
  path: string = "",
  opts: LocaleUrlOptions = {},
): string[] {
  return config.locales.map((l) =>
    getAbsoluteLocaleUrl(config, base, site, l.code, path, opts),
  );
}

/**
 * Walk the fallback chain from `fromCode` following `config.fallback`
 * pointers, stopping at the first locale whose content should be used.
 * Returns the ordered chain including `fromCode` itself (used by the
 * route expander to produce `fallbackRoutes`).
 */
export function fallbackChain(
  config: ResolvedI18nConfig,
  fromCode: string,
): string[] {
  const chain: string[] = [fromCode];
  const seen = new Set<string>([fromCode]);
  let cursor = fromCode;
  while (config.fallback[cursor]) {
    const next = config.fallback[cursor]!;
    if (seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    cursor = next;
  }
  return chain;
}

function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 47) start++;
  while (end > start && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(start, end);
}
