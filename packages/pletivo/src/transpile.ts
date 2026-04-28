/**
 * Strip TypeScript syntax from a string of source code, leaving valid JS.
 *
 * Used at the boundary between code that may contain TS (Astro `<script>`
 * blocks, integration `injectScript()` payloads) and contexts that emit
 * the source verbatim into the browser as inline `<script>` text.
 */

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

export function stripTypes(source: string): string {
  return tsTranspiler.transformSync(source);
}
