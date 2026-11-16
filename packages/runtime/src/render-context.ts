/**
 * Per-render-pass tracking context.
 *
 * Three things are collected while a page renders:
 *
 *  - **rendered module ids** — component modules whose render function ran.
 *    Build/dev use this to decide which components' `<style is:global>` CSS
 *    to emit; class-presence gating can't catch components that declare only
 *    global styles and render no scoped DOM.
 *  - **TSX styles** — literal `<style>` JSX elements, hoisted into `<head>`
 *    instead of being emitted inline.
 *  - **rendered script ids** — processed `<script>` ids already emitted, so a
 *    component rendered twice on a page emits its script once, as in Astro.
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
  renderedScripts?: Set<string>;
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
      renderedScripts: new Set(),
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
      // Shared, not copied: Astro's `Slots.render()` claims a slot's scripts at call
      // time, so a discarded render drops them there too, and nothing is emitted twice.
      renderedScripts: current?.renderedScripts,
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

/**
 * Claim a processed script id for the current render pass. False when the pass
 * already emitted it. Outside a tracked render (container renders) always true.
 */
export function claimScript(id: string): boolean {
  const rendered = renderContextStorage.getStore()?.renderedScripts;
  if (!rendered) return true;
  if (rendered.has(id)) return false;
  rendered.add(id);
  return true;
}
