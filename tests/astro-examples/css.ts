/**
 * A page's CSS in one canonical spelling, so two builds are compared on what the
 * cascade does with it, not on how a bundler wrote it.
 *
 * The input is every stylesheet a page loads, inline or linked, in document order,
 * each already minified by the esbuild Astro's Vite uses. The output is one line per
 * top-level rule. Each step below erases a difference that cannot change which value
 * an element gets:
 *
 * 1. Declarations in a block may change places only with a neighbour of another
 *    property family (below). So `a:1;b:2` equals `b:2;a:1`, while
 *    `margin:0;margin-top:1px` stays apart from its reverse.
 * 2. Rules and at-rule blocks may change places only with a neighbour that sets no
 *    property of a family they share. `@layer` and statement at-rules (`@import`)
 *    stay in place. The canonical order is the smallest-text-first order under that
 *    constraint, which is the same for every reordering of that kind (the
 *    lexicographic normal form of a trace).
 * 3. Values: whitespace next to `,` and after `)` (before anything but an operator)
 *    is dropped; a custom property's value is trimmed; a quoted `format()` keyword in
 *    `src` is unquoted; Bun's `system-ui` fallback stack after `system-ui` is dropped.
 *
 * A rule present on one side only is never erased, wherever it sits: the result is
 * the full multiset of rules, only reordered.
 */

/** A declaration, or a block: `prelude{…}`. */
type CssNode =
  | { kind: "declaration"; property: string; value: string }
  | { kind: "block"; prelude: string; children: CssNode[] };

/** Parse minified CSS: blocks nest, declarations end at `;` or `}`; strings and `(…)` are opaque. */
export function parseCss(css: string): CssNode[] {
  let at = 0;
  const parseList = (): CssNode[] => {
    const nodes: CssNode[] = [];
    while (at < css.length) {
      while (at < css.length && (css[at] === ";" || /\s/.test(css[at]!))) at++;
      if (at >= css.length) break;
      if (css[at] === "}") {
        at++;
        return nodes;
      }
      const start = at;
      const stop = scanTo(css, at, "{;}");
      const text = css.slice(start, stop).trim();
      at = stop;
      if (css[at] === "{") {
        at++;
        nodes.push({ kind: "block", prelude: text, children: parseList() });
        continue;
      }
      if (css[at] === ";") at++;
      const colon = scanTo(text, 0, ":");
      nodes.push(
        colon < text.length
          ? { kind: "declaration", property: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() }
          : { kind: "declaration", property: text, value: "" },
      );
    }
    return nodes;
  };
  return parseList();
}

/** The index of the first of `stops` at nesting depth 0 outside strings, or the end. */
function scanTo(text: string, from: number, stops: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i);
    } else if (c === "\\") {
      i++;
    } else if (c === "(" || c === "[") {
      depth++;
    } else if ((c === ")" || c === "]") && depth > 0) {
      depth--;
    } else if (depth === 0 && stops.includes(c)) {
      return i;
    }
  }
  return text.length;
}

function skipString(text: string, at: number): number {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/**
 * Families of properties that can override each other: a shorthand and its longhands,
 * aliases, logical and physical sides. Conservative: two properties share a family when
 * their first name segment (vendor prefix dropped) does, plus the links below. `all`
 * conflicts with everything.
 */
const EXTRA_FAMILIES: Record<string, string[]> = {
  place: ["align", "justify"],
  align: ["place"],
  justify: ["place"],
  inset: ["top", "right", "bottom", "left"],
  top: ["inset"],
  right: ["inset"],
  bottom: ["inset"],
  left: ["inset"],
  gap: ["row", "column", "grid"],
  row: ["gap"],
  column: ["gap", "columns"],
  columns: ["column"],
  grid: ["gap"],
  inline: ["width", "height"],
  block: ["width", "height"],
  width: ["inline", "block"],
  height: ["inline", "block"],
  font: ["line"],
  line: ["font"],
  white: ["text"],
  text: ["white"],
  word: ["overflow"],
  overflow: ["word"],
  page: ["break"],
  break: ["page"],
};

const ALL = "*";

export function propertyFamilies(property: string): string[] {
  const name = property.toLowerCase();
  if (name.startsWith("--")) return [name];
  if (name === "all") return [ALL];
  const unprefixed = name.replace(/^-(webkit|moz|ms|o)-/, "");
  const first = unprefixed.split("-")[0]!;
  return [first, ...(EXTRA_FAMILIES[first] ?? [])];
}

/** Bun's expansion of `system-ui`, which keeps `system-ui` first. */
const BUN_SYSTEM_UI_FALLBACKS = ",-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Cantarell,Helvetica Neue";

export function normalizeValue(property: string, value: string): string {
  const name = property.toLowerCase();
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '"' || c === "'") {
      const end = skipString(value, i);
      out += value.slice(i, end + 1);
      i = end;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j + 1 < value.length && /\s/.test(value[j + 1]!)) j++;
      const next = value[j + 1];
      const prev = out[out.length - 1];
      const dropped = next === "," || prev === "," || (prev === ")" && next !== undefined && !"+-*/".includes(next));
      if (!dropped) out += " ";
      i = j;
      continue;
    }
    out += c;
  }
  if (name.startsWith("--")) out = out.trim();
  if (name === "src") out = out.replace(/format\((["'])([\w-]+)\1\)/g, "format($2)");
  if (name === "font-family" && out.startsWith(`system-ui${BUN_SYSTEM_UI_FALLBACKS}`)) {
    out = `system-ui${out.slice(`system-ui${BUN_SYSTEM_UI_FALLBACKS}`.length)}`;
  }
  return out;
}

interface Canonical {
  text: string;
  families: Set<string>;
}

function canonicalNode(node: CssNode): Canonical {
  if (node.kind === "declaration") {
    // A statement at-rule (`@import`, `@layer a,b`) orders the cascade itself.
    const families = node.property.startsWith("@") ? [ALL] : propertyFamilies(node.property);
    return { text: `${node.property.toLowerCase()}:${normalizeValue(node.property, node.value)}`, families: new Set(families) };
  }
  const children = node.children.map(canonicalNode);
  const families = new Set<string>(node.prelude.startsWith("@layer") ? [ALL] : []);
  for (const child of children) for (const f of child.families) families.add(f);
  return { text: `${node.prelude}{${canonicalOrder(children).join(";")}}`, families };
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  if (a.has(ALL) || b.has(ALL)) return true;
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Rules 1 and 2: the smallest-text-first order that keeps every pair of conflicting
 * entries (declarations of one block, or rules of one list) in their relative order.
 * Two lists that differ only by swaps of non-conflicting neighbours get the same order.
 */
function canonicalOrder(nodes: Canonical[]): string[] {
  const emitted = new Array<boolean>(nodes.length).fill(false);
  const out: string[] = [];
  for (let n = 0; n < nodes.length; n++) {
    let pick = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (emitted[i]) continue;
      let ready = true;
      for (let j = 0; j < i; j++) {
        if (!emitted[j] && intersects(nodes[j]!.families, nodes[i]!.families)) {
          ready = false;
          break;
        }
      }
      if (ready && (pick === -1 || nodes[i]!.text < nodes[pick]!.text)) pick = i;
    }
    emitted[pick] = true;
    out.push(nodes[pick]!.text);
  }
  return out;
}

/** Every rule of the page's stylesheets, one per line, in canonical order. */
export function canonicalPageCss(sheets: string[]): string[] {
  return canonicalOrder(sheets.flatMap((sheet) => parseCss(sheet)).map(canonicalNode));
}
