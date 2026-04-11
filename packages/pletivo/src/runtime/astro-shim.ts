/**
 * Astro compiler runtime shim for pletivo.
 *
 * Implements the exports that `@astrojs/compiler`'s generated code imports
 * from its `internalURL`. We set `internalURL` to this module when calling
 * `transform()` so that compiled `.astro` modules route their runtime calls
 * here instead of into `astro/runtime/server`.
 *
 * The shim maps Astro's tagged-template rendering model onto pletivo's
 * `HtmlString` convention (`{ __html: string }`). Strings are HTML-escaped
 * by default; interpolations that return `HtmlString` (components, slots,
 * attributes, `unescapeHTML`) are inserted raw.
 */

export interface HtmlString {
  __html: string;
}

function isHtmlString(x: unknown): x is HtmlString {
  return typeof x === "object" && x !== null && "__html" in x;
}

function createHtml(html: string): HtmlString {
  return { __html: html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Strip the outermost HTML element from a string, keeping its inner
 * content. Used to remove the slot="name" carrier element that the
 * compiler wraps around named slot content.
 *
 *   "<div>\n  <p>hi</p>\n</div>" → "\n  <p>hi</p>\n"
 */
function stripOuterElement(html: string): string {
  const trimmed = html.trim();
  const openEnd = trimmed.indexOf(">");
  if (openEnd === -1 || trimmed[0] !== "<") return html;
  const closeStart = trimmed.lastIndexOf("</");
  if (closeStart === -1) return html;
  return trimmed.slice(openEnd + 1, closeStart);
}

// ── Per-render context ──────────────────────────────────────────────

export interface AstroGlobal {
  props: Record<string, unknown>;
  slots: SlotsAccessor;
  self?: unknown;
  url?: URL;
  request?: Request;
  site?: URL;
  generator: string;
  params: Record<string, string>;
  [key: string]: unknown;
}

interface SlotsAccessor {
  has(name: string): boolean;
  render(name: string, args?: unknown[]): Promise<string>;
}

export interface AstroResult {
  createAstro(
    props: Record<string, unknown>,
    slots: SlotsRecord,
  ): AstroGlobal;
  /** Inherited page-level state (url, request, params) forwarded to all child components */
  pageContext: PageContext;
}

export interface PageContext {
  url?: URL;
  request?: Request;
  site?: URL;
  params?: Record<string, string>;
}

type SlotFn = () => unknown;
type SlotsRecord = Record<string, SlotFn>;

function makeResult(pageContext: PageContext = {}): AstroResult {
  return {
    pageContext,
    createAstro(props, slots) {
      // Proxy so that `'slotName' in Astro.slots` works (compiled code
      // uses the `in` operator to check for filled slots).
      const slotsAccessor: SlotsAccessor = new Proxy(
        {
          has(name: string) {
            return typeof slots?.[name] === "function";
          },
          async render(name: string, args?: unknown[]) {
            const fn = slots?.[name];
            if (typeof fn !== "function") return "";
            const prevArgs = currentSlotArgs;
            currentSlotArgs = args;
            try {
              let html = await renderValue(fn());
              // For named slots with args, the compiler wraps the slot
              // content in the element that carried slot="name" (e.g.
              // <div slot="before">fn</div>). Astro strips that
              // wrapper so only the function's output remains.
              if (args && args.length > 0 && name !== "default") {
                html = stripOuterElement(html);
              }
              // Return an HtmlString so the result can be used with
              // set:html or interpolated without double-escaping.
              return createHtml(html) as unknown as string;
            } finally {
              currentSlotArgs = prevArgs;
            }
          },
        },
        {
          has(_target, prop) {
            if (prop === "has" || prop === "render") return true;
            return typeof slots?.[prop as string] === "function";
          },
        },
      );
      return {
        props: props || {},
        slots: slotsAccessor,
        url: pageContext.url,
        request: pageContext.request,
        site: pageContext.site,
        params: pageContext.params || {},
        generator: "pletivo",
      };
    },
  };
}

// ── $$render tagged template ────────────────────────────────────────

/**
 * Convert any interpolation value to a raw HTML string.
 * - HtmlString → raw
 * - Promise → awaited
 * - Array → joined
 * - null/undefined/false → empty
 * - number → stringified
 * - string → HTML-escaped (text content default)
 */
// Context for Astro.slots.render() with arguments. When set, function
// values encountered during renderValue() are called with these args
// (e.g. `{(props) => <div>{props.text}</div>}` in a slot).
let currentSlotArgs: unknown[] | undefined;

async function renderValue(value: unknown): Promise<string> {
  if (value == null || value === false || value === true) return "";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (isHtmlString(value)) return value.__html;
  if (value instanceof Promise) {
    return renderValue(await value);
  }
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map(renderValue));
    return parts.join("");
  }
  // Functions (e.g. slot functions passed as values) — call and recurse
  if (typeof value === "function") {
    const fn = value as (...a: unknown[]) => unknown;
    return renderValue(currentSlotArgs ? fn(...currentSlotArgs) : fn());
  }
  // Fallback: stringify + escape
  return escapeHtml(String(value));
}

