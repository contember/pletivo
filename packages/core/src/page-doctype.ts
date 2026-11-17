/** A page's own doctype, as Astro finds one: only whitespace and comments may come before it. */
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype html/i;

export interface PageDoctypeOptions {
  /** `resolveCompressHTML`'s value: a boolean in an Astro project, `undefined` in a pletivo-native one. */
  compressHTML: boolean | undefined;
  /** The page module exports a truthy `partial`, which Astro reads as `Boolean(mod.partial)`. */
  partial: boolean;
}

/**
 * What a host puts in front of a rendered page's HTML: a doctype, or "".
 *
 * An Astro project follows Astro: every page but a partial gets `<!DOCTYPE html>` unless it
 * already has a doctype, followed by a newline only when `compressHTML` is off. A
 * pletivo-native project gets `<!DOCTYPE html>\n` only when its HTML starts with `<html`.
 */
export function pageDoctype(html: string, { compressHTML, partial }: PageDoctypeOptions): string {
  if (compressHTML === undefined) return html.trimStart().startsWith("<html") ? "<!DOCTYPE html>\n" : "";
  if (partial || LEADING_DOCTYPE.test(html)) return "";
  return compressHTML ? "<!DOCTYPE html>" : "<!DOCTYPE html>\n";
}
