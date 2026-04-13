/**
 * Synthesize the *extra* routes that i18n needs beyond the ones the
 * filesystem gives us. Two kinds of synthetic routes are generated:
 *
 *   1. **Fallback routes** — for every (source-route, target-locale)
 *      where the target locale has no own copy of the route but a
 *      fallback chain leads to a locale that does. With
 *      `fallbackType: "rewrite"` the target URL renders the source
 *      component but with `Astro.currentLocale` set to the target;
 *      with `fallbackType: "redirect"` the target URL serves a
 *      meta-refresh redirect document.
 *
 *   2. **Default-locale redirects** — when
 *      `prefixDefaultLocale: true && redirectToDefaultLocale: true`,
 *      every default-locale page also emits a redirect from its
 *      unprefixed URL to the prefixed one.
 *
 * Both kinds are produced as `FallbackEmission` records consumed by
 * build.ts (write static files) and dev.ts (match synthetic URLs).
 * The generator is pure — it reads the pletivo route list + i18n
 * config + dynamic `getStaticPaths` results and returns the
 * emissions without touching the filesystem.
 */

import { findRoute, type Route, type StaticPath, type RouteParams } from "../router";
import type { ResolvedI18nConfig, ResolvedI18nLocale } from "./config";
import { detectRouteLocale } from "./route-expansion";
import { fallbackChain } from "./helpers";

export interface FallbackEmission {
  /** Source route whose component gets rendered for rewrite mode. */
  sourceRoute: Route;
  /**
   * Resolved params for the source route. Empty object for static
   * routes; for dynamic routes, one emission per `getStaticPaths` entry.
   */
  sourceParams: Record<string, string>;
  /** Resolved props matching `sourceParams`, when provided. */
  sourceProps: Record<string, unknown>;
  /** Relative URL pathname (no leading slash) where this emission renders. */
  targetPathname: string;
  /**
   * `Astro.currentLocale` override for rewrite mode. Undefined for
   * pure redirect emissions where the destination page provides its
   * own locale context.
   */
  targetLocale: string | undefined;
  /** `"rewrite"` → render source; `"redirect"` → emit meta-refresh HTML. */
  mode: "rewrite" | "redirect";
  /** For redirect mode: absolute-from-root URL of the destination. */
  redirectTo?: string;
}

export interface FallbackGeneratorInput {
  routes: Route[];
  i18n: ResolvedI18nConfig;
  dynamicPaths: Map<string, StaticPath[]>;
  /** Astro `base` URL prefix (e.g. `"/new-site"`), stripped of trailing slash. */
  base: string;
}

export function generateFallbackEmissions(
  input: FallbackGeneratorInput,
): FallbackEmission[] {
  const out: FallbackEmission[] = [];
  out.push(...generateLocaleFallbacks(input));
  out.push(...generateDefaultLocaleRedirects(input));
  return out;
}

// ── Locale fallback chains ──────────────────────────────────────────

interface LocalelessGroup {
  /**
   * Pathname with the leading locale path segment stripped. `""` for
   * the locale index (e.g. `spanish/index.astro` → `""`).
   */
  key: string;
  /** All pletivo routes contributing to this group, keyed by locale code. */
  byLocale: Map<string, Route>;
}

function groupByLocalelessKey(
  routes: Route[],
  i18n: ResolvedI18nConfig,
): Map<string, LocalelessGroup> {
  const groups = new Map<string, LocalelessGroup>();

  for (const r of routes) {
    const detection = detectRouteLocale(r, i18n);
    if (!detection.locale) continue; // non-localized — skip fallback synthesis

    const key = localelessPathname(r, detection.locale, detection.hasLocaleInPath);
    let group = groups.get(key);
    if (!group) {
      group = { key, byLocale: new Map() };
      groups.set(key, group);
    }
    // First-wins if the same (key, locale) is contributed by multiple
    // source files (e.g. both `src/pages/start.astro` and
    // `src/pages/en/start.astro` map to en/start). This matches Astro's
    // documented convention of preferring the explicit locale-dir file
    // only when `prefixDefaultLocale: true`.
    if (!group.byLocale.has(detection.locale.code)) {
      group.byLocale.set(detection.locale.code, r);
    }
  }

  return groups;
}

