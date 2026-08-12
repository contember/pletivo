/**
 * Configured base path for the site (e.g. `/`, `/my-app`).
 *
 * Read from `astroHost.config.base` (Astro mode) or `config.base`
 * (pletivo-native) at dev/build startup via `setBase()`. All URL
 * emission sites and dev route handlers go through `withBase()` /
 * `stripBase()` so the same code works under any mount point.
 *
 * Internal invariant: `base` is either the literal `"/"` or a path
 * with a leading slash and no trailing slash. This shape lets
 * `withBase("/foo")` always produce a valid URL by simple concatenation
 * (`"/" + "/foo"` would be `"//foo"`, hence the special-case for root).
 */

let base = "/";

export function setBase(b: string | undefined): void {
  if (!b || b === "/") {
    base = "/";
    return;
  }
  let normalized = b.startsWith("/") ? b : `/${b}`;
  normalized = normalized.replace(/\/+$/, "");
  base = normalized || "/";
}

export function getBase(): string {
  return base;
}

/**
 * Prefix an absolute pathname with the configured base.
 * Pass paths starting with `/`; under root base they're returned unchanged.
 */
export function withBase(pathname: string): string {
  if (base === "/") return pathname;
  if (!pathname.startsWith("/")) return `${base}/${pathname}`;
  return base + pathname;
}

/**
 * Strip the configured base from an inbound pathname, returning the
 * unprefixed path (always starting with `/`), or `null` if the request
 * doesn't match the base. Under root base, returns `pathname` unchanged.
 */
export function stripBase(pathname: string): string | null {
  if (base === "/") return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(base + "/")) return pathname.slice(base.length);
  return null;
}

/**
 * Replace `__BASE__` placeholders in a template with the configured
 * base prefix (empty under root). Used by the inlined runtime scripts
 * (hydration, HMR client) at emission time. Result is memoized per
 * template + base, so repeated emissions skip the regex scan.
 */
const substituteCache = new Map<string, { base: string; result: string }>();
export function substituteBase(template: string): string {
  const cached = substituteCache.get(template);
  if (cached && cached.base === base) return cached.result;
  const result = template.replace(/__BASE__/g, base === "/" ? "" : base);
  substituteCache.set(template, { base, result });
  return result;
}
