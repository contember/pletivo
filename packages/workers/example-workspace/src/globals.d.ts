/**
 * What `ctx.exports` is in this worker.
 *
 * `Cloudflare.Exports` is derived from the main module's own exports, and the only way
 * to tell the type system which module that is, is to declare it — `wrangler types`
 * generates exactly this. Without it `ctx.exports.PletivoContent` is unknown, and the
 * loopback the render isolate reads collections through cannot be spelled.
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
