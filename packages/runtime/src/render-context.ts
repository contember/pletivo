/**
 * Per-render-pass tracking context.
 *
 * Two things are collected while a page renders:
 *
 *  - **rendered module ids** — component modules whose render function ran.
 *    Build/dev use this to decide which components' `<style is:global>` CSS
 *    to emit; class-presence gating can't catch components that declare only
 *    global styles and render no scoped DOM.
 *  - **TSX styles** — literal `<style>` JSX elements, hoisted into `<head>`
 *    instead of being emitted inline.
 *
 * Uses AsyncLocalStorage so concurrent page renders (e.g. `Promise.all` over
 * routes in the build loop) stay isolated. Wrap each render in
 * `runWithRenderTracking(fn)`; inside, `createComponent`'s wrapped invocation
 * adds its `moduleId` to the current store.
 *
 * Lives apart from the shim so `jsx-runtime` can reach `pushTsxStyle` without
 * importing the whole Astro compatibility layer.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RenderContextState {
  renderedModules?: Set<string>;
  tsxStyles?: string[];
  slotArgs?: unknown[];
}

const renderContextStorage = new AsyncLocalStorage<RenderContextState>();

export async function runWithRenderTracking<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; renderedModules: Set<string>; tsxStyles: string[] }> {
  const renderedModules = new Set<string>();
  const tsxStyles: string[] = [];
  const value = await renderContextStorage.run(
    {
      renderedModules,
      tsxStyles,
      slotArgs: renderContextStorage.getStore()?.slotArgs,
    },
    fn,
  );
  return { value, renderedModules, tsxStyles };
}

export function runWithSlotArgs<T>(
  slotArgs: unknown[] | undefined,
  fn: () => T,
): T {
  const current = renderContextStorage.getStore();
  return renderContextStorage.run(
    {
      renderedModules: current?.renderedModules,
      tsxStyles: current?.tsxStyles,
      slotArgs,
    },
    fn,
  );
}

export function getSlotArgs(): unknown[] | undefined {
  return renderContextStorage.getStore()?.slotArgs;
}

/**
 * Record a `<style>` block encountered during TSX rendering. The JSX
 * runtime calls this for literal `<style>` JSX elements so the CSS is
 * hoisted into `<head>` instead of emitted inline. Collected per render
 * pass and included in the page's CSS bundle alongside scoped/global
 * Astro styles.
 */
export function pushTsxStyle(css: string): void {
  renderContextStorage.getStore()?.tsxStyles?.push(css);
}

/** Record a component module id as rendered in the current pass. */
export function recordRenderedModule(moduleId: string): void {
  renderContextStorage.getStore()?.renderedModules?.add(moduleId);
}
