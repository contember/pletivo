/**
 * Compare an Astro build with a pletivo build of the same project.
 *
 * A *route* is every emitted file that is not a bundled asset: pages, endpoint
 * output (rss.xml, sitemap) and files copied from `public/`. Bundled assets
 * carry content hashes whose algorithm is an implementation detail, so they are
 * compared only through the URLs pages reference them by; their contents are not
 * compared.
 *
 * HTML is normalised before the comparison. Each rule erases something two
 * correct builds are free to disagree on; anything else is a difference.
 */

import fs from "node:fs";
import path from "node:path";

export interface Comparison {
  routes: {
    astro: string[];
    astroPages: string[];
    common: string[];
    /** Emitted by Astro, not by pletivo. */
    missing: string[];
    /** Emitted by pletivo, not by Astro. */
    extra: string[];
  };
  /** Pages (HTML routes) whose normalised HTML is equal. */
  matchingPages: string[];
  /** Per differing route, the first differing line pair. */
  diffs: { route: string; astro: string; pletivo: string }[];
  /** Same route list and every route equal. */
  match: boolean;
  summary: string;
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return out;
}

/** Astro writes every bundled asset under `_astro/`. */
function isAstroBundle(file: string): boolean {
  return file.startsWith("_astro/");
}

/**
 * pletivo writes images and scripts under `_astro/`, islands under `_islands/`
 * and stylesheets as `assets/<name>.<hash>.css`. A hashed `public/` file stays a
 * route, so it shows up as a difference.
 */
function isPletivoBundle(file: string): boolean {
  return file.startsWith("_astro/") || file.startsWith("_islands/") || /^assets\/[\w-]+\.[0-9a-f]{8}\.css$/.test(file);
}

const TEXT_ROUTE = /\.(html?|xml|txt|json|svg|webmanifest|css|js)$/i;

/** Rewrites a stylesheet into one canonical spelling. */
export type CssCanonicalizer = (css: string) => Promise<string>;

export function createHtmlNormalizer(canonicalCss: CssCanonicalizer): (html: string) => Promise<string> {
  const ordinals = new Map<string, string>();
  const ordinal = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    let placeholder = ordinals.get(key);
    if (!placeholder) {
      const n = [...ordinals.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
      placeholder = `${kind}${n}`;
      ordinals.set(key, placeholder);
    }
    return placeholder;
  };

  return async (html) => {
    let text = html.replace(/\r\n/g, "\n");
    // Names the tool that built the page.
    text = text.replace(/(<meta name="generator" content=")[^"]*"/g, '$1[generator]"');
    // Bundled asset URLs: the directory and hash are bundler output, and so is the
    // name of a CSS or JS chunk. An image or font keeps its name.
    text = text.replace(BUNDLED_ASSET_URL, (_m, name: string, ext: string) =>
      /^(css|m?js)$/.test(ext) ? `/[bundle].${ext}` : `/[asset]/${name}.${ext}`);
    // Scope ids hash the component path and the compiler version; ordinals keep
    // the element ↔ selector link checkable.
    text = text.replace(/data-astro-cid-([a-z0-9]{8})/g, (_m, id: string) => `data-astro-cid-${ordinal("cid", id)}`);
    text = text.replace(/\bastro-([a-z0-9]{8})\b/g, (_m, id: string) => `astro-${ordinal("scope", id)}`);
    // Minifiers spell equal CSS differently (`0.25em` / `.25em`, `white` / `#fff`):
    // both sides go through the same one.
    text = await replaceAsync(text, /(<style[^>]*>)([\s\S]*?)(<\/style>)/g, async (open, css, close) => `${open}${await canonicalCss(css)}${close}`);
    text = collapseWhitespace(text);
    return text;
  };
}

/**
 * `/_astro/name.Dm8K3lV8.svg` and `/_astro/name.Dm8K3lV8_Z1abc.webp` (Astro, the second
 * a processed image), `/_astro/name.d26c3520.svg` and `/assets/styles.1b689b39.css` (pletivo).
 */
const BUNDLED_ASSET_URL =
  /\/(?:_astro|assets)\/(?:[\w-]+\/)*([\w.-]+?)\.[\w-]{8}(?:_[\w-]+)?\.(css|js|mjs|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|otf)\b/g;

/** Elements whose content is kept byte for byte: whitespace there renders or runs. */
const RAW_TEXT = /(<(pre|textarea|script)\b[^>]*>[\s\S]*?<\/\2\s*>)/gi;

/** Tags whitespace next to does not render: block-level and non-rendered elements. */
const BLOCK_TAG =
  /\s*(<\/?(?:html|head|body|meta|link|title|style|base|noscript|template|div|p|section|main|article|aside|header|footer|nav|ul|ol|li|dl|dt|dd|h[1-6]|table|thead|tbody|tfoot|tr|td|th|caption|form|fieldset|legend|hr|br|figure|figcaption|blockquote|address|details|summary|dialog|picture|source|astro-island|astro-slot|pletivo-island)\b[^>]*>|<!--[\s\S]*?-->|<!doctype[^>]*>)\s*/gi;

/**
 * Whitespace runs collapse to one space, and disappear next to a block-level tag,
 * as a browser renders them. `<pre>`, `<textarea>` and `<script>` keep theirs, and
 * a space between two inline elements stays: it renders.
 */
function collapseWhitespace(html: string): string {
  const parts = html.split(RAW_TEXT);
  return parts
    .map((part, i) => {
      // `split` with two capture groups yields [text, raw, tagName, text, …].
      if (i % 3 === 1) return part;
      if (i % 3 === 2) return "";
      let text = part.replace(/\s+/g, " ").replace(BLOCK_TAG, "$1");
      // A raw-text element is block-level or not rendered: no space next to it renders either.
      if (i > 0) text = text.trimStart();
      if (i < parts.length - 1) text = text.trimEnd();
      return text;
    })
    .join("")
    .trim();
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replace: (...groups: string[]) => Promise<string>,
): Promise<string> {
  const parts: Promise<string>[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(Promise.resolve(text.slice(last, match.index)));
    parts.push(replace(...match.slice(1)));
    last = match.index + match[0].length;
  }
  parts.push(Promise.resolve(text.slice(last)));
  return (await Promise.all(parts)).join("");
}

/** Split normalised HTML at tag boundaries so a diff points at an element. */
function lines(text: string): string[] {
  return text.replace(/> ?</g, (m) => `${m.slice(0, -1)}\n<`).split("\n");
}

/** The first differing line pair, each cut to start a little before the first differing character. */
function firstDifference(a: string, b: string): { astro: string; pletivo: string } {
  const la = lines(a);
  const lb = lines(b);
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const x = la[i] ?? "<end>";
    const y = lb[i] ?? "<end>";
    if (x === y) continue;
    let at = 0;
    while (at < x.length && x[at] === y[at]) at++;
    const from = Math.max(0, at - 30);
    const cut = (line: string) => `${from > 0 ? "…" : ""}${line.slice(from, from + 120)}`;
    return { astro: cut(x), pletivo: cut(y) };
  }
  return { astro: "", pletivo: "" };
}

