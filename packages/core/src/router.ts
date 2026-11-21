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
   * (`robots.txt.ts`, `eshop.json.ts`), or an extensionless one whose module
   * exports `GET()` and no default (see `resolveScriptRoute`). Renders via an
   * exported `GET()` returning a Response, and emits that path verbatim
   * instead of an `index.html` directory.
   */
  isEndpoint: boolean;
}

interface RouteSegment {
  type: "static" | "param" | "rest";
  value: string; // segment text or param name
}

/**
 * Whether a file under the pages dir is a route, by its path relative to that dir. As in Astro
 * (`createFileBasedRoutes`), a file or directory whose name starts with `_` is not, and neither is
 * one whose name starts with `.`, except `.well-known`.
 */
export function isRouteFile(file: string): boolean {
  return !file.split("/").some(
    (part) => part.startsWith("_") || (part.startsWith(".") && part !== ".well-known"),
  );
}

/**
 * Parse a page file path into a Route
 */
export function parseRoute(file: string): Route {
  const name = file.replace(/\.(tsx|jsx|ts|js|astro|mdx|md|html)$/, "");
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
 * Astro's `routeComparator`: the order routes are matched in, and the route that keeps
 * a path two routes build. Per segment, a static one comes first (two static ones
 * alphabetically), then a param before a rest; a longer route before a shorter one,
 * except that a route one rest segment longer comes after; an endpoint before a page;
 * then the route path alphabetically.
 */
export function compareRoutes(a: Route, b: Route): number {
  const commonLength = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < commonLength; index++) {
    const aSegment = a.segments[index]!;
    const bSegment = b.segments[index]!;
    const aIsStatic = aSegment.type === "static";
    const bIsStatic = bSegment.type === "static";
    if (aIsStatic && bIsStatic && aSegment.value !== bSegment.value) {
      return aSegment.value.localeCompare(bSegment.value);
    }
    if (aIsStatic !== bIsStatic) return aIsStatic ? -1 : 1;
    const aIsRest = aSegment.type === "rest";
    const bIsRest = bSegment.type === "rest";
    if (aIsRest !== bIsRest) return aIsRest ? 1 : -1;
  }

  const aLength = a.segments.length;
  const bLength = b.segments.length;
  if (aLength !== bLength) {
    const aEndsInRest = a.segments.at(-1)?.type === "rest";
    const bEndsInRest = b.segments.at(-1)?.type === "rest";
    if (aEndsInRest !== bEndsInRest && Math.abs(aLength - bLength) === 1) {
      if (aLength > bLength && aEndsInRest) return 1;
      if (bLength > aLength && bEndsInRest) return -1;
    }
    return aLength > bLength ? -1 : 1;
  }

  if (a.isEndpoint !== b.isEndpoint) return a.isEndpoint ? -1 : 1;
  return routePath(a).localeCompare(routePath(b));
}

/** A route as Astro names it: `/blog/[slug]`, `/[...rest]`, `/`. */
export function routePath(route: Route): string {
  const parts = route.segments.map((segment) =>
    segment.type === "static" ? segment.value : segment.type === "param" ? `[${segment.value}]` : `[...${segment.value}]`,
  );
  return `/${parts.join("/")}`;
}

/**
 * Settle an extensionless `.ts`/`.js` route once its module is loaded. Astro
 * makes every script page an endpoint (`api.ts` → `/api`), but pletivo also
 * renders a script page's default export as HTML, so the exports decide.
 */
export function resolveScriptRoute(route: Route, mod: Record<string, unknown>): Route {
  if (route.isEndpoint || !/\.(ts|js)$/.test(route.file)) return route;
  if (typeof mod.default === "function" || typeof mod.GET !== "function") return route;
  return { ...route, isEndpoint: true };
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
/** Astro's `build.format`: how a page's path becomes its output file. */
export type OutputFormat = "directory" | "file" | "preserve";

/** Astro writes these pages as `<status>.html` even under the `directory` format. */
const STATUS_CODE_PAGES = new Set(["404", "500"]);

/**
 * A page's output file from its path segments, as Astro's `getOutFolder` / `getOutFile`
 * name it under `format`. `index` is a route written as an `index.*` file.
 */
export function pageOutputPath(parts: readonly string[], format: OutputFormat, index: boolean): string {
  if (parts.length === 0) return "index.html";
  const joined = parts.join("/");
  if (format === "file" || (format === "preserve" && !index)) return `${joined}.html`;
  if (format === "directory" && parts.length === 1 && STATUS_CODE_PAGES.has(joined)) return `${joined}.html`;
  return path.join(joined, "index.html");
}

/**
 * The output file of `route` with `params`. Without `format` every page is
 * `<path>/index.html`; with Astro's `build.format`, see `pageOutputPath`.
 */
export function routeToOutputPath(route: Route, params: RouteParams, format?: OutputFormat): string {
  const parts: string[] = [];
  for (const seg of route.segments) {
    if (seg.type === "static") {
      parts.push(seg.value);
    } else if (seg.type === "param") {
      // `matchRoute` always fills a required `[param]`, but `getStaticPaths`
      // (and the JSON-restored incremental cache) can hand us a missing one.
      // Dropping it would silently emit a colliding path and `path.join`
      // would throw an unattributable TypeError — so fail with the route named.
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

  // Endpoints own their filename — no index.html directory wrapper.
  if (route.isEndpoint && parts.length > 0) {
    return path.join(...parts);
  }
  if (format !== undefined) return pageOutputPath(parts, format, isIndexRoute(route));
  if (parts.length === 0) {
    return "index.html";
  }
  return path.join(...parts, "index.html");
}

/** The route is written as an `index.*` file, which the `preserve` format keeps as `index.html`. */
function isIndexRoute(route: Route): boolean {
  return /(^|\/)index\.[^/]+$/.test(route.file);
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
