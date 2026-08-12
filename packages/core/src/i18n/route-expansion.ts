/**
 * Inspect a pletivo source-file route and determine which i18n locale
 * it belongs to. Each page file lives in exactly one locale: either
 * under `src/pages/<localePath>/...` (explicit locale subdir) or
 * `src/pages/...` (root — treated as the default locale when
 * `prefixDefaultLocale: false`, non-localized otherwise).
 *
 * Route expansion in pletivo does **not** multiply page routes across
 * locales by itself. One source file produces one AstroRoute with its
 * URL tracked verbatim from the file path. Additional per-locale
 * AstroRoutes for **fallback** pages are synthesized separately by
 * `fallback.ts` (Phase 3); this module only handles the original set.
 */

import type { Route } from "../router";
import type { ResolvedI18nConfig, ResolvedI18nLocale } from "./config";

export interface LocaleDetection {
  /**
   * Resolved locale for this route, or `null` when the route is
   * explicitly non-localized (root file with `prefixDefaultLocale: true`).
   */
  locale: ResolvedI18nLocale | null;
  /**
   * True when the URL pathname begins with this locale's path segment.
   * Used to decide whether `Astro.currentLocale` should be baked in.
   */
  hasLocaleInPath: boolean;
}

/**
 * Examine the first static segment of `route` and match it against
 * the configured locale path segments. See file header for the exact
 * routing rules.
 */
export function detectRouteLocale(
  route: Route,
  config: ResolvedI18nConfig,
): LocaleDetection {
  const firstSegment = route.segments[0];

  if (firstSegment && firstSegment.type === "static") {
    const match = config.byPath.get(firstSegment.value);
    if (match) {
      return { locale: match, hasLocaleInPath: true };
    }
  }

  // No locale subdirectory: root file. Under `prefixDefaultLocale:
  // false`, Astro treats these as default-locale content served from
  // unprefixed URLs. Under `prefixDefaultLocale: true`, they are
  // considered non-localized (no `Astro.currentLocale`).
  if (!config.routing.prefixDefaultLocale) {
    return { locale: config.defaultLocale, hasLocaleInPath: false };
  }
  return { locale: null, hasLocaleInPath: false };
}
