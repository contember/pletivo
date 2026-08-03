/**
 * Astro compiler runtime shim for pletivo.
 *
 * Implements the exports that `@astrojs/compiler`'s generated code imports
 * from its `internalURL`. We set `internalURL` to this module when calling
 * `transform()` so that compiled `.astro` modules route their runtime calls
 * here instead of into `astro/runtime/server`.
 *
 * The shim maps Astro's tagged-template rendering model onto pletivo's
 * `HtmlString` convention (raw-HTML marker). Strings are HTML-escaped
 * by default; interpolations that return `HtmlString` (components, slots,
 * attributes, `unescapeHTML`) are inserted raw.
 */

import { HtmlString, createHtml, isHtmlString } from "./html-string";
import { withBase } from "../base";
import { getHoistedScript, hoistedUrl } from "../astro-plugin";
export { HtmlString };

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
  /**
   * Canonical code of the locale that owns this page, as resolved from
   * the URL (or the default locale for non-prefixed routes). Undefined
   * when i18n is not configured or the route lives outside every
   * locale scope.
   */
  currentLocale?: string;
  /**
   * Best-matched configured locale from the request's `Accept-Language`
   * header. Always `undefined` during a static build — meaningful only
   * in dev mode where a real request is available.
   */
  preferredLocale?: string;
  /** Ordered list of every configured locale matched against Accept-Language. */
  preferredLocaleList: string[];
  /**
   * Mutable response init, shared by the page and every child component of
   * one render pass. SSR-only in Astro; here it exists so that pages doing
   * `Astro.response.headers.set(...)` render instead of crashing. In dev the
   * server merges it into the outgoing response; in a static build it is
   * collected and discarded (a file has no headers).
   */
  response: AstroResponse;
  /** Per-render scratch state. Always starts empty — no middleware runs. */
  locals: Record<string, unknown>;
  /**
   * Request cookies plus anything the render writes. Shared across the render
   * pass like `response`. Reads work wherever a request exists (dev); writes
   * are turned into `Set-Cookie` by the dev server and dropped by the build.
   */
  cookies: AstroCookies;
  /**
   * Returns a redirect `Response`. In dev it is served as a real redirect; in
   * a static build it becomes a meta-refresh HTML page, matching Astro's
   * static output. Must be `return`ed from the frontmatter to take effect.
   */
  redirect(path: string, status?: number): Response;
  /**
   * Renders another route's content at the current URL. Resolved by the host
   * (dev server / build), which re-runs routing for the target path. Must be
   * `return`ed from the frontmatter. Throws if the target matches no route,
   * or if the render context has no host to resolve against.
   */
  rewrite(payload: RewritePayload): Promise<Response>;
  /**
   * Requesting IP. Real in dev; `undefined` in a static build, where there is
   * no request. (Astro throws here instead — pletivo doesn't, so a page that
   * merely logs it still builds.)
   */
  clientAddress: string | undefined;
  [key: string]: unknown;
}

export type RewritePayload = string | URL | Request;

/** Resolves a rewrite target to a Response. Supplied by dev.ts / build.ts. */
export type RewriteHandler = (pathname: string) => Promise<Response | null>;

/** Hop limit before a chain of rewrites is treated as a cycle. */
export const MAX_REWRITE_DEPTH = 5;

export interface AstroResponse {
  status: number;
  statusText: string;
  headers: Headers;
}

interface SlotsAccessor {
  has(name: string): boolean;
  render(name: string, args?: unknown[]): Promise<string>;
}

/**
 * Normalize an `Astro.rewrite` payload to a path. Astro accepts a string, a
 * URL, or a Request; only the path (plus query) is meaningful to routing.
 */
function rewriteTarget(payload: RewritePayload): string {
  if (typeof payload === "string") return payload;
  const url = payload instanceof URL ? payload : new URL(payload.url);
  return url.pathname + url.search;
}

// ── Cookies ─────────────────────────────────────────────────────────

