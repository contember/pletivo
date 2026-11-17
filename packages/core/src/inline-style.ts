/**
 * `</style` (any case) would end an inline `<style>` element early. Printed as `<\/style`, as esbuild does:
 * unchanged in strings, comments and `url()`; a custom property's raw value keeps the backslash.
 */
export function escapeStyleEnd(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}
