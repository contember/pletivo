/**
 * The isolate-side runtime as one module, because `render-context.ts` holds an
 * AsyncLocalStorage: two copies would record a `.tsx` page's CSS into a store the host
 * never reads. The JSX `Fragment` is aliased here and renamed back by
 * `pletivo-jsx-runtime.js`; it differs from the Astro shim's, which honours `set:html`.
 * `createPaginate` is here because `getStaticPaths` runs in the isolate.
 */

export * from "@pletivo/runtime/astro-shim";
export { jsx, jsxs, jsxDEV, Fragment as jsxFragment } from "@pletivo/runtime/jsx-runtime";
export { createPaginate } from "@pletivo/core/paginate";
