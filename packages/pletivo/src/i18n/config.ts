/**
 * Resolve raw `AstroConfig.i18n` into a normalized shape that the rest
 * of the i18n system (route expansion, helpers, virtual module, Astro
 * globals) can rely on without re-interpreting Astro's more permissive
 * user-facing config surface.
 *
 * Canonical rules:
 *   - Every locale has a `code` (string used for `Astro.currentLocale`),
 *     a `path` (URL segment / source directory name), and a `codes`
 *     array (every identifier that resolves back to this locale,
 *     including the canonical one).
 *   - Bare string locales (`"en"`) map to `{ code: "en", path: "en",
 *     codes: ["en"] }`.
 *   - Object locales (`{ path: "spanish", codes: ["es","es-AR"] }`)
 *     map to `{ code: "es", path: "spanish", codes: ["es","es-AR"] }` —
 *     the canonical `code` is the first entry in `codes`.
 *   - `defaultLocale` in the user config can reference either a plain
 *     locale string or the `path` of an aliased locale — we resolve it
 *     back to a `ResolvedI18nLocale`.
 *
 * The resolved config also pre-computes `byCode` and `byPath` maps so
 * lookups (needed on every `getPathByLocale`/`getLocaleByPath` call and
 * every route-match) are O(1).
 */

import type { AstroConfig } from "../astro-host/types";

export interface ResolvedI18nLocale {
  /** Canonical locale code (what `Astro.currentLocale` returns). */
  code: string;
  /** URL path segment / source directory name. Defaults to `code`. */
  path: string;
  /**
   * Every identifier that resolves back to this locale. Always includes
   * `code`; for aliased locales, also contains the extra codes.
   */
  codes: string[];
}

export interface ResolvedI18nRouting {
  /**
   * When `true`, the default locale also gets a `/<path>/...` URL
   * prefix. When `false` (Astro default), the default locale is served
   * from unprefixed URLs.
   */
  prefixDefaultLocale: boolean;
  /**
   * When `true` and `prefixDefaultLocale` is also `true`, unprefixed
   * requests (`/foo`) emit a redirect to `/<defaultLocale.path>/foo`.
   */
  redirectToDefaultLocale: boolean;
  /**
   * How fallback locales fill missing pages:
   *   - `"redirect"` → emit a static redirect document pointing at the
   *     fallback locale's URL
   *   - `"rewrite"` → render the fallback source page at the localized
   *     URL (Astro default)
   */
  fallbackType: "rewrite" | "redirect";
}

export interface ResolvedI18nConfig {
  defaultLocale: ResolvedI18nLocale;
  locales: ResolvedI18nLocale[];
  byCode: Map<string, ResolvedI18nLocale>;
  byPath: Map<string, ResolvedI18nLocale>;
  routing: ResolvedI18nRouting;
  /**
   * `target locale code → source locale code` mapping, flattened from
   * `i18n.fallback`. Single-step only; the expander walks chains.
   */
  fallback: Record<string, string>;
}

/**
 * Produce a `ResolvedI18nConfig` from a raw Astro config, or `null`
 * when the user didn't configure i18n at all. Call sites that want to
 * skip the i18n path entirely should branch on the `null` result.
 */
export function resolveI18nConfig(
  raw: AstroConfig["i18n"] | undefined,
): ResolvedI18nConfig | null {
  if (!raw || !raw.defaultLocale || !Array.isArray(raw.locales)) return null;

  const locales: ResolvedI18nLocale[] = raw.locales.map(normalizeLocale);
  const byCode = new Map<string, ResolvedI18nLocale>();
  const byPath = new Map<string, ResolvedI18nLocale>();

  for (const locale of locales) {
    for (const code of locale.codes) {
      if (!byCode.has(code)) byCode.set(code, locale);
    }
    if (!byPath.has(locale.path)) byPath.set(locale.path, locale);
  }

  // `defaultLocale` can be either a code or a path alias — resolve
  // against both maps.
  const defaultLocale =
    byCode.get(raw.defaultLocale) ?? byPath.get(raw.defaultLocale);
  if (!defaultLocale) {
    throw new Error(
      `i18n.defaultLocale "${raw.defaultLocale}" is not listed in i18n.locales`,
    );
  }

  const userRouting = (raw.routing as Record<string, unknown> | undefined) ?? {};
  const routing: ResolvedI18nRouting = {
    prefixDefaultLocale: userRouting.prefixDefaultLocale === true,
    redirectToDefaultLocale: userRouting.redirectToDefaultLocale !== false,
    fallbackType:
      userRouting.fallbackType === "redirect" ? "redirect" : "rewrite",
  };

  const fallback: Record<string, string> = {};
  const rawFallback = raw.fallback as Record<string, string> | undefined;
  if (rawFallback && typeof rawFallback === "object") {
    for (const [target, source] of Object.entries(rawFallback)) {
      // Normalize both sides to canonical codes — users may reference a
      // path alias. Skip entries pointing at unknown locales instead of
      // throwing, matching Astro's lenient behavior.
      const targetLocale = byCode.get(target) ?? byPath.get(target);
      const sourceLocale = byCode.get(source) ?? byPath.get(source);
      if (targetLocale && sourceLocale) {
        fallback[targetLocale.code] = sourceLocale.code;
      }
    }
  }

  return { defaultLocale, locales, byCode, byPath, routing, fallback };
}

function normalizeLocale(
  entry: string | { path: string; codes: string[] },
): ResolvedI18nLocale {
  if (typeof entry === "string") {
    return { code: entry, path: entry, codes: [entry] };
  }
  if (!entry.codes || entry.codes.length === 0) {
    throw new Error(
      `i18n locale { path: "${entry.path}" } must have at least one code`,
    );
  }
  return { code: entry.codes[0]!, path: entry.path, codes: [...entry.codes] };
}
