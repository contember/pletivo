/**
 * Convert pavouk's internal `Route` objects into the shape that Astro
 * integrations consume via `astro:routes:resolved` and the `routes`
 * field of `astro:build:done`.
 *
 * Dynamic routes are pre-expanded: each entry returned by a route's
 * `getStaticPaths()` becomes its own AstroRoute, so downstream
 * integrations (sitemap, agent-summary, etc.) see one entry per final
 * URL rather than a single `/[slug]` pattern with params.
 *
 * Redirects declared in `config.redirects` (populated by integrations
 * like @nuasite/nua from Astro's config) are emitted as
 * `type: "redirect"` entries so integrations can differentiate them
 * from rendered pages.
 */

import path from "path";
import type { Route, StaticPath } from "../router";
import type { AstroConfig, AstroRoute } from "./types";

export interface PavoukRouteWithPaths {
  route: Route;
  /** `undefined` for static routes; array of resolved paths for dynamic routes */
  staticPaths?: StaticPath[];
}

/**
 * Build the AstroRoute[] array from pavouk routes + Astro config redirects.
 */
export function buildAstroRoutes(
  routes: PavoukRouteWithPaths[],
  config: AstroConfig,
): AstroRoute[] {
  const out: AstroRoute[] = [];

  for (const entry of routes) {
    const r = entry.route;
    if (r.isDynamic) {
      const paths = entry.staticPaths ?? [];
      for (const sp of paths) {
        const pathname = materializePathname(r, sp.params);
        out.push(makePageRoute(r, pathname, Object.keys(sp.params)));
      }
    } else {
      const pathname = materializePathname(r, {});
      out.push(makePageRoute(r, pathname, []));
    }
  }

  // Redirects from Astro config.redirects — keyed by URL pattern, value is
  // either a destination string or { status, destination }.
  for (const [from, value] of Object.entries(config.redirects ?? {})) {
    const destination = typeof value === "string" ? value : value.destination;
    const status = typeof value === "string" ? 302 : (value.status ?? 302);
    const pathname = stripLeadingSlash(from);
    out.push({
      type: "redirect",
      pathname,
      route: from,
      component: "",
      params: [],
      pattern: /.*/,
      generate: (p) => ensureLeadingSlash(typeof p === "string" ? p : pathname),
      redirect: { destination, status },
      fallbackRoutes: [],
      prerender: true,
      isIndex: false,
    });
  }

  return out;
}

/**
 * Compute the URL pathname (no leading slash) for a route given its
 * resolved params. Matches pavouk's own `routeToOutputPath` semantics
 * but emits `""` for the index instead of `index.html`.
 */
function materializePathname(route: Route, params: Record<string, string>): string {
  const parts: string[] = [];
  for (const seg of route.segments) {
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

function makePageRoute(
  route: Route,
  pathname: string,
  paramNames: string[],
): AstroRoute {
  // Minimal regex: exact match of the resolved pathname
  const pattern = new RegExp("^/?" + escapeRegex(pathname) + "/?$");
  return {
    type: "page",
    pathname,
    route: "/" + route.file.replace(/\.(tsx|jsx|ts|js|astro)$/, "").replace(/\/index$/, ""),
    component: path.posix.join("src/pages", route.file),
    params: paramNames,
    pattern,
    generate: (p) => {
      if (typeof p === "string") return ensureLeadingSlash(p);
      // Object form: re-materialize with the given params
      if (p && typeof p === "object") {
        const resolved = materializePathname(route, p as Record<string, string>);
        return ensureLeadingSlash(resolved);
      }
      return ensureLeadingSlash(pathname);
    },
    fallbackRoutes: [],
    prerender: true,
    isIndex: route.file === "index.tsx" || route.file === "index.jsx" || route.file === "index.astro",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureLeadingSlash(s: string): string {
  if (!s) return "/";
  return s.startsWith("/") ? s : "/" + s;
}

function stripLeadingSlash(s: string): string {
  return s.startsWith("/") ? s.slice(1) : s;
}
