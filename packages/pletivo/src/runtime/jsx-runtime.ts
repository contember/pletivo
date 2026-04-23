import { renderIslandWrapper, registerIsland } from "./island";
import { pushTsxStyle } from "./astro-shim";
import { HtmlString, createHtml, isHtmlString } from "./html-string";
export { HtmlString };

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * CSS properties that accept unitless numeric values (mirrors React's
 * built-in list). Everything else gets a `px` suffix when a number is
 * passed to object-form `style={{ ... }}`.
 */
const UNITLESS_CSS_PROPS = new Set([
  "animationIterationCount",
  "aspectRatio",
  "borderImageOutset", "borderImageSlice", "borderImageWidth",
  "boxFlex", "boxFlexGroup", "boxOrdinalGroup",
  "columnCount", "columns",
  "flex", "flexGrow", "flexPositive", "flexShrink", "flexNegative", "flexOrder",
  "gridArea", "gridRow", "gridRowEnd", "gridRowSpan", "gridRowStart",
  "gridColumn", "gridColumnEnd", "gridColumnSpan", "gridColumnStart",
  "fontWeight", "lineClamp", "lineHeight",
  "opacity", "order", "orphans", "scale",
  "tabSize", "widows", "zIndex", "zoom",
  "fillOpacity", "floodOpacity", "stopOpacity",
  "strokeDasharray", "strokeDashoffset", "strokeMiterlimit", "strokeOpacity", "strokeWidth",
]);

/**
 * Serialize `style={{ color: "red", fontSize: 12 }}` into a CSS declaration
 * string. camelCase → kebab-case; numeric values for length-like properties
 * get a `px` suffix; custom properties (`--foo`) pass through as-is.
 */
function serializeStyleObject(style: Record<string, unknown>): string {
  let out = "";
  for (const [key, value] of Object.entries(style)) {
    if (value == null || value === false || value === "") continue;
    const prop = key.startsWith("--")
      ? key
      : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const val = typeof value === "number" && !UNITLESS_CSS_PROPS.has(key)
      ? `${value}px`
      : String(value);
    out += `${prop}:${val};`;
  }
  return out;
}

function renderChildren(children: unknown): string | Promise<string> {
  if (children == null || children === false || children === true) return "";
  if (typeof children === "string") return escapeHtml(children);
  if (typeof children === "number") return String(children);

  // Async child — await and re-render
  if (children instanceof Promise) {
    return children.then((resolved) => renderChildren(resolved));
  }

  if (Array.isArray(children)) {
    const parts = children.map(renderChildren);
    const hasAsync = parts.some((p) => p instanceof Promise);
    if (hasAsync) {
      return Promise.all(parts).then((resolved) => resolved.join(""));
    }
    return (parts as string[]).join("");
  }

  // Already rendered JSX (raw HTML string from jsx())
  if (isHtmlString(children)) {
    return children.__html;
  }
  return escapeHtml(String(children));
}

type Props = Record<string, unknown> & { children?: unknown };

function renderAttrs(props: Props): string {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (isClientDirectiveKey(key)) continue;
    if (value == null || value === false) continue;
    if (key === "dangerouslySetInnerHTML") continue;
    // Skip event handlers (on*) — they only work on the client
    if (key.startsWith("on") && key.length > 2 && typeof value === "function") continue;
    if (key === "className") {
      result += ` class="${escapeAttr(String(value))}"`;
      continue;
    }
    if (key === "htmlFor") {
      result += ` for="${escapeAttr(String(value))}"`;
      continue;
    }
    if (key === "style" && value && typeof value === "object") {
      const css = serializeStyleObject(value as Record<string, unknown>);
      if (css) result += ` style="${escapeAttr(css)}"`;
      continue;
    }
    if (value === true) {
      result += ` ${key}`;
      continue;
    }
    result += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return result;
}

/**
 * Flatten `<style>` JSX children into a raw CSS string. Handles the
 * common shapes TSX produces: a single template-literal string, an
 * array of strings, and string/number fragments mixed with
 * pre-rendered HtmlString (e.g. `{someCss}` expressions). Elements
 * inside <style> are ignored — CSS text is the only valid payload.
 */
function extractStyleChildren(children: unknown): string {
  if (children == null || children === false || children === true) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map(extractStyleChildren).join("");
  }
  if (isHtmlString(children)) {
    return children.__html;
  }
  return "";
}