/**
 * `dumpDir` receives the normalised text of every differing route, one line per
 * element, under `astro/` and `pletivo/`, for `diff -r`.
 */
export async function compareOutputs(
  astroDir: string,
  pletivoDir: string,
  canonicalCss: CssCanonicalizer,
  dumpDir?: string,
): Promise<Comparison> {
  if (dumpDir) fs.rmSync(dumpDir, { recursive: true, force: true });
  const astroRoutes = walk(astroDir).filter((f) => !isAstroBundle(f)).sort();
  const pletivoRoutes = walk(pletivoDir).filter((f) => !isPletivoBundle(f)).sort();
  const pletivoSet = new Set(pletivoRoutes);
  const astroSet = new Set(astroRoutes);
  const common = astroRoutes.filter((r) => pletivoSet.has(r));
  const missing = astroRoutes.filter((r) => !pletivoSet.has(r));
  const extra = pletivoRoutes.filter((r) => !astroSet.has(r));
  const astroPages = astroRoutes.filter((r) => r.endsWith(".html"));

  const normalizeAstro = createHtmlNormalizer(canonicalCss);
  const normalizePletivo = createHtmlNormalizer(canonicalCss);
  const matchingPages: string[] = [];
  const diffs: Comparison["diffs"] = [];
  for (const route of common) {
    const a = fs.readFileSync(path.join(astroDir, route));
    const b = fs.readFileSync(path.join(pletivoDir, route));
    if (!TEXT_ROUTE.test(route)) {
      if (!a.equals(b)) diffs.push({ route, astro: `${a.length} bytes`, pletivo: `${b.length} bytes` });
      continue;
    }
    const na = await normalizeAstro(a.toString("utf8"));
    const nb = await normalizePletivo(b.toString("utf8"));
    if (na === nb) {
      if (route.endsWith(".html")) matchingPages.push(route);
    } else {
      diffs.push({ route, ...firstDifference(na, nb) });
      if (dumpDir) {
        for (const [side, text] of [["astro", na], ["pletivo", nb]] as const) {
          const out = path.join(dumpDir, side, route);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, `${lines(text).join("\n")}\n`);
        }
      }
    }
  }

  const match = missing.length === 0 && extra.length === 0 && diffs.length === 0;
  const parts: string[] = [];
  if (missing.length) parts.push(`missing ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3})` : ""}`);
  if (extra.length) parts.push(`extra ${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ` (+${extra.length - 3})` : ""}`);
  if (diffs.length) {
    const d = diffs[0];
    parts.push(`${d.route}: \`${d.astro.slice(0, 80)}\` vs \`${d.pletivo.slice(0, 80)}\``);
  }
  return {
    routes: { astro: astroRoutes, astroPages, common, missing, extra },
    matchingPages,
    diffs,
    match,
    summary: parts.join("; "),
  };
}
