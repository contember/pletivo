/**
 * `</style` (any case) would end an inline `<style>` element early. Printed as `<\/style`, as esbuild
 * and Astro's default build do: the CSS value is unchanged, since `\/` is `/` in a string and inert in a comment.
 */
export function escapeStyleEnd(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}