export function jsx(
  tag: string | ((props: Props) => HtmlString | string | Promise<HtmlString | string>),
  props: Props,
): HtmlString | Promise<HtmlString> {
  if (typeof tag === "function") {
    // Island detection: client="load" or client:load syntax
    const hydrate = getClientDirective(props);
    if (hydrate) {
      return renderIsland(tag, props, hydrate);
    }

    const result = tag(props);

    // Async component support
    if (result instanceof Promise) {
      return result.then((resolved) => {
        if (typeof resolved === "string") return createHtml(escapeHtml(resolved));
        return resolved;
      });
    }

    if (typeof result === "string") return createHtml(escapeHtml(result));
    return result;
  }

  // `<style>` blocks in TSX pages/components are hoisted into <head> as
  // page-global CSS (parity with Astro `<style is:global>`). Emitting the
  // tag inline in <body> would still work in browsers but fights with
  // Astro's head-collected CSS pipeline — this keeps all stylesheets in
  // one place and lets the build strip/bundle them uniformly.
  if (tag === "style" && !props.dangerouslySetInnerHTML) {
    const css = extractStyleChildren(props.children);
    if (css) pushTsxStyle(css);
    return createHtml("");
  }

  const attrs = renderAttrs(props);

  if (VOID_ELEMENTS.has(tag)) {
    return createHtml(`<${tag}${attrs}>`);
  }

  if (props.dangerouslySetInnerHTML) {
    const inner = (props.dangerouslySetInnerHTML as { __html: string }).__html;
    return createHtml(`<${tag}${attrs}>${inner}</${tag}>`);
  }

  const inner = renderChildren(props.children);
  if (inner instanceof Promise) {
    return inner.then((resolved) => createHtml(`<${tag}${attrs}>${resolved}</${tag}>`));
  }

  return createHtml(`<${tag}${attrs}>${inner}</${tag}>`);
}

export { jsx as jsxs, jsx as jsxDEV };

export function Fragment(
  props: { children?: unknown },
): HtmlString | Promise<HtmlString> {
  const inner = renderChildren(props.children);
  if (inner instanceof Promise) {
    return inner.then((resolved) => createHtml(resolved));
  }
  return createHtml(inner);
}

const CLIENT_DIRECTIVE_KEYS = ["client:load", "client:idle", "client:visible", "client:media", "client:only"] as const;

/**
 * Detect client hydration directive from props.
 * Supports both pletivo syntax (client="load") and Astro syntax (client:load).
 */
function getClientDirective(props: Props): string | null {
  // Pletivo syntax: client="load"
  if (props.client && typeof props.client === "string") {
    return props.client;
  }
  // Astro syntax: client:load, client:idle, etc.
  for (const key of CLIENT_DIRECTIVE_KEYS) {
    if (key in props) {
      const strategy = key.split(":")[1];
      const value = props[key];
      if (strategy === "media" && typeof value === "string") {
        return `media(${value})`;
      }
      return strategy;
    }
  }
  return null;
}

/** Check if a prop key is a client directive (to exclude from component props) */
function isClientDirectiveKey(key: string): boolean {
  return key === "client" || key.startsWith("client:");
}

/**
 * Render a component as an island with hydration marker.
 * Component name is auto-detected from function.name.
 */
function renderIsland(
  tag: (props: Props) => HtmlString | string | Promise<HtmlString | string>,
  props: Props,
  hydrate: string,
): HtmlString {
  const componentName = tag.name || "anonymous";

  // Extract component props (without island-specific ones)
  const componentProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isClientDirectiveKey(key) || key === "children") continue;
    componentProps[key] = value;
  }

  // client:only skips SSR entirely — render empty placeholder, hydrate on load
  let innerHtml = "";
  if (hydrate !== "only") {
    // SSR: call the component function to get server-rendered HTML
    try {
      const rendered = tag(componentProps as Props);
      if (typeof rendered === "string") {
        innerHtml = escapeHtml(rendered);
      } else if (isHtmlString(rendered)) {
        innerHtml = rendered.__html;
      }
    } catch {
      // SSR failed, island will render empty and hydrate on client
    }
  }

  // Register island for bundling
  registerIsland(componentName, componentName);

  const effectiveHydrate = hydrate === "only" ? "load" : hydrate;
  return createHtml(renderIslandWrapper(componentName, effectiveHydrate, componentProps, innerHtml));
}
