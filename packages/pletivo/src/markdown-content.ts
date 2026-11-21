/**
 * What a compiled `.md` module imports, by absolute path: the project's `node_modules`
 * may hold no pletivo to resolve a bare specifier from (`md-plugin.ts`).
 */
export { renderMarkdownWithHeadings } from "@pletivo/core/content/markdown";
export { markdownContent, markdownDocument } from "@pletivo/runtime/astro-shim";
