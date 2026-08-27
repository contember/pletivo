import { Glob } from "bun";
import { parseRoute, type Route } from "@pletivo/core/router";

export * from "@pletivo/core/router";

/**
 * Scan pages directory and return sorted routes (static first, then by priority)
 */
export async function scanRoutes(pagesDir: string): Promise<Route[]> {
  const glob = new Glob("**/*.{tsx,jsx,ts,js,astro,mdx,md}");
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
