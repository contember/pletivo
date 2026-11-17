// Port of `@astrojs/mdx`'s `shouldAddCharset` (`rehype-apply-frontmatter-export.ts`): an MDX page
// gets `<meta charset="utf-8">` ahead of its content, as a Markdown page does. pletivo refuses a page
// with `layout:` frontmatter, so Astro's layout branch, which skips the charset, has no counterpart.
import type { Transformer } from "unified";
import { isRouteFile } from "@pletivo/core/router";

const EXPORT_CONST_PARTIAL_TRUE = /export\s+const\s+partial\s*=\s*true/;

interface Parent {
  children: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParent(node: unknown): node is Parent {
  return isRecord(node) && Array.isArray(node.children);
}

function shouldAddCharset(children: unknown[], filePath: string, pagesDir: string): boolean {
  const partial = children.some(
    (node) => isRecord(node) && node.type === "mdxjsEsm" && typeof node.value === "string" && EXPORT_CONST_PARTIAL_TRUE.test(node.value),
  );
  if (partial) return false;

  if (!filePath.startsWith(pagesDir)) return false;
  if (!isRouteFile(filePath.slice(pagesDir.length))) return false;

  // A leading component is taken for a wrapping layout, which writes its own `<head>`.
  for (const node of children) {
    if (!isRecord(node)) continue;
    if (node.type === "element") break;
    if (node.type === "mdxJsxFlowElement") {
      if (typeof node.name !== "string") break;
      if (node.name[0] === node.name[0].toLowerCase()) break;
      return false;
    }
  }
  return true;
}

/** `pagesDir` is the Astro project's `src/pages`, absolute. */
export function rehypeMdxPageCharset(options: { pagesDir: string }): Transformer {
  const pagesDir = options.pagesDir.replace(/\\/g, "/");
  return (tree, file) => {
    if (!isParent(tree) || !file.path) return;
    const filePath = file.path.replace(/\\/g, "/");
    if (!shouldAddCharset(tree.children, filePath, pagesDir)) return;
    tree.children.unshift({
      type: "mdxJsxFlowElement",
      name: "meta",
      attributes: [{ type: "mdxJsxAttribute", name: "charset", value: "utf-8" }],
      children: [],
    });
  };
}
