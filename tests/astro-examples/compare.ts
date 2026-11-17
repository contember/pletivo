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
 * and stylesheets as `assets/styles[.<group>].<hash>.css`. A hashed `public/` file stays a
 * route, so it shows up as a difference.
 */
function isPletivoBundle(file: string): boolean {
  return file.startsWith("_astro/") || file.startsWith("_islands/") || /^assets\/styles\.(?:[a-z0-9-]+\.)?[0-9a-f]{8}\.css$/.test(file);
}

/** Compared as text, line by line; only HTML is normalised. */
const TEXT_ROUTE = /\.(html?|xml|txt|json|svg|webmanifest|css|js)$/i;
const HTML_ROUTE = /\.html?$/i;

/** Rewrites a stylesheet into one canonical spelling. */
export type CssCanonicalizer = (css: string) => Promise<string>;

/** Whether a hashed URL under `dir` with extension `ext` is one of this side's bundled assets. */
export type BundleRule = (dir: string, ext: string) => boolean;

export const astroBundle: BundleRule = (dir) => dir === "_astro";
export const pletivoBundle: BundleRule = (dir, ext) => dir === "_astro" || dir === "_islands" || (dir === "assets" && ext === "css");

/**
 * `/_astro/name.Dm8K3lV8.svg` and `/_astro/name.Dm8K3lV8_Z1abc.webp` (Astro, the second
 * a processed image), `/_astro/name.d26c3520.svg` and `/assets/styles.1b689b39.css` (pletivo).
 */
const HASHED_URL =
  /\/(_astro|_islands|assets)\/(?:[\w-]+\/)*([\w.-]+?)\.[\w-]{8}(?:_[\w-]+)?\.(css|js|mjs|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|otf)\b/g;

