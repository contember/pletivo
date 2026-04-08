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

function renderChildren(children: unknown): string {
  if (children == null || children === false || children === true) return "";
  if (typeof children === "string") return escapeHtml(children);
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(renderChildren).join("");
  // Already rendered JSX (raw HTML string from jsx())
  if (typeof children === "object" && children !== null && "__html" in children) {
    return (children as { __html: string }).__html;
  }
  return escapeHtml(String(children));
}

type Props = Record<string, unknown> & { children?: unknown };

function renderAttrs(props: Props): string {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (value == null || value === false) continue;
    if (key === "dangerouslySetInnerHTML") continue;
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

interface HtmlString {
  __html: string;
}

function createHtml(html: string): HtmlString {
  return { __html: html };
}

export function jsx(
  tag: string | ((props: Props) => HtmlString | string),
  props: Props,
): HtmlString {
  if (typeof tag === "function") {
    const result = tag(props);
    if (typeof result === "string") return createHtml(escapeHtml(result));
    return result;
  }

  const attrs = renderAttrs(props);

  if (VOID_ELEMENTS.has(tag)) {
    return createHtml(`<${tag}${attrs}>`);
  }

  let inner: string;
  if (props.dangerouslySetInnerHTML) {
    inner = (props.dangerouslySetInnerHTML as { __html: string }).__html;
  } else {
    inner = renderChildren(props.children);
  }

  return createHtml(`<${tag}${attrs}>${inner}</${tag}>`);
}

export { jsx as jsxs, jsx as jsxDEV };

export function Fragment(props: { children?: unknown }): HtmlString {
  return createHtml(renderChildren(props.children));
}
