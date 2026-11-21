// Port of Astro's `rehypeHeadingIds`, for MDX and for `.md` in an Astro project: a heading without
// a string `id` gets a unique github-slugger slug of its text. Unlike Astro, a `{frontmatter.x}`
// heading slugs the expression's source: pletivo's MDX has no `frontmatter` binding.
import Slugger from "github-slugger";
import type { Transformer } from "unified";

export interface MdxHeadingIdsOptions {
  /** Astro's `experimental.headingIdCompat`: keep a trailing `-` in the slug. */
  experimentalHeadingIdCompat?: boolean;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

// The node types whose `value` is heading text in an MDX file.
const TEXT_NODE_TYPES = new Set(["text", "raw", "mdxTextExpression"]);
// A `raw` node that is a whole tag is markup, not text.
const RAW_TAG = /^\n?<.*>\n?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isElement(node: unknown): node is HastElement {
  return isRecord(node) && node.type === "element" && typeof node.tagName === "string";
}

function childrenOf(node: unknown): unknown[] {
  return isRecord(node) && Array.isArray(node.children) ? node.children : [];
}

/** Every element of the tree, in document order. */
function visitElements(node: unknown, visit: (element: HastElement) => void): void {
  if (isElement(node)) visit(node);
  for (const child of childrenOf(node)) visitElements(child, visit);
}

/** The heading's text, from its descendants (not the heading itself), as Astro collects it for MDX. */
function headingText(heading: HastElement): string {
  let text = "";
  const collect = (node: unknown): void => {
    for (const child of childrenOf(node)) {
      if (isRecord(child) && !isElement(child) && typeof child.type === "string" && typeof child.value === "string") {
        const skip = child.type === "raw" && RAW_TAG.test(child.value);
        if (!skip && TEXT_NODE_TYPES.has(child.type)) text += child.value;
      }
      collect(child);
    }
  };
  collect(heading);
  return text;
}

export function rehypeMdxHeadingIds(options: MdxHeadingIdsOptions = {}): Transformer {
  return (tree) => {
    const slugger = new Slugger();
    visitElements(tree, (node) => {
      if (node.tagName[0] !== "h" || !/h([0-6])/.test(node.tagName)) return;
      const properties = (node.properties ??= {});
      if (typeof properties.id === "string") return;
      let slug = slugger.slug(headingText(node));
      if (!options.experimentalHeadingIdCompat && slug.endsWith("-")) slug = slug.slice(0, -1);
      properties.id = slug;
    });
  };
}
