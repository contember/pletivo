/** `{ "type": "Text" }` in wrangler.jsonc turns a `.css` import into its text. */
declare module "*.css" {
  const content: string;
  export default content;
}
