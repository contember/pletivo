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

/** What a module's `@jsxImportSource` pragmas tell, read without parsing it. */
export type JsxImportSourcePragma =
  /** No pragma: the tsconfig decides. */
  | { kind: "none" }
  /** Set by the module's leading comments, the last of them winning, as in Bun. */
  | { kind: "leading"; importSource: string }
  /**
   * The text occurs after the first statement. Bun honours a pragma in any comment, the
   * last one winning, and telling a comment from a string there needs a parser.
   */
  | { kind: "unknown" };

const PRAGMA = /@jsxImportSource\s+([^\s*]+)/g;

export function jsxImportSourcePragma(source: string): JsxImportSourcePragma {
  let rest = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let importSource: string | null = null;
  for (;;) {
    rest = rest.trimStart();
    let comment: string;
    if (rest.startsWith("//")) {
      const end = rest.indexOf("\n");
      comment = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? "" : rest.slice(end);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) return { kind: "unknown" };
      comment = rest.slice(0, end);
      rest = rest.slice(end + 2);
    } else {
      break;
    }
    for (const match of comment.matchAll(PRAGMA)) importSource = match[1];
  }
  if (rest.includes("@jsxImportSource")) return { kind: "unknown" };
  return importSource === null ? { kind: "none" } : { kind: "leading", importSource };
}

/** The refusal of `file`, compiled for `framework` by `importSource` as set by `origin`. */
export function foreignJsxMessage(framework: string, file: string, importSource: string, origin: string): string {
  return `pletivo cannot render ${framework} components: ${file} (jsxImportSource "${importSource}", set by ${origin})`;
}
