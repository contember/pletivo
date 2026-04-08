import { renderIslandWrapper, registerIsland } from "./island";

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
  if (typeof children === "object" && children !== null && "__html" in children) {
    return (children as HtmlString).__html;
  }
  return escapeHtml(String(children));
}

type Props = Record<string, unknown> & { children?: unknown };

function renderAttrs(props: Props): string {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (key === "client") continue;
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
    if (value === true) {
      result += ` ${key}`;
      continue;
    }
    result += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return result;
}

export interface HtmlString {
  __html: string;
}

function createHtml(html: string): HtmlString {
  return { __html: html };
}

export function jsx(
  tag: string | ((props: Props) => HtmlString | string | Promise<HtmlString | string>),
  props: Props,
): HtmlString | Promise<HtmlString> {
  if (typeof tag === "function") {
    // Island detection: if `client` prop is present, render as island
    if (props.client && typeof props.client === "string") {
      return renderIsland(tag, props);
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

/**
 * Render a component as an island with hydration marker.
 * Component name is auto-detected from function.name — no need for __islandName.
 */
function renderIsland(
  tag: (props: Props) => HtmlString | string | Promise<HtmlString | string>,
  props: Props,
): HtmlString {
  const hydrate = props.client as string;
  const componentName = tag.name || "anonymous";

  // Extract component props (without island-specific ones)
  const componentProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "client" || key === "children") continue;
    componentProps[key] = value;
  }

  // SSR: call the component function to get server-rendered HTML
  let innerHtml = "";
  try {
    const rendered = tag(componentProps as Props);
    if (typeof rendered === "string") {
      innerHtml = escapeHtml(rendered);
    } else if (rendered && typeof rendered === "object" && "__html" in rendered) {
      innerHtml = (rendered as HtmlString).__html;
    }
  } catch {
    // SSR failed, island will render empty and hydrate on client
  }

  // Register island for bundling
  registerIsland(componentName, componentName);

  return createHtml(renderIslandWrapper(componentName, hydrate, componentProps, innerHtml));
}