/**
 * Pathname of `route` with the leading locale directory segment
 * removed. Used to align routes across locales so fallback emissions
 * can match them up.
 */
function localelessPathname(
  route: Route,
  locale: ResolvedI18nLocale,
  hasLocaleInPath: boolean,
): string {
  const parts: string[] = [];
  for (let i = 0; i < route.segments.length; i++) {
    if (i === 0 && hasLocaleInPath && route.segments[i]!.value === locale.path) {
      continue;
    }
    parts.push(route.segments[i]!.value);
  }
  return parts.join("/");
}

function generateLocaleFallbacks(
  input: FallbackGeneratorInput,
): FallbackEmission[] {
  const { routes, i18n, dynamicPaths, base } = input;
  if (Object.keys(i18n.fallback).length === 0) return [];

  const groups = groupByLocalelessKey(routes, i18n);
  const out: FallbackEmission[] = [];

  for (const group of groups.values()) {
    for (const targetLocale of i18n.locales) {
      if (group.byLocale.has(targetLocale.code)) continue;

      // Walk the fallback chain until we hit a locale that DOES have
      // a source for this key. The chain always starts with the
      // target itself — skip that and look at the rest.
      const chain = fallbackChain(i18n, targetLocale.code);
      let sourceRoute: Route | undefined;
      for (let i = 1; i < chain.length; i++) {
        const candidate = chain[i]!;
        const found = group.byLocale.get(candidate);
        if (found) {
          sourceRoute = found;
          break;
        }
      }
      if (!sourceRoute) continue;

      // Where the synthesized URL lives. For non-default locales it's
      // `<locale.path>/<key>`; for the default locale under
      // `prefixDefaultLocale: false`, it's just `<key>` (no prefix).
      const includePrefix =
        targetLocale.code !== i18n.defaultLocale.code ||
        i18n.routing.prefixDefaultLocale;
      const pathnameSegments: string[] = [];
      if (includePrefix) pathnameSegments.push(targetLocale.path);
      if (group.key) pathnameSegments.push(group.key);
      const targetPathname = pathnameSegments.join("/");

      const newPrefix = includePrefix ? targetLocale.path : "";

      if (sourceRoute.isDynamic) {
        const paths = dynamicPaths.get(sourceRoute.file) ?? [];
        for (const sp of paths) {
          out.push(
            makeFallbackEmission(
              sourceRoute,
              sp.params,
              sp.props ?? {},
              rewriteRouteWithPrefix(sourceRoute, newPrefix, sp.params),
              targetLocale.code,
              i18n.routing.fallbackType,
              base,
            ),
          );
        }
      } else {
        out.push(
          makeFallbackEmission(
            sourceRoute,
            {},
            {},
            targetPathname,
            targetLocale.code,
            i18n.routing.fallbackType,
            base,
          ),
        );
      }
    }
  }

  return out;
}

function makeFallbackEmission(
  sourceRoute: Route,
  sourceParams: Record<string, string>,
  sourceProps: Record<string, unknown>,
  targetPathname: string,
  targetLocaleCode: string,
  mode: "rewrite" | "redirect",
  base: string,
): FallbackEmission {
  if (mode === "rewrite") {
    return {
      sourceRoute,
      sourceParams,
      sourceProps,
      targetPathname,
      targetLocale: targetLocaleCode,
      mode,
    };
  }
  // Redirect mode points at the source route's *actual* URL. We
  // reconstruct it by materializing the source's pathname with the
  // same params the source would emit to.
  const sourcePathname = materializeRoute(sourceRoute, sourceParams);
  return {
    sourceRoute,
    sourceParams,
    sourceProps,
    targetPathname,
    targetLocale: undefined,
    mode,
    redirectTo: joinUrl(base, sourcePathname),
  };
}

// ── Default-locale redirects (prefixDefaultLocale + redirectToDefault) ──

