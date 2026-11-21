/**
 * Bun plugin that loads `.html` files as Astro does (`vite-plugin-html`): a component, or a page
 * under `src/pages/`, whose output is the file's text with each `<slot>` replaced by the content
 * passed for it. Only in an Astro project; elsewhere `.html` keeps Bun's own meaning.
 */
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "@astrojs/compiler";
import type { Node } from "@astrojs/compiler/types";
import type { HtmlComponentPart } from "@pletivo/runtime/astro-shim";
import { stripQuery } from "@pletivo/core/dev-cache";

const htmlContentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "html-content.ts");

let registered = false;

export async function registerHtmlPlugin(): Promise<void> {
  if (registered) return;
  registered = true;
  await Bun.plugin({
    name: "pletivo-html",
    setup(build) {
      build.onLoad({ filter: /\.html(\?.*)?$/ }, async (args) => {
        const source = await Bun.file(stripQuery(args.path)).text();
        // Vite's `?raw` / `?inline`: the file's text, not the component.
        if (/\?(raw|inline)\b/.test(args.path)) return { contents: `export default ${JSON.stringify(source)};`, loader: "js" };
        return { contents: await compileHtmlModule(source), loader: "js" };
      });
    },
  });
}

/** The module Bun loads for an `.html` file. */
export async function compileHtmlModule(source: string): Promise<string> {
  const parts = await htmlComponentParts(source);
  return `import { htmlComponent } from ${JSON.stringify(htmlContentPath)};\nexport default htmlComponent(${JSON.stringify(parts)});\n`;
}

interface SlotSite {
  start: number;
  end: number;
  name: string;
  fallback: string;
}

/**
 * The file split at its `<slot>` elements, as Astro's `rehypeSlots` splits it: a slot with
 * `is:inline` stays text, and a slot falls back to its trimmed children, or to itself when empty.
 */
export async function htmlComponentParts(source: string): Promise<HtmlComponentPart[]> {
  // The parser's offsets count UTF-8 bytes.
  const bytes = Buffer.from(source);
  const text = (start: number, end: number) => bytes.subarray(start, end).toString();
  const { ast } = await parse(source, { position: true });
  const sites: SlotSite[] = [];
  const visit = (node: Node): void => {
    if (node.type === "element" && node.name === "slot" && !node.attributes.some((a) => a.name === "is:inline")) {
      const start = node.position?.start.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        const first = node.children.at(0) ?? node;
        const last = node.children.at(-1) ?? node;
        const fallback = text(first.position?.start.offset ?? 0, last.position?.end?.offset ?? 0).trim();
        const name = node.attributes.find((a) => a.name === "name")?.value ?? "default";
        sites.push({ start, end, name, fallback });
        return;
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(ast);

  const parts: HtmlComponentPart[] = [];
  let at = 0;
  for (const site of sites) {
    if (site.start > at) parts.push(text(at, site.start));
    parts.push({ slot: site.name, fallback: site.fallback });
    at = site.end;
  }
  if (at < bytes.length) parts.push(text(at, bytes.length));
  return parts;
}
