import { describe, expect, test } from "bun:test";
import { markdownModule } from "../../packages/core/src/content/markdown-module";

function compile(source: string, file: string, root = ""): string {
  return markdownModule({ source, file, label: file, root, base: "/", runtime: "runtime", markdown: "markdown" });
}

function line(code: string, prefix: string): string | undefined {
  return code.split("\n").find((entry) => entry.startsWith(prefix));
}

describe("markdownModule", () => {
  test("imports a relative layout as written", () => {
    const code = compile("---\nlayout: ../layouts/Post.astro\n---\n\nx\n", "src/pages/a.md");
    expect(line(code, "import $$Layout")).toBe('import $$Layout from "../layouts/Post.astro";');
  });

  test("makes a root-relative layout relative to the page, for project paths and absolute ones", () => {
    const source = "---\nlayout: /src/layouts/Post.astro\n---\n\nx\n";
    const expected = 'import $$Layout from "../../layouts/Post.astro";';
    expect(line(compile(source, "src/pages/docs/a.md"), "import $$Layout")).toBe(expected);
    expect(line(compile(source, "/site/src/pages/docs/a.md", "/site"), "import $$Layout")).toBe(expected);
  });

  test("imports no layout and gives a page without one the minimal document", () => {
    const code = compile("---\ntitle: A\n---\n\nx\n", "src/pages/a.md");
    expect(code).not.toContain("$$Layout from");
    expect(line(code, "export default")).toBe("export default $$markdownDocument($$page);");
    // Not a page: its default export is the content, as in Astro.
    expect(line(compile("x\n", "src/content/a.md"), "export default")).toBe("export default Content;");
  });

  test("gives a page Astro's url and any other file none", () => {
    expect(line(compile("x\n", "src/pages/docs/a.md"), "export const url")).toBe('export const url = "/docs/a";');
    expect(line(compile("x\n", "src/pages/docs/index.md"), "export const url")).toBe('export const url = "/docs";');
    expect(line(compile("x\n", "src/content/a.md"), "export const url")).toBe("export const url = undefined;");
  });

  test("keeps import.meta.env in the Markdown as text", () => {
    const code = compile("Use `import.meta.env.SITE`.\n", "src/pages/a.md");
    expect(code).not.toContain("import.meta.env");
    expect(code).toContain("import\\u002Emeta.env.SITE");
  });

  test("names the file when layout: is not a path", () => {
    expect(() => compile("---\nlayout: [a]\n---\n", "src/pages/a.md")).toThrow(
      'src/pages/a.md: `layout:` in frontmatter must be a path to the layout component, got ["a"]',
    );
  });
});
