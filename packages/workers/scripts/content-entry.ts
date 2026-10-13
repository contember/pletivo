/**
 * The isolate's content module: collections plus the Markdown pipeline they render
 * with. One module, so `configureMarkdown` installs the plugins that both a collection
 * entry and a `.md` page render with, and AsyncLocalStorage has one record.
 */

export * from "@pletivo/core/content/collection";
export { configureMarkdown, parseMarkdown } from "@pletivo/core/content/markdown";
