/**
 * Raw-HTML marker used across pletivo's two rendering runtimes
 * (Astro-compiler shim and JSX/TSX runtime).
 *
 * Extends `String` so instances coerce to raw HTML (matching Astro's own
 * `HTMLString`) — user code can call `.test`, `.includes`, `.replace`
 * etc. on values returned from `Astro.slots.render("…")` and string
 * coercion (template literals, `String(x)`) yields the HTML instead of
 * `[object Object]`. `__html` is a getter over `valueOf()` to avoid
 * storing the same string twice; it stays as the canonical marker that
 * interpolation checks (`isHtmlString`) use to skip re-escaping.
 */
export class HtmlString extends String {
  get __html(): string {
    return this.valueOf();
  }
}

// Structural (not `instanceof`) on purpose: content collection loaders
// and other call sites may construct plain `{ __html }` objects that
// must also flow through interpolation without being re-escaped.
export function isHtmlString(x: unknown): x is HtmlString {
  return typeof x === "object" && x !== null && "__html" in x;
}

const EMPTY_HTML = new HtmlString("");

export function createHtml(html: string): HtmlString {
  return html === "" ? EMPTY_HTML : new HtmlString(html);
}
