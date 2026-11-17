/**
 * A page's CSS in one canonical spelling, so two builds are compared on what the
 * cascade does with it, not on how a bundler wrote it.
 *
 * The input is every stylesheet a page loads, inline or linked, in document order,
 * each already minified by the esbuild Astro's Vite uses. The output is one line per
 * top-level rule. Each step below erases a difference that cannot change which value
 * an element gets:
 *
 * 1. Two declarations conflict when they could decide the same value: they set a
 *    property of a shared family (below), in the same scope (style rules, or one
 *    `@font-face` / `@keyframes x`), with the same importance, and their selectors can
 *    tie on specificity. A selector this cannot score ties with everything.
 * 2. Declarations in a block, and rules and at-rule blocks in a list, may change places
 *    only with a neighbour they do not conflict with. `@layer` and statement at-rules
 *    (`@import`) stay in place. The canonical order is the smallest-text-first order
 *    under that constraint, the same for every reordering of that kind (the
 *    lexicographic normal form of a trace). So `a:1;b:2` equals `b:2;a:1`, while
 *    `margin:0;margin-top:1px` stays apart from its reverse.
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
 * Families of properties that can override each other. Conservative: two properties share
 * a family when their first name segment (vendor prefix dropped) does, so a shorthand and
 * its longhands always do. A shorthand or alias whose longhands are named otherwise lists
 * their families below, keyed by its name or its first segment. `all` conflicts with
 * everything.
 */
/** By first segment: every property of the group is positional or an alias. */
const GROUP_FAMILIES: Record<string, string[]> = {
  place: ["align", "justify"],
  inset: ["top", "right", "bottom", "left"],
  page: ["break"],
};

/** By name: one shorthand or alias. */
const SHORTHAND_FAMILIES: Record<string, string[]> = {
  font: ["line"],
  gap: ["row", "column"],
  columns: ["column"],
  "inline-size": ["width", "height"],
  "block-size": ["width", "height"],
  "white-space": ["text"],
  "word-wrap": ["overflow"],
};

const ALL = "*";

