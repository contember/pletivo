import { Glob } from "bun";
import { existsSync } from "fs";
import { compareRoutes, isRouteFile, parseRoute, type Route } from "@pletivo/core/router";

export * from "@pletivo/core/router";

/**
 * Scan pages directory and return sorted routes (static first, then by priority)
 */
export async function scanRoutes(pagesDir: string): Promise<Route[]> {
  // As in Astro, a project without a pages directory builds no pages.
  if (!existsSync(pagesDir)) return [];
  const glob = new Glob("**/*.{tsx,jsx,ts,js,astro,mdx,md}");
  const routes: Route[] = [];

  // `dot`, so `isRouteFile` decides on dot entries, as it lets `.well-known` through.
  for await (const file of glob.scan({ cwd: pagesDir, dot: true })) {
    if (!isRouteFile(file)) continue;
    routes.push(parseRoute(file));
  }

  // Static routes first, then by priority (lower = higher priority), then in Astro's order.
  routes.sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    return a.priority - b.priority || compareRoutes(a, b);
  });

  return routes;
}