export function createHtmlNormalizer(canonicalCss: CssCanonicalizer, isBundle: BundleRule): (html: string) => Promise<string> {
  // Per side and across all its pages: the n-th distinct value of a kind becomes n.
  const ordinals = new Map<string, number>();
  const counts = new Map<string, number>();
  const ordinal = (kind: string, value: string): number => {
    const key = `${kind}\0${value}`;
    let n = ordinals.get(key);
    if (n === undefined) {
      n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      ordinals.set(key, n);
    }
    return n;
  };

  return async (html) => {
    let text = html.replace(/\r\n/g, "\n");
    // Names the tool that built the page.
    text = text.replace(/(<meta name="generator" content=")[^"]*"/g, '$1[generator]"');
    // Bundled asset URLs: the directory and hash are bundler output, and so is the
    // name of a CSS or JS chunk. An image or font keeps its name. Ordinals keep
    // distinct files distinct (srcset widths, two chunks).
    text = text.replace(HASHED_URL, (url: string, dir: string, name: string, ext: string) => {
      if (!isBundle(dir, ext)) return url;
      return /^(css|m?js)$/.test(ext)
        ? `/[bundle]/${ordinal(ext, url)}.${ext}`
        : `/[asset]/${name}~${ordinal(`${name}.${ext}`, url)}.${ext}`;
    });
    // Scope ids hash the component path and the compiler version; ordinals keep
    // the element ↔ selector link checkable. `data-astro-template` is not one.
    text = text.replace(/data-astro-cid-([a-z0-9]{8})/g, (_m, id: string) => `data-astro-cid-c${ordinal("cid", id)}`);
    text = text.replace(/(?<![\w-])astro-([a-z0-9]{8})(?![\w-])/g, (_m, id: string) => `astro-s${ordinal("scope", id)}`);
    // Minifiers spell equal CSS differently (`0.25em` / `.25em`, `white` / `#fff`):
    // both sides go through the same one.
    text = await replaceAsync(text, /(<style[^>]*>)([\s\S]*?)(<\/style>)/g, async (open, css, close) => `${open}${await canonicalCss(css)}${close}`);
    text = normalizeVoidElements(text);
    text = normalizeAttributeSpelling(text);
    text = collapseWhitespace(text);
    return text;
  };
}

/** The HTML spec's void elements: a trailing `/` on their start tag is ignored by the parser. */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Raw-text elements the whitespace step leaves as written; so does the void-element step. */
const RAW_TEXT_ELEMENTS = new Set(["pre", "textarea", "script", "style"]);
/** Elements whose content is text, not markup: what looks like a tag there is not one. */
const TEXT_CONTENT_ELEMENTS = new Set(["textarea", "script", "style"]);
/** Foreign content: a `/` there self-closes any element, so it is kept. */
const FOREIGN_ELEMENTS = new Set(["svg", "math"]);

interface Attribute {
  /** Where the name ends. */
  nameEnd: number;
  /** The value's span, inside its quotes; absent for a bare attribute. */
  value?: { start: number; end: number; quoted: boolean };
}

interface StartTag {
  name: string;
  /** Where the tag's `<` is. */
  start: number;
  /** Where the tag's `>` is. */
  end: number;
  /** Where the self-closing `/` and the whitespace before it start, or -1. */
  selfClosingAt: number;
  attributes: Attribute[];
  /** Inside `<svg>` or `<math>`, or one of them. */
  foreign: boolean;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** Read a start tag whose name starts at `at`, as the HTML tokenizer does: quoted values may hold `/` and `>`. */
function readStartTag(html: string, at: number): Omit<StartTag, "foreign"> | null {
  let i = at;
  while (i < html.length && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(at, i).toLowerCase();
  let selfClosingAt = -1;
  const attributes: Attribute[] = [];
  while (i < html.length) {
    const c = html[i];
    if (c === ">") return { name, start: at - 1, end: i, selfClosingAt, attributes };
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "/") {
      let start = i;
      while (start > at && isSpace(html[start - 1])) start--;
      selfClosingAt = html[i + 1] === ">" ? start : -1;
      i++;
      continue;
    }
    selfClosingAt = -1;
    // An attribute name, then an optional `=` and value.
    while (i < html.length && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const attribute: Attribute = { nameEnd: i };
    attributes.push(attribute);
    let j = i;
    while (isSpace(html[j])) j++;
    if (html[j] !== "=") continue;
    j++;
    while (isSpace(html[j])) j++;
    const quote = html[j];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      if (close === -1) return null;
      attribute.value = { start: j + 1, end: close, quoted: true };
      i = close + 1;
    } else {
      // An unquoted value ends at whitespace or `>`: a `/` in it is part of the value.
      i = j;
      while (i < html.length && !isSpace(html[i]) && html[i] !== ">") i++;
      attribute.value = { start: j, end: i, quoted: false };
    }
  }
  return null;
}

/**
 * Replace start tags, `<` to `>`, by what `rewrite` returns for them (null keeps one as written).
 * Comments, the doctype and end tags are kept; so is the content of `skipContent` elements
 * outside `<svg>` and `<math>`.
 */
function rewriteStartTags(html: string, skipContent: ReadonlySet<string>, rewrite: (tag: StartTag) => string | null): string {
  let out = "";
  let copied = 0;
  let foreignDepth = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const close = html.indexOf(">", lt);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const name = /^<\/([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 64))?.[1]?.toLowerCase();
      if (name && FOREIGN_ELEMENTS.has(name) && foreignDepth > 0) foreignDepth--;
      const close = html.indexOf(">", lt);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(html[lt + 1] ?? "")) {
      i = lt + 1;
      continue;
    }
    const read = readStartTag(html, lt + 1);
    if (!read) break;
    i = read.end + 1;
    const opensForeign = FOREIGN_ELEMENTS.has(read.name) && read.selfClosingAt === -1;
    const tag: StartTag = { ...read, foreign: foreignDepth > 0 || FOREIGN_ELEMENTS.has(read.name) };
    const replacement = rewrite(tag);
    if (replacement !== null) {
      out += html.slice(copied, tag.start) + replacement;
      copied = tag.end + 1;
    }
    if (opensForeign) {
      foreignDepth++;
      continue;
    }
    if (foreignDepth === 0 && skipContent.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, "i").exec(html.slice(i));
      i = close ? i + close.index + close[0].length : html.length;
    }
  }
  return out + html.slice(copied);
}

/**
 * Drop the trailing `/` of a void element's start tag (`<meta charset="utf-8"/>` →
 * `<meta charset="utf-8">`): the HTML parser ignores it, so the DOM is the same. Inside
 * `<svg>` and `<math>`, the `/` self-closes, so it is kept there; raw-text elements are
 * left as written, as the whitespace step leaves them.
 */
export function normalizeVoidElements(html: string): string {
  return rewriteStartTags(html, RAW_TEXT_ELEMENTS, (tag) =>
    !tag.foreign && tag.selfClosingAt !== -1 && VOID_ELEMENTS.has(tag.name) ? html.slice(tag.start, tag.selfClosingAt) + ">" : null,
  );
}

