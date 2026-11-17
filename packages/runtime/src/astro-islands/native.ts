/**
 * Components pletivo renders itself: `Fragment`, an entry's `Content`, an MDX module.
 * Astro never offers its equivalents to a renderer's `check`, and React's `check` would
 * spend a prefix id on them. A global symbol, so core and compiled modules can set it
 * without importing the runtime.
 */
export const NATIVE_COMPONENT = Symbol.for("pletivo.native-component");

export function markNativeComponent<T extends object>(component: T): T {
  Object.defineProperty(component, NATIVE_COMPONENT, { value: true });
  return component;
}

export function isNativeComponent(value: unknown): boolean {
  return typeof value === "function" && NATIVE_COMPONENT in value;
}

/** pletivo's own island syntax (`client="load"`), which its own island path renders. */
export function hasPletivoClientProp(props: Record<string, unknown>): boolean {
  return "client" in props;
}