function generateDefaultLocaleRedirects(
  input: FallbackGeneratorInput,
): FallbackEmission[] {
  const { routes, i18n, dynamicPaths, base } = input;
  if (!i18n.routing.prefixDefaultLocale) return [];
  if (!i18n.routing.redirectToDefaultLocale) return [];

  const out: FallbackEmission[] = [];
  const defaultLocale = i18n.defaultLocale;

  for (const r of routes) {
    const detection = detectRouteLocale(r, i18n);
    if (!detection.locale) continue;
    if (detection.locale.code !== defaultLocale.code) continue;
    if (!detection.hasLocaleInPath) continue;

    const key = localelessPathname(r, detection.locale, detection.hasLocaleInPath);

    void key; // key is the stripped variant; we re-derive below.

    if (r.isDynamic) {
      const paths = dynamicPaths.get(r.file) ?? [];
      for (const sp of paths) {
        const targetPathname = rewriteRouteWithPrefix(r, "", sp.params);
        const destination = materializeRoute(r, sp.params);
        out.push({
          sourceRoute: r,
          sourceParams: sp.params,
          sourceProps: sp.props ?? {},
          targetPathname,
          targetLocale: undefined,
          mode: "redirect",
          redirectTo: joinUrl(base, destination),
        });
      }
    } else {
      const destination = materializeRoute(r, {});
      out.push({
        sourceRoute: r,
        sourceParams: {},
        sourceProps: {},
        targetPathname: rewriteRouteWithPrefix(r, "", {}),
        targetLocale: undefined,
        mode: "redirect",
        redirectTo: joinUrl(base, destination),
      });
    }
  }

  return out;
}

// ── Path utilities ──────────────────────────────────────────────────

function materializeRoute(
  route: Route,
  params: Record<string, string>,
): string {
  return rewriteRouteWithPrefix(route, keepOriginalPrefix, params);
}

/** Sentinel that tells `rewriteRouteWithPrefix` to keep the first static segment. */
const keepOriginalPrefix = Symbol("keep-original-prefix") as unknown as string;

/**
 * Materialize a route's URL pathname with dynamic params substituted,
 * optionally replacing the leading static segment (the locale dir)
 * with a new prefix. Pass `""` to strip the leading segment entirely
 * (default-locale under `prefixDefaultLocale: false`), or
 * `keepOriginalPrefix` to leave it untouched.
 */
function rewriteRouteWithPrefix(
  route: Route,
  newPrefix: string | typeof keepOriginalPrefix,
  params: Record<string, string>,
): string {
  const parts: string[] = [];
  if (typeof newPrefix === "string" && newPrefix !== keepOriginalPrefix) {
    if (newPrefix) parts.push(newPrefix);
  }
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i]!;
    // Skip the leading locale directory segment when the caller wants
    // to replace it. With `keepOriginalPrefix` we emit every segment.
    if (i === 0 && seg.type === "static" && newPrefix !== keepOriginalPrefix) {
      continue;
    }
    if (seg.type === "static") {
      parts.push(seg.value);
    } else if (seg.type === "param") {
      const v = params[seg.value];
      if (v !== undefined) parts.push(v);
    } else if (seg.type === "rest") {
      const v = params[seg.value];
      if (v !== undefined) parts.push(...v.split("/"));
    }
  }
  return parts.join("/");
}

