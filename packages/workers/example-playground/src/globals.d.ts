/**
 * Which module this worker's self-referential bindings are derived from.
 *
 * `wrangler types` generates exactly this. `durableNamespaces` is what makes
 * `DurableObjectNamespace<ProjectDO>` resolve to the class's own RPC methods, which is
 * how the content binding — a stub to the object itself — is typed at all.
 */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces: "ProjectDO";
  }
}

/** `{ "type": "Text" }` in wrangler.jsonc turns a `.css` import into its text. */
declare module "*.css" {
  const content: string;
  export default content;
}

/** Likewise the playground shell, which is served as-is. */
declare module "*.html" {
  const content: string;
  export default content;
}

/** And every file of the seed project. See `seed.ts` for why the config is `.mjs`. */
declare module "*.astro" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.mjs" {
  const content: string;
  export default content;
}
