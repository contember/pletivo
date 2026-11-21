/**
 * `redirects` from the Astro config, answered as Astro's `renderRedirect` answers a GET:
 * a destination that names a route goes to that route's URL with the configured status,
 * any other to the destination as written, with a 301.
 */

import { routePath, type Route } from "../router";
import type { AstroConfig } from "./types";

export interface ConfigRedirect {
  /** The source as configured, e.g. `/old`. */
  source: string;
  /** The source's path segments: what a static build writes the page under. */
  parts: string[];
  status: number;
  location: string;
}

export interface ConfigRedirects {
  redirects: ConfigRedirect[];
  /** Sources with a dynamic segment, which pletivo does not answer. */
  dynamic: string[];
}

export function configRedirects(config: Pick<AstroConfig, "redirects" | "trailingSlash">, routes: readonly Route[]): ConfigRedirects {
  const routeByPath = new Map(routes.map((route) => [routePath(route), route]));
  const redirects: ConfigRedirect[] = [];
  const dynamic: string[] = [];
  for (const [source, target] of Object.entries(config.redirects)) {
    const parts = source.split("/").filter(Boolean);
    if (parts.some((part) => part.includes("["))) {
      dynamic.push(source);
      continue;
    }
    const destination = typeof target === "string" ? target : target.destination;
    const named = routeByPath.has(destination);
    const status = named && typeof target === "object" ? target.status : 301;
    // The named route's URL, as its generator writes it: a trailing slash only under "always".
    const slashed = named && config.trailingSlash === "always" && destination !== "/";
    redirects.push({ source, parts, status, location: encodeURI(slashed ? `${destination}/` : destination) });
  }
  return { redirects, dynamic };
}

/** The redirect whose source is `pathname` (no trailing slash, `/` for the root), if any. */
export function findConfigRedirect(redirects: readonly ConfigRedirect[], pathname: string): ConfigRedirect | undefined {
  return redirects.find((redirect) => `/${redirect.parts.join("/")}` === pathname);
}
