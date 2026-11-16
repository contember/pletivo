/**
 * Framework components rendered through Astro's renderer protocol, wrapped in
 * `<astro-island>` when hydrated. Inactive until a host calls `configureAstroIslands`:
 * then every non-`.astro` component call is offered here first.
 */
import type { AstroIslandsConfig, FrameworkComponentCall, FrameworkComponentResult } from "./types";

export type * from "./types";

let config: AstroIslandsConfig | null = null;

/** Set by the host once per process, before any page renders; `null` turns islands off. */
export function configureAstroIslands(next: AstroIslandsConfig | null): void {
  config = next;
}

export function astroIslandsConfigured(): boolean {
  return config !== null && config.renderers.length > 0;
}

let pageResult: () => object | undefined = () => undefined;

/** The shim binds the page scope here; the JSX runtime has no result of its own to pass. */
export function bindPageResult(accessor: () => object | undefined): void {
  pageResult = accessor;
}

/** The result of the page being rendered, for a JSX-runtime call. */
export function currentPageResult(): object | undefined {
  return pageResult();
}

/**
 * Offer a component call to the configured renderers. Returns `null` synchronously when
 * islands are off, so callers keep their own path untouched; the promise resolves to
 * `null` when no renderer claims the component and it is not hydrated.
 */
export function renderFrameworkComponent(call: FrameworkComponentCall): FrameworkComponentResult {
  if (!astroIslandsConfigured()) return null;
  throw new Error(`renderFrameworkComponent is not implemented yet (${call.displayName})`);
}