function joinUrl(base: string, pathname: string): string {
  const b = base.replace(/\/$/, "");
  const p = pathname.replace(/^\//, "");
  return `${b}/${p}`;
}

// ── Dev-server on-demand fallback resolution ─────────────────────────

export interface FallbackMatch {
  /** Source route whose component should be rendered. */
  route: Route;
  /** Params resolved against the source route. */
  params: RouteParams;
  /** Locale override for `Astro.currentLocale` (rewrite mode). */
  targetLocale: string;
  /** How the dev server should handle the match. */
  mode: "rewrite" | "redirect";
  /** For redirect mode: destination URL the dev server should 302 to. */
  redirectTo?: string;
}

/**
 * On-demand lookup used by the dev server when `findRoute` misses.
 * Given a request pathname like `/it/blog/hello`, tries to resolve it
 * against the fallback chain: strip the locale prefix, walk to each
 * fallback locale in turn, and attempt to match the remainder against
 * the known routes under that locale's source directory. Returns the
 * resolved route + params + locale override, or `null` when no
 * fallback applies.
 *
 * Accepts both rewrite and redirect modes — the caller decides how to
 * respond based on `match.mode`.
 */
export function resolveFallbackRoute(
  pathname: string,
  routes: Route[],
  i18n: ResolvedI18nConfig,
  base: string,
): FallbackMatch | null {
  const cleaned = pathname.replace(/^\/+|\/+$/g, "");
  const firstSlash = cleaned.indexOf("/");
  const firstSegment = firstSlash === -1 ? cleaned : cleaned.slice(0, firstSlash);
  const rest = firstSlash === -1 ? "" : cleaned.slice(firstSlash + 1);

  // The first URL segment must map to a known locale path — otherwise
  // this isn't something fallback logic should touch.
  const targetLocale = i18n.byPath.get(firstSegment);
  if (!targetLocale) return null;

  // If fallback chain is empty (just the target), nothing to do.
  const chain = fallbackChain(i18n, targetLocale.code);
  if (chain.length <= 1) return null;

  for (let i = 1; i < chain.length; i++) {
    const sourceCode = chain[i]!;
    const sourceLocale = i18n.byCode.get(sourceCode);
    if (!sourceLocale) continue;

    // Try the locale's prefixed form first (`src/pages/en/start.astro`
    // → `/en/start`). For the default locale under
    // `prefixDefaultLocale: false`, also try the unprefixed form
    // (`src/pages/start.astro` → `/start`). The first one that
    // findRoute accepts AND resolves back to the source locale wins.
    const isDefault = sourceLocale.code === i18n.defaultLocale.code;
    const allowUnprefixed = isDefault && !i18n.routing.prefixDefaultLocale;

    const candidatePathnames: string[] = [];
    // Prefixed candidate — always try it first so subdir conventions
    // take precedence over root-level conventions when both exist.
    candidatePathnames.push(
      rest ? `${sourceLocale.path}/${rest}` : sourceLocale.path,
    );
    if (allowUnprefixed) {
      candidatePathnames.push(rest);
    }

    for (const sourcePathname of candidatePathnames) {
      const match = findRoute(routes, `/${sourcePathname}`);
      if (!match) continue;

      // Sanity-check: the matched route really should be in the
      // source locale's scope. Skip otherwise (prevents false
      // positives when an unrelated root file matches).
      const detection = detectRouteLocale(match.route, i18n);
      if (!detection.locale || detection.locale.code !== sourceLocale.code) {
        continue;
      }

      if (i18n.routing.fallbackType === "redirect") {
        return {
          route: match.route,
          params: match.params,
          targetLocale: targetLocale.code,
          mode: "redirect",
          redirectTo: joinUrl(base, sourcePathname),
        };
      }
      return {
        route: match.route,
        params: match.params,
        targetLocale: targetLocale.code,
        mode: "rewrite",
      };
    }
  }

  return null;
}

/**
 * Detect if the incoming request should be redirected from its
 * unprefixed URL to the default-locale-prefixed URL. Matches the
 * static-build behavior of `redirectToDefaultLocale: true`.
 */
export function resolveDefaultLocaleRedirect(
  pathname: string,
  routes: Route[],
  i18n: ResolvedI18nConfig,
  base: string,
): string | null {
  if (!i18n.routing.prefixDefaultLocale) return null;
  if (!i18n.routing.redirectToDefaultLocale) return null;

  const cleaned = pathname.replace(/^\/+|\/+$/g, "");
  const firstSlash = cleaned.indexOf("/");
  const firstSegment = firstSlash === -1 ? cleaned : cleaned.slice(0, firstSlash);

  // Already prefixed with a known locale — no redirect needed.
  if (i18n.byPath.has(firstSegment)) return null;

  // Match the unprefixed path against the default locale's source
  // routes. If a match exists, emit a redirect to the prefixed URL.
  const defaultPrefix = i18n.defaultLocale.path;
  const candidate = cleaned ? `/${defaultPrefix}/${cleaned}` : `/${defaultPrefix}`;
  const match = findRoute(routes, candidate);
  if (!match) return null;
  const detection = detectRouteLocale(match.route, i18n);
  if (detection.locale?.code !== i18n.defaultLocale.code) return null;
  if (!detection.hasLocaleInPath) return null;

  return joinUrl(base, candidate.replace(/^\//, ""));
}
