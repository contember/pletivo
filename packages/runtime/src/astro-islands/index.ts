/**
 * Framework components rendered through Astro's renderer protocol, wrapped in
 * `<astro-island>` when hydrated. Inactive until a host calls `configureAstroIslands`:
 * then every non-`.astro` component call is offered here first.
 */
import { renderFrameworkCall } from "./render";
import type { AstroIslandsConfig, FrameworkComponentCall, FrameworkComponentResult, RendererServer } from "./types";

export type * from "./types";
export { finalizeIslandScripts, hoistIslandScripts } from "./prescripts";

let config: AstroIslandsConfig | null = null;

/** Astro's `SSRLoadedRendererValue`: the functions are called as Astro calls them, so only their presence is checked. */
export function isRendererServer(value: unknown): value is RendererServer {
  if (typeof value !== "object" || value === null) return false;
  const supportsAstroStaticSlot: unknown = Reflect.get(value, "supportsAstroStaticSlot");
  const renderHydrationScript: unknown = Reflect.get(value, "renderHydrationScript");
  return (
    typeof Reflect.get(value, "check") === "function" &&
    typeof Reflect.get(value, "renderToStaticMarkup") === "function" &&
    (supportsAstroStaticSlot === undefined || typeof supportsAstroStaticSlot === "boolean") &&
    (renderHydrationScript === undefined || typeof renderHydrationScript === "function")
  );
}

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

let renderToString: (value: unknown) => Promise<string> = async () => {
  throw new Error("the Astro shim has not bound its renderer");
};

/** The shim binds its value renderer here, for slots and JSX children. */
export function bindRenderValue(renderer: (value: unknown) => Promise<string>): void {
  renderToString = renderer;
}

/** Render a slot's or a child's value to HTML, the way the shim renders any value. */
export function renderValueToString(value: unknown): Promise<string> {
  return renderToString(value);
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
  const active = config;
  if (active === null || !astroIslandsConfigured()) return null;
  return renderFrameworkCall(call, active, renderValueToString);
}