export function propertyFamilies(property: string): string[] {
  const name = property.toLowerCase();
  if (name.startsWith("--")) return [name];
  if (name === "all") return [ALL];
  const unprefixed = name.replace(/^-(webkit|moz|ms|o)-/, "");
  const first = unprefixed.split("-")[0]!;
  return [...new Set([first, ...(GROUP_FAMILIES[first] ?? []), ...(SHORTHAND_FAMILIES[unprefixed] ?? [])])];
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

/**
 * One declaration as the cascade sees it. Two declarations can decide the same value only
 * if they set a shared property family, in the same scope (style rules, or one
 * `@font-face` / `@keyframes x`), with the same importance and a specificity they can tie on.
 */
interface Atom {
  families: Set<string>;
  scope: string;
  important: boolean;
  /** The selector list's specificities, or null when one could not be scored: it may tie with any. */
  specificity: Set<string> | null;
}

interface Canonical {
  text: string;
  atoms: Atom[];
  /** `@layer` and statement at-rules order the cascade themselves: they keep their place. */
  barrier: boolean;
}

interface Context {
  scope: string;
  specificity: Set<string> | null;
}

const STYLE: Context = { scope: "style", specificity: null };

/** At-rules whose content is style rules applied under a condition. */
const CONDITIONAL = /^@(media|supports|container|document|-moz-document)\b/i;

function canonicalNode(node: CssNode, context: Context): Canonical {
  if (node.kind === "declaration") {
    const text = `${node.property.toLowerCase()}:${normalizeValue(node.property, node.value)}`;
    if (node.property.startsWith("@")) return { text, atoms: [], barrier: true };
    const important = /!\s*important$/i.test(node.value);
    return {
      text,
      atoms: [{ families: new Set(propertyFamilies(node.property)), scope: context.scope, important, specificity: context.specificity }],
      barrier: false,
    };
  }
  let inner: Context;
  if (node.prelude.startsWith("@")) {
    // Conditional groups hold style rules; `@font-face`, `@keyframes x` and the like are their own scope.
    inner = CONDITIONAL.test(node.prelude) ? STYLE : { scope: node.prelude, specificity: new Set(["-"]) };
  } else if (context.scope === "style") {
    // Nested style rules are scored as unknown rather than resolved against their parent.
    inner = { scope: "style", specificity: context === STYLE ? selectorListSpecificity(node.prelude) : null };
  } else {
    inner = context;
  }
  const children = node.children.map((child) => canonicalNode(child, inner));
  return {
    text: `${node.prelude}{${canonicalOrder(children).join(";")}}`,
    atoms: children.flatMap((child) => child.atoms),
    barrier: node.prelude.startsWith("@layer") || children.some((child) => child.barrier),
  };
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.has(ALL) || b.has(ALL)) return a.size > 0 && b.size > 0;
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function atomsConflict(a: Atom, b: Atom): boolean {
  if (a.scope !== b.scope || a.important !== b.important || !intersects(a.families, b.families)) return false;
  if (a.specificity === null || b.specificity === null) return true;
  for (const x of a.specificity) if (b.specificity.has(x)) return true;
  return false;
}

function conflicts(a: Canonical, b: Canonical): boolean {
  if (a.barrier || b.barrier) return true;
  return a.atoms.some((x) => b.atoms.some((y) => atomsConflict(x, y)));
}

/** Each selector's specificity as `a,b,c`; null when one has a part this does not score. */
export function selectorListSpecificity(list: string): Set<string> | null {
  const out = new Set<string>();
  for (const selector of splitTopLevel(list, ",")) {
    const specificity = selectorSpecificity(selector.trim());
    if (specificity === null) return null;
    out.add(specificity.join(","));
  }
  return out;
}

type Specificity = [number, number, number];

function selectorSpecificity(selector: string): Specificity | null {
  const total: Specificity = [0, 0, 0];
  let i = 0;
  const add = (s: Specificity) => {
    total[0] += s[0];
    total[1] += s[1];
    total[2] += s[2];
  };
  while (i < selector.length) {
    const c = selector[i]!;
    if (c === "\\") return null;
    if (c === "#" || c === ".") {
      add(c === "#" ? [1, 0, 0] : [0, 1, 0]);
      i = readName(selector, i + 1);
    } else if (c === "[") {
      add([0, 1, 0]);
      const close = scanTo(selector, i + 1, "]");
      if (close >= selector.length) return null;
      i = close + 1;
    } else if (c === ":") {
      const element = selector[i + 1] === ":";
      const start = i + (element ? 2 : 1);
      const end = readName(selector, start);
      const name = selector.slice(start, end).toLowerCase();
      if (selector[end] === "(") {
        const close = scanTo(selector, end + 1, ")");
        if (close >= selector.length || element) return null;
        const args = selector.slice(end + 1, close);
        if (name === "where") {
          // Zero, whatever its arguments.
        } else if (name === "is" || name === "not" || name === "has" || name === "matches") {
          const scores = splitTopLevel(args, ",").map((part) => selectorSpecificity(part.trim()));
          if (scores.some((score) => score === null)) return null;
          add(scores.reduce((max, score) => (compareSpecificity(score!, max) > 0 ? score! : max), [0, 0, 0] as Specificity));
        } else if (/\bof\b/.test(args)) {
          return null;
        } else {
          add([0, 1, 0]);
        }
        i = close + 1;
      } else {
        const legacyElement = ["before", "after", "first-line", "first-letter"].includes(name);
        add(element || legacyElement ? [0, 0, 1] : [0, 1, 0]);
        i = end;
      }
    } else if (/[a-zA-Z_-]/.test(c) || c.charCodeAt(0) > 127) {
      add([0, 0, 1]);
      i = readName(selector, i);
    } else if (c === "*" || c === ">" || c === "+" || c === "~" || c === " " || c === "|") {
      i++;
    } else {
      return null;
    }
  }
  return total;
}

function readName(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[\w-]/.test(text[i]!)) i++;
  return i;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = scanTo(text, from, separator);
    parts.push(text.slice(from, at));
    if (at >= text.length) return parts;
    from = at + 1;
  }
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
        if (!emitted[j] && conflicts(nodes[j]!, nodes[i]!)) {
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
  return canonicalOrder(sheets.flatMap((sheet) => parseCss(sheet)).map((node) => canonicalNode(node, STYLE)));
}
