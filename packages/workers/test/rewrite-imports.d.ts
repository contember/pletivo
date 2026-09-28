/** Bun keys its module registry by the whole specifier, so the query loads a fresh instance. */
declare module "*/rewrite-imports.ts?without-bun" {
  export * from "@pletivo/workers/rewrite-imports";
}