export function render(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<HtmlString> {
  return (async () => {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        out += await renderValue(values[i]);
      }
    }
    return createHtml(out);
  })();
}

// ── Component factory ───────────────────────────────────────────────

export type AstroComponentFactory = {
  (
    resultOrProps?: AstroResult | Record<string, unknown>,
    props?: Record<string, unknown>,
    slots?: SlotsRecord,
  ): Promise<HtmlString>;
  isAstroComponentFactory: true;
  moduleId: string;
};

export function createComponent(
  fn: (
    result: AstroResult,
    props: Record<string, unknown>,
    slots: SlotsRecord,
  ) => HtmlString | Promise<HtmlString>,
  moduleId: string = "",
  _propagation?: unknown,
): AstroComponentFactory {
  const wrapped = async (
    resultOrProps?: AstroResult | Record<string, unknown>,
    propsArg?: Record<string, unknown>,
    slotsArg?: SlotsRecord,
  ): Promise<HtmlString> => {
    let result: AstroResult;
    let props: Record<string, unknown>;
    let slots: SlotsRecord;

    if (
      resultOrProps &&
      typeof (resultOrProps as AstroResult).createAstro === "function"
    ) {
      // Called as child component: (result, props, slots)
      result = resultOrProps as AstroResult;
      props = propsArg || {};
      slots = slotsArg || {};
    } else {
      // Called as top-level page or from JSX/MDX context: (props)
      result = makeResult(
        (resultOrProps as Record<string, unknown> | undefined)?.[
          "__pageContext"
        ] as PageContext | undefined,
      );
      // Strip __pageContext from props
      const raw = (resultOrProps as Record<string, unknown>) || {};
      const { __pageContext, children, ...userProps } = raw;
      props = userProps;
      // Bridge JSX children to Astro's default slot so that Astro
      // components work when called from MDX or JSX contexts.
      slots = children != null ? { default: () => children } : {};
    }

    const out = fn(result, props, slots);
    return out instanceof Promise ? await out : out;
  };
  (wrapped as AstroComponentFactory).isAstroComponentFactory = true;
  (wrapped as AstroComponentFactory).moduleId = moduleId;
  return wrapped as AstroComponentFactory;
}

/** No-op at runtime; exists so generated modules can do `const $$Astro = $$createAstro();` */
export function createAstro(_site?: string): Record<string, unknown> {
  return {};
}

// ── renderComponent ─────────────────────────────────────────────────

const voidElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export async function renderComponent(
  result: AstroResult,
  _displayName: string,
  Component: unknown,
  props: Record<string, unknown> = {},
  slots: SlotsRecord = {},
): Promise<HtmlString> {
  if (Component == null) {
    return createHtml("");
  }

  // Strip out internal-only keys
  const cleanProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class:list") {
      // Astro class:list → class (omit if empty to avoid class="")
      const cls = normalizeClassList(v);
      if (cls) cleanProps["class"] = cls;
    } else {
      cleanProps[k] = v;
    }
  }

  // Astro component (wrapped with createComponent)
  if (
    typeof Component === "function" &&
    (Component as AstroComponentFactory).isAstroComponentFactory
  ) {
    const rendered = await (Component as AstroComponentFactory)(
      result,
      cleanProps,
      slots,
    );
    return rendered;
  }

  // Plain function component (pletivo JSX, or shim Fragment)
  if (typeof Component === "function") {
    // Bridge Astro slots to pletivo's `children` convention
    const childrenHtml = slots.default
      ? createHtml(await renderValue(slots.default()))
      : undefined;
    const propsWithChildren: Record<string, unknown> = { ...cleanProps };
    if (childrenHtml) propsWithChildren.children = childrenHtml;
    const out = (Component as (p: Record<string, unknown>) => unknown)(
      propsWithChildren,
    );
    const awaited = out instanceof Promise ? await out : out;
    if (isHtmlString(awaited)) return awaited;
    if (typeof awaited === "string") return createHtml(escapeHtml(awaited));
    return createHtml(await renderValue(awaited));
  }

  // String tag — dynamic HTML element (e.g. Control = 'input')
  if (typeof Component === "string") {
    const tag = Component;
    let attrs = "";
    for (const [k, v] of Object.entries(cleanProps)) {
      attrs += addAttribute(v, k).__html;
    }
    const childHtml = slots.default
      ? await renderValue(slots.default())
      : "";
    if (voidElements.has(tag) && !childHtml) {
      return createHtml(`<${tag}${attrs}>`);
    }
    return createHtml(`<${tag}${attrs}>${childHtml}</${tag}>`);
  }

  // Unknown thing — give up
  return createHtml("");
}