export interface AstroCookieSetOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: boolean | "lax" | "none" | "strict";
  secure?: boolean;
  encode?: (value: string) => string;
}

export interface AstroCookieGetOptions {
  decode?: (value: string) => string;
}

/** A single cookie value with Astro's coercion helpers. */
export class AstroCookie {
  constructor(readonly value: string) {}
  json(): unknown {
    return JSON.parse(this.value);
  }
  number(): number {
    return Number(this.value);
  }
  boolean(): boolean {
    if (this.value === "false") return false;
    if (this.value === "0") return false;
    return Boolean(this.value);
  }
}

function serializeCookie(
  name: string,
  value: string,
  opts: AstroCookieSetOptions = {},
): string {
  const encode = opts.encode ?? encodeURIComponent;
  const parts = [`${name}=${encode(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite !== undefined) {
    const v = opts.sameSite === true ? "Strict" : opts.sameSite;
    if (v) parts.push(`SameSite=${v.charAt(0).toUpperCase()}${v.slice(1)}`);
  }
  return parts.join("; ");
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    try {
      out.set(name, decodeURIComponent(pair.slice(eq + 1).trim()));
    } catch {
      out.set(name, pair.slice(eq + 1).trim());
    }
  }
  return out;
}

/**
 * Astro's `Astro.cookies` API. Reads are seeded from the request's `Cookie`
 * header (dev only — a static build has no request, so reads come back
 * empty). Writes accumulate here and are surfaced through `headers()`; the
 * dev server attaches them as `Set-Cookie`, the build discards them.
 */
export class AstroCookies {
  #incoming: Map<string, string>;
  /** Writes made during this render, in insertion order. null = deleted. */
  #outgoing = new Map<string, { value: string | null; serialized: string }>();

  constructor(request?: Request) {
    this.#incoming = parseCookieHeader(request?.headers.get("cookie") ?? null);
  }

  has(key: string, _options?: AstroCookieGetOptions): boolean {
    const written = this.#outgoing.get(key);
    if (written) return written.value !== null;
    return this.#incoming.has(key);
  }

  get(key: string, options?: AstroCookieGetOptions): AstroCookie | undefined {
    const written = this.#outgoing.get(key);
    if (written) {
      return written.value === null ? undefined : new AstroCookie(written.value);
    }
    const raw = this.#incoming.get(key);
    if (raw === undefined) return undefined;
    return new AstroCookie(options?.decode ? options.decode(raw) : raw);
  }

  set(
    key: string,
    value: string | number | boolean | Record<string, unknown> | unknown[],
    options?: AstroCookieSetOptions,
  ): void {
    const serializedValue =
      typeof value === "string" ? value : JSON.stringify(value);
    this.#outgoing.set(key, {
      value: serializedValue,
      serialized: serializeCookie(key, serializedValue, options),
    });
  }

  delete(key: string, options?: AstroCookieSetOptions): void {
    this.#outgoing.set(key, {
      value: null,
      serialized: serializeCookie(key, "", {
        ...options,
        expires: new Date(0),
        maxAge: 0,
      }),
    });
  }

  /** Merge another render's writes into this one (Astro 5 parity). */
  merge(other: AstroCookies): void {
    for (const [key, entry] of other.#outgoing) this.#outgoing.set(key, entry);
  }

  /** Serialized `Set-Cookie` values for every write made this render. */
  *headers(): Generator<string> {
    for (const { serialized } of this.#outgoing.values()) yield serialized;
  }
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
  /** Canonical locale code for `Astro.currentLocale`. */
  currentLocale?: string;
  /** Best Accept-Language match for `Astro.preferredLocale`. */
  preferredLocale?: string;
  /** All matched Accept-Language locales in priority order. */
  preferredLocaleList?: string[];
  /**
   * Response init backing `Astro.response`. Pass one in to observe what the
   * page wrote (dev server does this); omitted, a throwaway is created.
   */
  response?: AstroResponse;
  /** Seed for `Astro.locals`. Defaults to an empty object. */
  locals?: Record<string, unknown>;
  /**
   * Cookie jar backing `Astro.cookies`. Pass one in to read back what the
   * page wrote (dev server does this); omitted, one is built from `request`.
   */
  cookies?: AstroCookies;
  /**
   * Host resolver backing `Astro.rewrite`. Omitted (container renders, unit
   * tests), calling `Astro.rewrite` throws rather than silently no-opping.
   */
  rewrite?: RewriteHandler;
  /** Seed for `Astro.clientAddress`. Dev only — a build has no request. */
  clientAddress?: string;
}

type SlotFn = () => unknown;
type SlotsRecord = Record<string, SlotFn>;

function makeResult(pageContext: PageContext = {}): AstroResult {
  const request =
    pageContext.request ??
    new Request(pageContext.url ?? "http://localhost/");
  const normalizedPageContext: PageContext = {
    ...pageContext,
    request,
  };

  // One response/locals pair per render pass — created here (not per
  // `createAstro` call) so a header set by a child component is visible to
  // the page and to the dev server, matching Astro's shared-response model.
  const response: AstroResponse = normalizedPageContext.response ?? {
    status: 200,
    statusText: "OK",
    headers: new Headers(),
  };
  const locals = normalizedPageContext.locals ?? {};
  // `request` is synthesized when the host didn't supply one (static build),
  // and a synthesized request carries no Cookie header — reads come back
  // empty there, which is the intent.
  const cookies = normalizedPageContext.cookies ?? new AstroCookies(request);
  // Astro copies the accumulated response headers and cookies onto the
  // redirect, so a redirect can still set a session cookie.
  const redirect = (path: string, status = 302): Response => {
    const headers = new Headers(response.headers);
    for (const cookie of cookies.headers()) headers.append("set-cookie", cookie);
    headers.set("location", path);
    return new Response(null, { status, headers });
  };
  const rewrite = async (payload: RewritePayload): Promise<Response> => {
    const target = rewriteTarget(payload);
    if (!normalizedPageContext.rewrite) {
      throw new Error(
        `Astro.rewrite("${target}") is unavailable in this render context — ` +
          `no route resolver was provided.`,
      );
    }
    const out = await normalizedPageContext.rewrite(target);
    if (!out) {
      throw new Error(`Astro.rewrite("${target}") matched no route.`);
    }
    return out;
  };
  return {
    pageContext: normalizedPageContext,
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
        url: normalizedPageContext.url,
        request: normalizedPageContext.request,
        site: normalizedPageContext.site,
        params: normalizedPageContext.params || {},
        generator: "pletivo",
        currentLocale: normalizedPageContext.currentLocale,
        preferredLocale: normalizedPageContext.preferredLocale,
        preferredLocaleList: normalizedPageContext.preferredLocaleList ?? [],
        response,
        locals,
        cookies,
        redirect,
        rewrite,
        clientAddress: normalizedPageContext.clientAddress,
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

/**
 * Per-page registry of component module ids whose render function
 * ran during the current render pass. Used by build/dev to decide
 * which components' `<style is:global>` CSS to emit — class-presence
 * gating can't catch components that declare only global styles and
 * render no scoped DOM.
 *
 * Uses AsyncLocalStorage so concurrent page renders (e.g. `Promise.all`
 * over routes in the build loop) stay isolated. Wrap each render in
 * `runWithRenderTracking(fn)`; inside, `createComponent`'s wrapped
 * invocation adds its `moduleId` to the current store's set.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const renderTrackingStorage = new AsyncLocalStorage<{
  renderedModules: Set<string>;
  tsxStyles: string[];
}>();

export async function runWithRenderTracking<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; renderedModules: Set<string>; tsxStyles: string[] }> {
  const renderedModules = new Set<string>();
  const tsxStyles: string[] = [];
  const value = await renderTrackingStorage.run(
    { renderedModules, tsxStyles },
    fn,
  );
  return { value, renderedModules, tsxStyles };
}

/**
 * Record a `<style>` block encountered during TSX rendering. The JSX
 * runtime calls this for literal `<style>` JSX elements so the CSS is
 * hoisted into `<head>` instead of emitted inline. Collected per render
 * pass and included in the page's CSS bundle alongside scoped/global
 * Astro styles.
 */
export function pushTsxStyle(css: string): void {
  const store = renderTrackingStorage.getStore();
  if (store) store.tsxStyles.push(css);
}

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
    if (moduleId) {
      const store = renderTrackingStorage.getStore();
      if (store) store.renderedModules.add(moduleId);
    }
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
  // HtmlString (e.g. from defineStyleVars) — extract raw content
  if (isHtmlString(value)) {
    return createHtml(` ${key}="${escapeAttr(value.__html)}"`);
  }
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

// ── Head / scripts / transitions ────────────────────────────────────

/**
 * Intentional no-op. Scoped CSS is injected post-render by build.ts
 * and dev.ts via `getScopedCssForPage()`, which matches scope classes
 * in the rendered HTML to include only relevant entries (per-page CSS
 * tree-shaking). This can't be done inline during render because the
 * full set of rendered components isn't known until the template
 * finishes evaluating.
 */
export function renderHead(_result: AstroResult): HtmlString {
  return createHtml("");
}

export function maybeRenderHead(_result: AstroResult): HtmlString {
  return createHtml("");
}

export function renderScript(_result: AstroResult, id: string): HtmlString {
  const entry = getHoistedScript(id);
  if (!entry) return createHtml("");
  return createHtml(
    `<script type="module" src="${withBase(hoistedUrl(entry.hash))}"></script>`,
  );
}

/**
 * Compile `define:vars={{ color, size }}` on `<style>` into inline CSS
 * custom properties. The Astro compiler generates:
 *   `$$addAttribute($$defineStyleVars([{ color, size }]), "style")`
 * so the output becomes the value of a `style` attribute.
 */
export function defineStyleVars(defs: Record<string, unknown> | Record<string, unknown>[]): HtmlString {
  let output = "";
  const arr = Array.isArray(defs) ? defs : [defs];
  for (const vars of arr) {
    for (const [key, value] of Object.entries(vars)) {
      if (value || value === 0) {
        output += `--${key}: ${value};`;
      }
    }
  }
  return createHtml(output);
}

/**
 * Compile `define:vars={{ foo }}` on inline `<script>` into const
 * declarations injected at the top of the script body.
 */
export function defineScriptVars(vars: Record<string, unknown>): HtmlString {
  let output = "";
  for (const [key, value] of Object.entries(vars)) {
    output += `const ${key} = ${JSON.stringify(value)?.replace(/<\/script>/g, "\\x3C/script>")};\n`;
  }
  return createHtml(output);
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
  const out = (await Component(result, props, {})) as unknown;
  // The page returned a Response: a redirect folds into a meta-refresh page,
  // a rewrite's HTML body is the page's content (same rules as build.ts).
  if (out instanceof Response) {
    return out.headers.get("location") ? redirectPageHtml(out) : await out.text();
  }
  return (out as HtmlString).__html;
}

/**
 * Astro's static-output rendering of `return Astro.redirect(...)`: a
 * prerendered page can't send a 3xx, so it emits a meta-refresh document.
 * Non-redirect Responses (a page returning JSON, say) have no static
 * equivalent — their body is written out as-is.
 */
export function redirectPageHtml(response: Response): string {
  const location = response.headers.get("location");
  if (!location) return "";
  const href = escapeAttr(location);
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>Redirecting to: ${escapeHtml(location)}</title>` +
    `<meta http-equiv="refresh" content="0;url=${href}">` +
    `<meta name="robots" content="noindex">` +
    `<link rel="canonical" href="${href}">` +
    `</head><body><a href="${href}">Redirecting to ${escapeHtml(location)}</a></body></html>`
  );
}

export function isAstroComponent(x: unknown): x is AstroComponentFactory {
  return (
    typeof x === "function" &&
    (x as AstroComponentFactory).isAstroComponentFactory === true
  );
}
