declare namespace JSX {
  type Element = import("./jsx-runtime").HtmlString | Promise<import("./jsx-runtime").HtmlString>;

  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }

  interface ElementChildrenAttribute {
    children: {};
  }
}