function normalizeClassList(value: unknown): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(normalizeClassList)
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k)
      .join(" ");
  }
  return String(value);
}

// ── Slot rendering ──────────────────────────────────────────────────

export async function renderSlot(
  _result: AstroResult,
  slot: SlotFn | undefined,
  fallback?: unknown,
): Promise<HtmlString> {
  if (typeof slot === "function") {
    const value = slot();
    return createHtml(await renderValue(value));
  }
  if (fallback !== undefined) {
    return createHtml(await renderValue(fallback));
  }
  return createHtml("");
}

export function mergeSlots(...args: SlotsRecord[]): SlotsRecord {
  return Object.assign({}, ...args);
}

// ── Attributes ──────────────────────────────────────────────────────

/**
 * Render a single attribute as an HTML fragment, for interpolation inside
 * a tag: `<meta${$$addAttribute(value, "content")}>`.
 */
export function addAttribute(value: unknown, key: string): HtmlString {
  if (value == null || value === false) return createHtml("");
  if (key === "class:list") {
    const cls = normalizeClassList(value);
    if (!cls) return createHtml("");
    return createHtml(` class="${escapeAttr(cls)}"`);
  }
  if (value === true) return createHtml(` ${key}`);
  return createHtml(` ${key}="${escapeAttr(String(value))}"`);
}

/** Render an object of attributes. */
export function spreadAttributes(
  values: Record<string, unknown> | null | undefined,
  _name?: string,
  { class: scopedClassName }: { class?: string } = {},
): HtmlString {
  if (!values) return createHtml("");
  // Merge compiler-provided scope class into the spread values
  if (scopedClassName) {
    if (typeof values.class !== "undefined") {
      values = { ...values, class: `${values.class} ${scopedClassName}` };
    } else {
      values = { ...values, class: scopedClassName };
    }
  }
  let out = "";
  for (const [k, v] of Object.entries(values)) {
    out += addAttribute(v, k).__html;
  }
  return createHtml(out);
}

// ── Head / scripts / transitions (MVP no-ops) ───────────────────────

export function renderHead(_result: AstroResult): HtmlString {
  // TODO: inject scoped style <link>s collected during render
  return createHtml("");
}

export function maybeRenderHead(_result: AstroResult): HtmlString {
  return createHtml("");
}

export function renderScript(_result: AstroResult, id: string): HtmlString {
  // Lazy import to avoid circular dependency at module level
  const { getHoistedScript } = require("../astro-plugin");
  const code = getHoistedScript(id);
  if (!code) return createHtml("");
  return createHtml(`<script type="module">${code}</script>`);
}

export function defineStyleVars(_vars: unknown): HtmlString {
  return createHtml("");
}

export function defineScriptVars(_vars: unknown): HtmlString {
  return createHtml("");
}

export function renderTransition(
  _result: AstroResult,
  _hash: string,
  _animationName?: string,
  _transitionName?: string,
): HtmlString {
  return createHtml("");
}

export function createTransitionScope(
  _result: AstroResult,
  _hash: string,
): string {
  return "";
}

// ── unescapeHTML ────────────────────────────────────────────────────

/** Marker that tells `$$render` not to escape the value. */
export function unescapeHTML(value: unknown): HtmlString | Promise<HtmlString> {
  if (isHtmlString(value)) return value;
  if (value instanceof Promise) {
    return value.then((v) => unescapeHTML(v) as HtmlString);
  }
  return createHtml(String(value ?? ""));
}

// ── Fragment ────────────────────────────────────────────────────────

/**
 * `<Fragment>` component. Used by Astro compiler for both explicit
 * `<Fragment>` usage and `<Fragment set:html>` patterns.
 *
 * Treated as a regular function component by `renderComponent`: it receives
 * `children` (bridged from slots.default) and returns them raw.
 */
export async function Fragment(
  props: { children?: unknown; "set:html"?: unknown },
): Promise<HtmlString> {
  if (props["set:html"] !== undefined) {
    return createHtml(String(props["set:html"]));
  }
  if (isHtmlString(props.children)) return props.children;
  return createHtml(await renderValue(props.children));
}

// ── Page entrypoint helper ──────────────────────────────────────────

/**
 * Render a top-level Astro page component to a raw HTML string. Used by
 * pletivo's `dev.ts` and `build.ts` when the page module is a `.astro` file.
 */
export async function renderAstroPage(
  Component: AstroComponentFactory,
  props: Record<string, unknown>,
  pageContext: PageContext = {},
): Promise<string> {
  const result = makeResult(pageContext);
  const out = await Component(result, props, {});
  return out.__html;
}

export function isAstroComponent(x: unknown): x is AstroComponentFactory {
  return (
    typeof x === "function" &&
    (x as AstroComponentFactory).isAstroComponentFactory === true
  );
}
