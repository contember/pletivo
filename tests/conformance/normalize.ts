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
 */

export interface CaseNormalizeOptions {
  /**
   * Canonicalize the order of CSS chunks inside hoisted `<style>` elements.
   *
   * Opt-in per case, because it is a workaround for a real bug rather than a
   * legitimate degree of freedom: the astro CSS pipeline emits chunks in
   * `scopedCssMap` / `globalCssMap` insertion order, which is the order Bun's
   * `onLoad` hook happened to compile each `.astro` component. Page renders run
   * concurrently, so that order flips between builds (measured: ~1 run in 10 on
   * `tests/fixture-astro-styles`). Until emission order is made deterministic
   * there is nothing stable to lock down, so sort it.
   *
   * Blind spot this creates: a change in CSS *cascade order* is invisible for
   * cases that enable it. Everything else — a rule appearing, disappearing,
   * changing, or leaking onto the wrong page — is still caught. Remove the flag
   * from a case as soon as its emission order is deterministic.
   */
  sortStyleBlocks?: boolean;
}

export interface NormalizeContext {
  /** Absolute path to the repo checkout. */
  repoRoot: string;
  /** Absolute path to the scratch directory the adapter rendered into. */
  workRoot: string;
  options?: CaseNormalizeOptions;
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

    // `<url>` order in sitemap.xml comes from `fs.readdir` over dist/, so it is
    // filesystem-dependent — the same build lands in a different order on tmpfs
    // than on ext4. Sorting keeps "which pages are in the sitemap" locked while
    // dropping the part no consumer relies on.
    if (file === "sitemap.xml") text = sortSitemapUrls(text);

    if (ctx.options?.sortStyleBlocks) text = sortStyleBlocks(text);

    text = text.replace(HASHED_ASSET_RE, (_m, hash: string, ext: string) => `.${ordinal("hash", hash.toLowerCase())}.${ext}`);
    text = text.replace(HOISTED_BUNDLE_RE, (_m, hash: string) => `hoisted-${ordinal("bundle", hash)}.js`);
    text = text.replace(ASTRO_SCOPE_RE, (_m, scope: string) => `astro-${ordinal("scope", scope)}`);

    return text;
  };
}

function sortSitemapUrls(xml: string): string {
  const blocks = xml.match(/ {2}<url>[\s\S]*?<\/url>/g);
  if (!blocks || blocks.length < 2) return xml;
  const sorted = [...blocks].sort();
  let i = 0;
  return xml.replace(/ {2}<url>[\s\S]*?<\/url>/g, () => sorted[i++]!);
}

/**
 * Sort the chunks inside every `<style>` element. Chunks are split at newlines
 * that sit at brace depth 0, so a rule spanning several lines stays intact.
 * CSS strings/comments are not tracked — the corpus has none inside a `<style>`
 * block, and a false split would only reorder, never corrupt, since the same
 * transform runs on both sides of the comparison.
 */
function sortStyleBlocks(html: string): string {
  return html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (_m, attrs: string, css: string) => {
    const chunks: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "\n" && depth === 0) {
        chunks.push(css.slice(start, i));
        start = i + 1;
      }
    }
    chunks.push(css.slice(start));
    if (chunks.length < 2) return `<style${attrs}>${css}</style>`;
    return `<style${attrs}>${chunks.sort().join("\n")}</style>`;
  });
}
