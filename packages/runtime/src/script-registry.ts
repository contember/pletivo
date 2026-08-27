/**
 * Hoisted-script URL resolution, inverted.
 *
 * `renderScript()` in the shim has to turn a compiler-generated script id
 * (`Foo.astro?astro&type=script&index=0&lang.ts`) into a URL. The id→hash
 * map that answers that lives in the host's `.astro` plugin — so importing
 * it directly would point the render runtime at the build pipeline, and
 * drag `@astrojs/compiler`, `Bun.plugin`, `fs` and `sharp` behind it.
 *
 * The host registers a resolver instead. Unregistered (a bare render with
 * no build pipeline, e.g. a container render or a test) resolves to null,
 * which makes `renderScript()` emit nothing — the previous behaviour for
 * an unknown id.
 */

export type ScriptUrlResolver = (id: string) => string | null;

let resolver: ScriptUrlResolver = () => null;

export function setScriptUrlResolver(fn: ScriptUrlResolver): void {
  resolver = fn;
}

export function resolveScriptUrl(id: string): string | null {
  return resolver(id);
}

/** Test/teardown hook — restores the no-op resolver. */
export function resetScriptUrlResolver(): void {
  resolver = () => null;
}