/**
 * Spell attribute values one way where the parser reads them alike, so the DOM is the same:
 * an empty value as a bare attribute (`data-seen=""` → `data-seen`), and a quote character
 * reference as `&quot;` (`&#34;`). Only start tags; the content of `<textarea>`, `<script>`
 * and `<style>` is text, and is left as written.
 */
export function normalizeAttributeSpelling(html: string): string {
  return rewriteStartTags(html, TEXT_CONTENT_ELEMENTS, (tag) => {
    let out = "";
    let copied = tag.start;
    for (const { nameEnd, value } of tag.attributes) {
      if (!value) continue;
      if (value.quoted && value.start === value.end) {
        out += html.slice(copied, nameEnd);
        copied = value.end + 1;
      } else if (html.slice(value.start, value.end).includes("&#34;")) {
        out += html.slice(copied, value.start) + html.slice(value.start, value.end).replaceAll("&#34;", "&quot;");
        copied = value.end;
      }
    }
    return copied === tag.start ? null : out + html.slice(copied, tag.end + 1);
  });
}

/** Elements whose content is kept byte for byte: whitespace there renders, runs or is CSS. */
const RAW_TEXT = /(<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\2\s*>)/gi;

/** Raw-text elements next to which whitespace does not render; `<textarea>` is inline. */
const RAW_BLOCK = /^(pre|script|style)$/i;

/** Tags whitespace next to does not render: block-level and non-rendered elements. */
const BLOCK_TAG =
  /\s*(<\/?(?:html|head|body|meta|link|title|base|noscript|template|div|p|section|main|article|aside|header|footer|nav|ul|ol|li|dl|dt|dd|h[1-6]|table|thead|tbody|tfoot|tr|td|th|caption|form|fieldset|legend|hr|br|figure|figcaption|blockquote|address|details|summary|dialog)\b[^>]*>|<!--[\s\S]*?-->|<!doctype[^>]*>)\s*/gi;

/**
 * Whitespace runs collapse to one space, and disappear next to a block-level tag,
 * as a browser renders them. `<pre>`, `<textarea>`, `<script>` and `<style>` keep
 * theirs, and a space between two inline elements stays: it renders. Islands
 * (`display: contents`) and `<picture>` count as inline.
 */
function collapseWhitespace(html: string): string {
  const parts = html.split(RAW_TEXT);
  return parts
    .map((part, i) => {
      // `split` with two capture groups yields [text, raw, tagName, text, …].
      if (i % 3 === 1) return part;
      if (i % 3 === 2) return "";
      let text = part.replace(/\s+/g, " ").replace(BLOCK_TAG, "$1");
      if (i > 0 && RAW_BLOCK.test(parts[i - 1])) text = text.trimStart();
      if (i < parts.length - 1 && RAW_BLOCK.test(parts[i + 2])) text = text.trimEnd();
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
function firstDifference(a: string, b: string, html: boolean): { astro: string; pletivo: string } {
  const la = html ? lines(a) : a.split("\n");
  const lb = html ? lines(b) : b.split("\n");
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

  const normalizeAstro = createHtmlNormalizer(canonicalCss, astroBundle);
  const normalizePletivo = createHtmlNormalizer(canonicalCss, pletivoBundle);
  const matchingPages: string[] = [];
  const diffs: Comparison["diffs"] = [];
  for (const route of common) {
    const a = fs.readFileSync(path.join(astroDir, route));
    const b = fs.readFileSync(path.join(pletivoDir, route));
    if (!TEXT_ROUTE.test(route)) {
      if (!a.equals(b)) diffs.push({ route, astro: `${a.length} bytes`, pletivo: `${b.length} bytes` });
      continue;
    }
    const html = HTML_ROUTE.test(route);
    const na = html ? await normalizeAstro(a.toString("utf8")) : a.toString("utf8").replace(/\r\n/g, "\n");
    const nb = html ? await normalizePletivo(b.toString("utf8")) : b.toString("utf8").replace(/\r\n/g, "\n");
    if (na === nb) {
      if (route.endsWith(".html")) matchingPages.push(route);
    } else {
      diffs.push({ route, ...firstDifference(na, nb, html) });
      if (dumpDir) {
        for (const [side, text] of [["astro", na], ["pletivo", nb]] as const) {
          const out = path.join(dumpDir, side, route);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, html ? `${lines(text).join("\n")}\n` : text);
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
