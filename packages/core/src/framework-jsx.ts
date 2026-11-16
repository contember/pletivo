/**
 * JSX compiled for another framework's runtime, named by its `jsxImportSource`.
 * Such JSX never renders under pletivo — React's hooks throw outside a React
 * render, Solid has no runtime `jsxDEV`, Preact and Vue return vnodes — so both
 * hosts refuse the file by name.
 */

/** `jsxImportSource` values whose JSX only that framework's renderer can render. */
const FRAMEWORK_BY_JSX_IMPORT_SOURCE: Record<string, string> = {
  react: "React",
  preact: "Preact",
  "solid-js": "Solid",
  vue: "Vue",
};

export function frameworkOfJsxImportSource(importSource: string): string | null {
  return FRAMEWORK_BY_JSX_IMPORT_SOURCE[importSource] ?? null;
}

/**
 * The `@jsxImportSource` pragma of a module, read from its leading comments only:
 * the same text in a string or after the first statement is not a pragma here.
 */
export function jsxImportSourcePragma(source: string): string | null {
  let rest = source.startsWith("﻿") ? source.slice(1) : source;
  for (;;) {
    rest = rest.trimStart();
    let comment: string;
    if (rest.startsWith("//")) {
      const end = rest.indexOf("\n");
      comment = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? "" : rest.slice(end);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) return null;
      comment = rest.slice(0, end);
      rest = rest.slice(end + 2);
    } else {
      return null;
    }
    const pragma = /@jsxImportSource\s+([^\s*]+)/.exec(comment);
    if (pragma) return pragma[1];
  }
}

/** The refusal of `file`, compiled for `framework` by `importSource` as set by `origin`. */
export function foreignJsxMessage(framework: string, file: string, importSource: string, origin: string): string {
  return `pletivo cannot render ${framework} components: ${file} (jsxImportSource "${importSource}", set by ${origin})`;
}
