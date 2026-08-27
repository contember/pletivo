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

  // Astro's semantics: compare the user-passed `locale` string to the
  // raw `defaultLocale` string from config. `getRelativeLocaleUrl("es")`
  // with `defaultLocale: "spanish"` returns a prefixed URL because
  // `"es" !== "spanish"`. Using a canonical-code comparison would hide
  // the path alias and disagree with Astro's helper output.
  const includePrefix =
    locale !== config.rawDefaultLocale ||
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

// ── Accept-Language handling ────────────────────────────────────────

interface AcceptLanguageEntry {
  tag: string;
  quality: number;
}

/**
 * Parse an RFC 7231 `Accept-Language` header into ordered (tag, q)
 * pairs, sorted by quality descending then original order. Malformed
 * entries are skipped silently — the header is user-controlled and
 * should never crash a render.
 */
function parseAcceptLanguage(header: string): AcceptLanguageEntry[] {
  const entries: Array<AcceptLanguageEntry & { index: number }> = [];
  const parts = header.split(",");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim();
    if (!part) continue;
    const [tagRaw, ...params] = part.split(";");
    const tag = tagRaw!.trim();
    if (!tag) continue;
    let quality = 1;
    for (const p of params) {
      const [k, v] = p.split("=").map((s) => s.trim());
      if (k === "q" && v) {
        const parsed = Number.parseFloat(v);
        if (Number.isFinite(parsed)) quality = parsed;
      }
    }
    entries.push({ tag, quality, index: i });
  }
  entries.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return a.index - b.index;
  });
  return entries.map(({ tag, quality }) => ({ tag, quality }));
}

/**
 * Match a single Accept-Language tag (e.g. `"fr-CA"`) against the
 * configured locales. Matches are attempted in this order:
 *   1. Exact code match (`"fr-CA"` → locale with code `"fr-CA"`)
 *   2. Language prefix match (`"fr-CA"` → locale with code `"fr"`)
 * Returns the canonical locale code, or `undefined` if nothing matched.
 */
function matchLocaleTag(
  config: ResolvedI18nConfig,
  tag: string,
): string | undefined {
  const normalized = tag.toLowerCase();
  // Exact match against any code in byCode, case-insensitive
  for (const [code, locale] of config.byCode) {
    if (code.toLowerCase() === normalized) return locale.code;
  }
  // Language-only prefix match: "fr-CA" → "fr"
  const dash = normalized.indexOf("-");
  if (dash > 0) {
    const lang = normalized.slice(0, dash);
    for (const [code, locale] of config.byCode) {
      if (code.toLowerCase() === lang) return locale.code;
    }
  }
  return undefined;
}

export interface PreferredLocales {
  preferredLocale: string | undefined;
  preferredLocaleList: string[];
}

/**
 * Resolve `Astro.preferredLocale` / `preferredLocaleList` from an
 * `Accept-Language` header string. Both fields are undefined / empty
 * when the header is absent or nothing matches a configured locale.
 */
export function parsePreferredLocales(
  config: ResolvedI18nConfig,
  acceptLanguage: string | null | undefined,
): PreferredLocales {
  if (!acceptLanguage) {
    return { preferredLocale: undefined, preferredLocaleList: [] };
  }
  const entries = parseAcceptLanguage(acceptLanguage);
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const { tag } of entries) {
    const code = matchLocaleTag(config, tag);
    if (code && !seen.has(code)) {
      seen.add(code);
      matched.push(code);
    }
  }
  return {
    preferredLocale: matched[0],
    preferredLocaleList: matched,
  };
}
