/**
 * What the host answers before it renders, from the artifact's routing config: Astro's
 * `trailingSlash`, config `redirects`, and i18n's redirect to the default locale. In
 * preview every one of them is an HTTP redirect, where a static build emits a page.
 */

import type { ArtifactConfig, ArtifactRedirect } from "@pletivo/core/artifact";
import type { ResolvedI18nConfig } from "@pletivo/core/i18n/config";
import { resolveDefaultLocaleRedirect } from "@pletivo/core/i18n/fallback";
import { matchRoute, parseRoute, type Route, type RouteParams } from "@pletivo/core/router";

export interface Redirect {
  location: string;
  status: number;
}

/** A page route that answers with a redirect instead of HTML (an i18n fallback in redirect mode). */
export class RouteRedirect extends Error {
  constructor(
    readonly location: string,
    readonly status: number,
  ) {
    super(`[pletivo-workers] redirect to ${JSON.stringify(location)} (${status})`);
    this.name = "RouteRedirect";
  }
}

/** The redirect `url` gets before routing, or `null` when it goes on to a page. */
export function routeRedirect(
  url: URL,
  config: ArtifactConfig | undefined,
  i18n: ResolvedI18nConfig | null,
  routes: Route[],
): Redirect | null {
  const { pathname, search } = url;

  const slash = trailingSlashRedirect(pathname, config?.trailingSlash);
  if (slash !== null) return { location: slash + search, status: 301 };

  for (const redirect of config?.redirects ?? []) {
    const params = matchRoute(parseRoute(redirect.source.slice(1)), pathname);
    if (params !== null) return { location: destination(redirect, params), status: redirect.status };
  }

  if (i18n !== null) {
    const localized = resolveDefaultLocaleRedirect(pathname, routes, i18n, "/");
    if (localized !== null) return { location: localized + search, status: 302 };
  }
  return null;
}

/** The canonical form of `pathname` under `trailingSlash`, or `null` when it already is. */
function trailingSlashRedirect(pathname: string, mode: ArtifactConfig["trailingSlash"]): string | null {
  if (pathname === "/" || mode === undefined || mode === "ignore") return null;
  // A file-like last segment (`/feed.xml`) keeps its form, as Astro's does.
  const last = pathname.slice(pathname.lastIndexOf("/", pathname.length - 2) + 1);
  if (last.replace(/\/$/, "").includes(".")) return null;
  if (mode === "always" && !pathname.endsWith("/")) return `${pathname}/`;
  if (mode === "never" && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return null;
}

/** The redirect's destination with the source's `[param]`s and `[...rest]` filled in. */
function destination(redirect: ArtifactRedirect, params: RouteParams): string {
  return redirect.destination.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_match, _rest: string | undefined, name: string) =>
    params[name] ?? "",
  );
}
