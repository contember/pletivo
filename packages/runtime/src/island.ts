/**
 * Server-side island handling.
 *
 * Island components are detected in the JSX runtime when they have a `client` prop.
 * This module tracks which islands are used so the build step can bundle them.
 */

export type HydrateStrategy = "load" | "idle" | "visible" | string; // string for media queries

/** Registry of islands used during a render pass */
const usedIslands = new Map<string, string>(); // componentName → file path

export function resetIslandRegistry() {
  usedIslands.clear();
}

export function getUsedIslands(): Map<string, string> {
  return new Map(usedIslands);
}

export function registerIsland(name: string, filePath: string) {
  usedIslands.set(name, filePath);
}

/**
 * Render an island's server HTML wrapped in the hydration marker.
 */
export function renderIslandWrapper(
  componentName: string,
  hydrate: HydrateStrategy,
  props: Record<string, unknown>,
  innerHtml: string,
): string {
  const safeProps = JSON.stringify(props)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;");

  return `<pletivo-island data-component="${componentName}" data-props='${safeProps}' data-hydrate="${hydrate}">${innerHtml}</pletivo-island>`;
}
