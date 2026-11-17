/**
 * Components of the UI frameworks Astro renders through its renderer protocol
 * (`addRenderer`). Without the framework's renderer pletivo renders `.astro`
 * components and JSX compiled for its own runtime only, so a framework component
 * has to fail by name rather than render as something else.
 */

const FRAMEWORK_BY_EXTENSION: Record<string, string> = {
  ".svelte": "Svelte",
  ".vue": "Vue",
};

/** Why the error is not a bug in the component, appended to every refusal. */
export const FRAMEWORK_RENDERERS_UNSUPPORTED =
  "Astro renders these through the renderer of the framework's integration (@astrojs/react, @astrojs/vue, …). " +
  "pletivo's Bun host does too when that integration is in astro.config; the Workers host implements no renderers " +
  "and renders .astro components and JSX compiled for pletivo's runtime (jsxImportSource \"pletivo\") only.";

/** The framework a component file belongs to by its extension, e.g. `Svelte` for `.svelte`. */
export function frameworkOfFile(file: string): string | null {
  return FRAMEWORK_BY_EXTENSION[extensionOf(file)] ?? null;
}

/**
 * A string in a component position is an element name. One with a path separator
 * never is: it is an imported file the host had no module for, whose default export
 * is its path, and emitting it as a tag would render a wrong page without a word.
 */
export function assertElementName(tag: string): void {
  if (!/[\\/]/.test(tag)) return;
  const framework = frameworkOfFile(tag);
  throw new Error(
    framework
      ? `pletivo cannot render ${framework} components: ${tag}. ${FRAMEWORK_RENDERERS_UNSUPPORTED}`
      : `pletivo cannot render ${tag} as a component: pletivo has no module loader for ` +
          `${extensionOf(tag) || "extensionless"} files, so the import evaluated to its path.`,
  );
}

/**
 * The framework whose element (vnode) `value` is, by the marker each one sets:
 * React's `$$typeof`, Vue's `__v_isVNode`, and Preact's own `constructor: undefined`.
 * pletivo's JSX yields `HtmlString`s, so one of these is JSX compiled for that framework.
 */
export function foreignElementFramework(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (typeof Reflect.get(value, "$$typeof") === "symbol") return "React";
  if (Reflect.get(value, "__v_isVNode") === true) return "Vue";
  if (Object.hasOwn(value, "constructor") && Reflect.get(value, "constructor") === undefined && "type" in value && "props" in value) {
    return "Preact";
  }
  return null;
}

/**
 * Throw when `value` is another framework's element. `owner` names the component
 * that returned it, when the caller knows.
 */
export function assertNotForeignElement(value: unknown, owner?: string): void {
  const framework = foreignElementFramework(value);
  if (framework === null) return;
  const type = typeof value === "object" && value !== null && "type" in value ? Reflect.get(value, "type") : value;
  const what = `a ${framework} element (${describeComponent(type)})`;
  throw new Error(
    `pletivo cannot render ${framework} components: ${owner === undefined ? what : `<${owner}> returned ${what}`}. ` +
      FRAMEWORK_RENDERERS_UNSUPPORTED,
  );
}

/** A component value that is neither a function, an `.astro` component nor an element name. */
export function unrenderableComponent(name: string | undefined, component: unknown): Error {
  const label = name === undefined ? describeComponent(component) : `<${name}>`;
  const framework = foreignElementFramework(component);
  if (framework !== null) {
    return new Error(
      `pletivo cannot render ${framework} components: ${label} is a ${framework} component object ` +
        `(${describeComponent(component)}). ${FRAMEWORK_RENDERERS_UNSUPPORTED}`,
    );
  }
  if (isImageImport(component)) {
    return new Error(
      `pletivo cannot render ${label}: it is an image import, which pletivo does not render as a component ` +
        `(Astro renders an imported SVG inline). Use <img src={${name ?? "image"}.src}> instead.`,
    );
  }
  return new Error(
    `pletivo cannot render ${label}: a component must be a function, an .astro component or an element name, ` +
      `not ${component === null ? "null" : `a value of type ${typeof component}`}.`,
  );
}

/** What an image import evaluates to: `ImageMetadata`, `{ src, width, height, format }`. */
function isImageImport(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "src") === "string" &&
    typeof Reflect.get(value, "format") === "string"
  );
}

function describeComponent(type: unknown): string {
  if (typeof type === "string") return `<${type}>`;
  if (typeof type === "function") return type.name ? `<${type.name}>` : "an anonymous component";
  if (typeof type === "object" && type !== null) {
    for (const key of ["displayName", "name", "__name"]) {
      const name = Reflect.get(type, key);
      if (typeof name === "string" && name) return `<${name}>`;
    }
    const marker = Reflect.get(type, "$$typeof");
    if (typeof marker === "symbol") return marker.description ?? "an unnamed component";
  }
  return "an unnamed component";
}

function extensionOf(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
