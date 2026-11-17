/**
 * Astro's framework-renderer protocol as pletivo's runtime sees it. The host loads
 * each `addRenderer()` server entrypoint and hands the result here; the runtime
 * never imports a framework itself.
 */
import type { HtmlString } from "../html-string";

/** A compiled `.astro` slot, as `$$renderComponent` receives it. Kept structural: the JSX runtime must not import the shim. */
export type IslandSlots = Record<string, (...args: unknown[]) => unknown>;

/** Rendered markup a renderer returns from `renderToStaticMarkup`. */
export interface RendererMarkup {
  html: string;
  /** Extra `<astro-island>` attributes, e.g. React's `prefix`. */
  attrs?: Record<string, string>;
}

/** The fourth argument Astro passes to `check` and `renderToStaticMarkup` (Astro's `AstroComponentMetadata`). */
export interface RendererMetadata {
  displayName: string;
  /** The directive, absent for a static render. */
  hydrate?: "load" | "idle" | "visible" | "media" | "only";
  hydrateArgs?: unknown;
  componentUrl?: string;
  componentExport?: { value: string; namespace?: boolean };
  astroStaticSlot: true;
}

/** The module an integration's `serverEntrypoint` default-exports (Astro's `SSRLoadedRendererValue`). */
export interface RendererServer {
  name?: string;
  /** Called with `this.result` set to the page's result, which renderers use as a per-page key. */
  check(
    this: { result: object },
    Component: unknown,
    props: Record<string, unknown>,
    slots: Record<string, string>,
    metadata?: RendererMetadata,
  ): boolean | Promise<boolean>;
  renderToStaticMarkup(
    this: { result: object },
    Component: unknown,
    props: Record<string, unknown>,
    slots: Record<string, string>,
    metadata?: RendererMetadata,
  ): RendererMarkup | Promise<RendererMarkup>;
  supportsAstroStaticSlot?: boolean;
  renderHydrationScript?(): string;
}

/** A registered renderer with its server module loaded, in `addRenderer()` order. */
export interface LoadedRenderer {
  /** The name passed to `addRenderer`, e.g. `@astrojs/react`. */
  name: string;
  /** Absent for a server-only renderer, which cannot hydrate. */
  clientEntrypoint: string | null;
  ssr: RendererServer;
}

/**
 * Client-side URLs the host serves, base path included. Pure and deterministic, so the page
 * can be rendered before the bundles are written; the host must emit a file at every URL it returns.
 */
export interface IslandClientUrls {
  /** URL of the client module that exports `exportName` of the component at `componentPath`. */
  component(componentPath: string, exportName: string): string;
  /** URL of the renderer's client entrypoint. */
  renderer(rendererName: string): string;
  /** Astro's `before-hydration-url`: the bundle of `injectScript("before-hydration")` scripts, or `null` when there are none. */
  beforeHydration: string | null;
}

/** Astro's prebuilt hydration scripts, read by the host from the project's `astro` package. */
export interface IslandScripts {
  /** `astro-island.prebuilt.js`: defines the `<astro-island>` custom element. */
  island: string;
  /** `client/<directive>.prebuilt.js` by directive name: `load`, `idle`, `visible`, `media`, `only`. */
  directives: Readonly<Record<string, string>>;
}

export interface AstroIslandsConfig {
  renderers: readonly LoadedRenderer[];
  urls: IslandClientUrls;
  scripts: IslandScripts;
}

/**
 * One component call that may belong to a framework renderer.
 *
 * - `astro`: from `$$renderComponent` in a compiled `.astro` file. `props` are the
 *   compiler's props as passed, `class:list` and the `client:*` keys included;
 *   `client:component-path` is the absolute path of the imported file (no
 *   extension added) and `client:component-export` its export name.
 *   `Component` is `null` for `client:only`.
 * - `jsx`: from the JSX runtime (MDX content and `.tsx` pages). `props` are the
 *   JSX props, `children` included; `slots` is empty. MDX adds the same
 *   `client:component-path` and `client:component-export` keys to a hydrated
 *   element, as `@astrojs/mdx` does.
 *
 * Never offered: `.astro` components, pletivo's native components
 * (`./native.ts`), and calls with pletivo's own `client` island prop.
 */
export interface FrameworkComponentCall {
  source: "astro" | "jsx";
  /** The page's result. Renderers key their per-page ids on it, so it is only an identity here. */
  result: object;
  displayName: string;
  Component: unknown;
  props: Record<string, unknown>;
  slots: IslandSlots;
}

/** Rendered island or static framework markup, or `null` when no renderer claims the component. */
export type FrameworkComponentResult = Promise<HtmlString | null> | null;
