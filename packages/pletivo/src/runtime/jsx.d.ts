declare namespace JSX {
  type Element = import("./html-string").HtmlString | Promise<import("./html-string").HtmlString>;

  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }

  interface ElementChildrenAttribute {
    children: {};
  }
}
