import path from "path";

export interface RouteParams {
  /** Value is `undefined` when a trailing rest segment matched zero path parts
   * (e.g. URL `/tz/` against `tz/[...page]`), matching Astro's semantics. */
  [key: string]: string | undefined;
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
  /**
   * Non-HTML endpoint route — a script file carrying its own extension
   * (`robots.txt.ts`, `eshop.json.ts`). Renders via an exported `GET()`
   * returning a Response, and emits that path verbatim instead of an
   * `index.html` directory.
   */
  isEndpoint: boolean;
}

interface RouteSegment {
  type: "static" | "param" | "rest";
  value: string; // segment text or param name
}

/**
 * Parse a page file path into a Route
 */
export function parseRoute(file: string): Route {
  const name = file.replace(/\.(tsx|jsx|ts|js|astro|mdx|md)$/, "");
  const parts = name.split("/").filter(Boolean);
  const segments: RouteSegment[] = [];
  let isDynamic = false;
  let priority = 0;

  // Astro convention: a .ts/.js route whose remaining basename still carries an
  // extension emits that file verbatim (`rss.xml.ts` → /rss.xml) rather than an
  // HTML page. Template formats are always HTML, so they never qualify.
  const isScript = /\.(ts|js)$/.test(file);
  const basename = parts[parts.length - 1] ?? "";
  const isEndpoint = isScript && basename.includes(".");

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

  return { file, segments, isDynamic, priority, isEndpoint };
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

  // All URL parts consumed, check all segments consumed.
  // Exception: a trailing rest segment may match zero remaining parts —
  // e.g. URL `/tz/` against `tz/[...page]` yields `{ page: undefined }`.
  if (si !== route.segments.length) {
    if (
      si === route.segments.length - 1 &&
      route.segments[si].type === "rest"
    ) {
      params[route.segments[si].value] = undefined;
      return params;
    }
    return null;
  }

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
      const value = params[seg.value];
      if (!value) {
        throw new Error(
          `Route "${route.file}": missing value for required param "${seg.value}". ` +
            `getStaticPaths() must return a non-empty string for every [param] segment. ` +
            `Got: ${JSON.stringify(params)}`,
        );
      }
      parts.push(value);
    } else if (seg.type === "rest") {
      // Astro's convention for catch-all routes: `undefined` means
      // "no extra segments" (the catch-all matched nothing). We
      // simply omit that segment from the output path.
      const v = params[seg.value];
      if (v) parts.push(...v.split("/"));
    }
  }

  if (parts.length === 0) {
    return "index.html";
  }
  // Endpoints own their filename — no index.html directory wrapper.
  if (route.isEndpoint) {
    return path.join(...parts);
  }
  return path.join(...parts, "index.html");
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
