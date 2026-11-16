/**
 * Components of the UI frameworks Astro renders through its renderer protocol
 * (`addRenderer`). pletivo does not implement that protocol: it renders `.astro`
 * components and JSX compiled for its own runtime, so a framework component has
 * to fail by name rather than render as something else.
 */

const FRAMEWORK_BY_EXTENSION: Record<string, string> = {
  ".svelte": "Svelte",
  ".vue": "Vue",
};

/** Why the error is not a bug in the component, appended to every refusal. */
export const FRAMEWORK_RENDERERS_UNSUPPORTED =
  "Astro renders these through framework renderers, which pletivo does not implement; " +
  "it renders .astro components and JSX compiled for its own runtime (jsxImportSource \"pletivo\").";

/** The framework a component file belongs to by its extension, e.g. `Svelte` for `.svelte`. */
export function frameworkOfFile(file: string): string | null {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return null;
  return FRAMEWORK_BY_EXTENSION[file.slice(dot).toLowerCase()] ?? null;
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
      : `pletivo cannot render ${tag} as a component: an imported file without a JavaScript module is not one.`,
  );
}
