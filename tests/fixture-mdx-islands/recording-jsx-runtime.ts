/** Stands in for pletivo's JSX runtime in compiled MDX: records each component call's props. */
export interface RecordedCall {
  /** The function's name; empty for an object, such as a module namespace. */
  component: string;
  props: Record<string, unknown>;
}

export const calls: RecordedCall[] = [];

export function Fragment(): string {
  return "";
}

export function jsx(tag: unknown, props: Record<string, unknown>): string {
  if (typeof tag !== "string" && tag !== Fragment) {
    const { children: _children, ...rest } = props;
    calls.push({ component: typeof tag === "function" ? tag.name : "", props: rest });
  }
  return "";
}

export { jsx as jsxs };
