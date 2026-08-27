/**
 * Normalization applied to rendered output before it is compared against a
 * committed snapshot.
 *
 * The rule for adding anything here: a normalization is only allowed when the
 * thing it erases is *not* a rendering decision — i.e. two correct runtimes are
 * free to disagree about it. Every rule below carries the justification that
 * earned it. Over-normalizing turns the harness into a no-op, so when in doubt,
 * leave it raw and let the snapshot churn.
 *
 * Hash-like values are replaced with *ordinal* placeholders rather than being
 * erased: the first distinct hash becomes `[hash:1]`, the second `[hash:2]`,
 * and the mapping is shared across every file of a case. That keeps the
 * cross-reference checkable — if a page stops pointing at the asset the build
 * actually emitted, the ordinals diverge and the snapshot fails.
 *
 * Every rule here applies to every case. A rule that one project needs and the
 * others don't is a claim that its output has a degree of freedom theirs lack,
 * which is nearly always a bug wearing a disguise: the two that used to be
 * here — sorting hoisted `<style>` chunks and sorting `<url>` blocks in
 * sitemap.xml — were both hiding nondeterministic emission, and both are gone
 * now that the emission itself is ordered.
 */

export interface NormalizeContext {
  /** Absolute path to the repo checkout. */
  repoRoot: string;
  /** Absolute path to the scratch directory the adapter rendered into. */
  workRoot: string;
}

/**
 * Content-hashed asset filenames: `style.ff974d06.css`, `test.04870961.png`.
 * The hash is a content hash whose algorithm is an implementation detail — a
 * second runtime may hash the same bytes differently and still be correct.
 * Extension list is explicit so that arbitrary `foo.deadbeef.bar` text in page
 * content is not swept up.
 */
const HASHED_ASSET_RE =
  /\.([0-9a-f]{8})\.(css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf)\b/gi;

/**
 * Hoisted `<script>` bundles: `_astro/hoisted-4f04e0f9f360a49d.js`. The 16-hex
 * id is `Bun.hash()` over the bundled source, so it moves with the bundler
 * version and with minifier output — neither is a rendering difference.
 */
const HOISTED_BUNDLE_RE = /hoisted-([0-9a-f]{16})\.js/g;

/**
 * Astro scope classes: `astro-jn3ixs4m`. Produced by `@astrojs/compiler` from
 * the component's path, so it changes when a compiler version bumps or when the
 * package split moves a file — neither changes what the page renders. The
 * ordinal placeholder still ties the class on the element to the selector in
 * the stylesheet, which is the part that must not drift.
 */
const ASTRO_SCOPE_RE = /astro-([a-z0-9]{8})\b/g;

/**
 * Build a normalizer whose ordinal placeholders are shared across every file of
 * one case. Call it once per case, then for each file in a deterministic order.
 */
export function createNormalizer(ctx: NormalizeContext): (file: string, raw: string) => string {
  const ordinals = new Map<string, string>();

  const ordinal = (kind: string, value: string): string => {
    const key = `${kind}:${value}`;
    let placeholder = ordinals.get(key);
    if (!placeholder) {
      // Count only same-kind entries so hashes and scopes number independently.
      const n = [...ordinals.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
      placeholder = `[${kind}:${n}]`;
      ordinals.set(key, placeholder);
    }
    return placeholder;
  };

  return (file: string, raw: string): string => {
    let text = raw;

    // Line endings are a checkout/platform artifact, never a render decision.
    text = text.replace(/\r\n/g, "\n");

    // Absolute paths identify the machine, not the output. Longest first so a
    // work dir nested inside the checkout is replaced before the repo root.
    for (const [abs, token] of [
      [ctx.workRoot, "<WORK>"],
      [ctx.repoRoot, "<REPO>"],
    ] as const) {
      if (abs) text = text.split(abs).join(token);
    }

    text = text.replace(HASHED_ASSET_RE, (_m, hash: string, ext: string) => `.${ordinal("hash", hash.toLowerCase())}.${ext}`);
    text = text.replace(HOISTED_BUNDLE_RE, (_m, hash: string) => `hoisted-${ordinal("bundle", hash)}.js`);
    text = text.replace(ASTRO_SCOPE_RE, (_m, scope: string) => `astro-${ordinal("scope", scope)}`);

    return text;
  };
}
