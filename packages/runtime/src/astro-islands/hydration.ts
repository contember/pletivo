/**
 * Astro's `extractDirectives` and `<astro-island>` markup, ported so attributes, their
 * order and their escaping match Astro's output byte for byte.
 */
import type { RendererMetadata } from "./types";

export type HydrateDirective = NonNullable<RendererMetadata["hydrate"]>;

const HYDRATE_DIRECTIVES: ReadonlySet<string> = new Set(["load", "idle", "visible", "media", "only"]);

function isHydrateDirective(name: string): name is HydrateDirective {
  return HYDRATE_DIRECTIVES.has(name);
}

export const TRANSITION_ATTRIBUTES = [
  "data-astro-transition-scope",
  "data-astro-transition-persist",
  "data-astro-transition-persist-props",
] as const;
const transitionAttributes: ReadonlySet<string> = new Set(TRANSITION_ATTRIBUTES);

export interface Hydration {
  directive: HydrateDirective;
  value: unknown;
  componentUrl: string;
  componentExport: { value: string };
}

export interface ExtractedProps {
  isPage: boolean;
  hydration: Hydration | null;
  props: Record<string, unknown>;
  propsWithoutTransitionAttributes: Record<string, unknown>;
}

function copySymbol(target: object, symbol: symbol, value: unknown): void {
  Object.defineProperty(target, symbol, { value, enumerable: true, writable: true, configurable: true });
}

/** html-escaper's `escape`, which Astro uses for island attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      default:
        return "&quot;";
    }
  });
}

/** clsx 2.1.1, which Astro uses to fold `class:list` into `class`. */
function classValue(mix: unknown): string {
  let out = "";
  if (typeof mix === "string" || typeof mix === "number") {
    out += mix;
  } else if (Array.isArray(mix)) {
    for (const item of mix) {
      const part = item ? classValue(item) : "";
      if (part) out += (out ? " " : "") + part;
    }
  } else if (typeof mix === "object" && mix !== null) {
    for (const key in mix) {
      if (Reflect.get(mix, key)) out += (out ? " " : "") + key;
    }
  }
  return out;
}

function clsx(...values: unknown[]): string {
  let out = "";
  for (const value of values) {
    const part = value ? classValue(value) : "";
    if (part) out += (out ? " " : "") + part;
  }
  return out;
}

/** Astro's `normalizeProps`: `class:list` becomes `class`, on a copy so the caller's object stays as passed. */
export function normalizeProps(input: Record<string, unknown>): Record<string, unknown> {
  if (input["class:list"] === undefined) return input;
  const props = { ...input };
  const value = props["class:list"];
  delete props["class:list"];
  props["class"] = clsx(props["class"], value);
  if (props["class"] === "") delete props["class"];
  return props;
}

/**
 * Astro's `extractDirectives`: `client:*` keys become the hydration metadata and leave
 * the props; transition attributes stay in `props` but not in what the renderer gets.
 */
export function extractDirectives(input: Record<string, unknown>, directives: ReadonlySet<string>): ExtractedProps {
  let isPage = false;
  let directive: HydrateDirective | null = null;
  let value: unknown = "";
  let componentUrl = "";
  let componentExport = "";
  const props: Record<string, unknown> = {};
  const propsWithoutTransitionAttributes: Record<string, unknown> = {};
  for (const [key, propValue] of Object.entries(input)) {
    if (key === "server:root") isPage = true;
    if (key.startsWith("client:")) {
      switch (key) {
        case "client:component-path":
          componentUrl = String(propValue);
          break;
        case "client:component-export":
          componentExport = String(propValue);
          break;
        case "client:component-hydration":
        case "client:display-name":
          break;
        default: {
          const name = key.split(":")[1] ?? "";
          if (!directives.has(name) || !isHydrateDirective(name)) {
            const supported = [...directives].map((d) => `client:${d}`).join(", ");
            throw new Error(`Error: invalid hydration directive "${key}". Supported hydration methods: ${supported}`);
          }
          if (name === "media" && typeof propValue !== "string") {
            throw new Error(
              'Media query not provided for `client:media` directive. A media query similar to `client:media="(max-width: 600px)"` must be provided',
            );
          }
          directive = name;
          value = propValue;
        }
      }
    } else {
      props[key] = propValue;
      if (!transitionAttributes.has(key)) propsWithoutTransitionAttributes[key] = propValue;
    }
  }
  for (const symbol of Object.getOwnPropertySymbols(input)) {
    const symbolValue: unknown = Reflect.get(input, symbol);
    copySymbol(props, symbol, symbolValue);
    copySymbol(propsWithoutTransitionAttributes, symbol, symbolValue);
  }
  // Astro keeps a hydration record for `client:component-*` keys without a directive; none reaches here.
  const hydration = directive ? { directive, value, componentUrl, componentExport: { value: componentExport } } : null;
  return { isPage, hydration, props, propsWithoutTransitionAttributes };
}

/** Astro's `renderElement(name, element, false)`: values are written raw, `null` is dropped, `""` is a bare name. */
export function renderElement(name: string, attributes: Record<string, unknown>, children: string): string {
  let out = `<${name}`;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "lang" || key === "data-astro-id" || key === "define:vars") continue;
    if (value == null) continue;
    out += value === "" ? ` ${key}` : ` ${key}="${String(value)}"`;
  }
  return `${out}>${children}</${name}>`;
}
