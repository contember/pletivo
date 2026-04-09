import path from "path";
import { Glob } from "bun";

export interface RouteParams {
  [key: string]: string;
}

export interface StaticPath {
  params: RouteParams;
  props?: Record<string, unknown>;
}

export interface Route {
  /** Original file path relative to pages dir (e.g. "blog/[slug].tsx") */
  file: string;
  /** URL pattern segments */
  segments: RouteSegment[];
  /** Whether this route has dynamic params */
  isDynamic: boolean;
  /** Priority for matching (lower = higher priority) */
  priority: number;
}

interface RouteSegment {
  type: "static" | "param" | "rest";
  value: string; // segment text or param name
}

/**
 * Parse a page file path into a Route
 */
export function parseRoute(file: string): Route {
  const name = file.replace(/\.(tsx|jsx|ts|js|astro)$/, "");
  const parts = name.split("/").filter(Boolean);
  const segments: RouteSegment[] = [];
  let isDynamic = false;
  let priority = 0;

  for (const part of parts) {
    if (part === "index") {
      // index files don't add a segment
      continue;
    }
    if (part.startsWith("[...") && part.endsWith("]")) {
      // Rest/catch-all param
      segments.push({ type: "rest", value: part.slice(4, -1) });
      isDynamic = true;
      priority += 100; // lowest priority
    } else if (part.startsWith("[") && part.endsWith("]")) {
      // Named param
      segments.push({ type: "param", value: part.slice(1, -1) });
      isDynamic = true;
      priority += 10;
    } else {
      segments.push({ type: "static", value: part });
      priority += 1;
    }
  }

  return { file, segments, isDynamic, priority };
}

/**
 * Try to match a URL pathname against a route, returning params if matched
 */
export function matchRoute(route: Route, pathname: string): RouteParams | null {
  const urlParts = pathname.split("/").filter(Boolean);
  const params: RouteParams = {};

  let si = 0; // segment index
  for (let ui = 0; ui < urlParts.length; ui++) {
    const seg = route.segments[si];
    if (!seg) return null; // more URL parts than segments

    if (seg.type === "static") {
      if (urlParts[ui] !== seg.value) return null;
      si++;
    } else if (seg.type === "param") {
      params[seg.value] = urlParts[ui];
      si++;
    } else if (seg.type === "rest") {
      // Rest captures everything remaining
      params[seg.value] = urlParts.slice(ui).join("/");
      return params; // consumed everything
    }
  }

  // All URL parts consumed, check all segments consumed
  if (si !== route.segments.length) return null;

  return params;
}

/**
 * Generate the output path for a route with given params
 */
export function routeToOutputPath(route: Route, params: RouteParams): string {
  const parts: string[] = [];
  for (const seg of route.segments) {
    if (seg.type === "static") {
      parts.push(seg.value);
    } else if (seg.type === "param") {
      parts.push(params[seg.value]);
    } else if (seg.type === "rest") {
      parts.push(...params[seg.value].split("/"));
    }
  }

  if (parts.length === 0) {
    return "index.html";
  }
  return path.join(...parts, "index.html");
}

/**
 * Scan pages directory and return sorted routes (static first, then by priority)
 */
export async function scanRoutes(pagesDir: string): Promise<Route[]> {
  const glob = new Glob("**/*.{tsx,jsx,ts,js,astro}");
  const routes: Route[] = [];

  for await (const file of glob.scan(pagesDir)) {
    routes.push(parseRoute(file));
  }

  // Sort: static routes first, then by priority (lower = higher priority)
  routes.sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    return a.priority - b.priority;
  });

  return routes;
}

/**
 * Find the best matching route for a URL
 */
export function findRoute(routes: Route[], pathname: string): { route: Route; params: RouteParams } | null {
  for (const route of routes) {
    const params = matchRoute(route, pathname);
    if (params !== null) {
      return { route, params };
    }
  }
  return null;
}
