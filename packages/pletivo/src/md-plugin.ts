/**
 * Bun plugin that loads `.md` files as modules, as Astro does: a page renders through
 * its module like any other, inside the layout its `layout:` frontmatter names.
 * The Markdown itself renders when the page does, with the plugins `configureMarkdown`
 * installed (`compiledContent()`), so a page restored from the incremental cache pays nothing.
 *
 * Call `registerMdPlugin()` and `configureMdModules()` before any `.md` is imported.
 */

import path from "path";
import { fileURLToPath } from "url";
import { markdownModule } from "@pletivo/core/content/markdown-module";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import { recordAstroImports } from "./astro-css-order";
import { collectCssSideEffectImports } from "./js-imported-css";

const markdownContentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "markdown-content.ts");

let registered = false;
let settings: { projectRoot: string; base: string; trailingSlash: string | undefined; astro: boolean } | null = null;

/** The project a `.md` module's root-relative `layout:` and its `url` are read against; `astro` when it is an Astro project. */
export function configureMdModules(projectRoot: string, base: string, trailingSlash: string | undefined, astro: boolean): void {
  settings = { projectRoot, base, trailingSlash, astro };
}

export async function registerMdPlugin(): Promise<void> {
  if (registered) return;
  registered = true;
  await Bun.plugin({
    name: "pletivo-md",
    setup(build) {
      build.onLoad({ filter: /\.md(\?.*)?$/ }, async (args) => {
        const file = stripQuery(args.path);
        const source = await Bun.file(file).text();
        // Vite's `?raw` / `?inline`: the file's text, not the compiled module.
        if (/\?(raw|inline)\b/.test(args.path)) return { contents: `export default ${JSON.stringify(source)};`, loader: "js" };
        const code = compileMdModule(source, file);
        // The layout is an import, so the CSS walks follow it from the page as from an `.astro` page.
        recordAstroImports(file, code);
        const relative = path.relative(settings?.projectRoot ?? process.cwd(), file);
        await collectCssSideEffectImports(file, code, `md:${relative}`);
        return { contents: cacheBustImports(code, getDevVersion()), loader: "js" };
      });
    },
  });
}

/** Dev cache busting on the import lines only: the Markdown, a string literal, may show an import as text. */
export function cacheBustImports(code: string, version: number): string {
  return code
    .split("\n")
    .map((line) => (line.startsWith("import ") ? applyDevCacheBust(line, version) : line))
    .join("\n");
}

/** The module Bun loads for the `.md` file at `file`. */
export function compileMdModule(source: string, file: string): string {
  const projectRoot = settings?.projectRoot ?? process.cwd();
  return markdownModule({
    source,
    file,
    label: path.relative(projectRoot, file),
    root: projectRoot,
    base: settings?.base ?? "/",
    trailingSlash: settings?.trailingSlash,
    astro: settings?.astro ?? false,
    runtime: markdownContentPath,
    markdown: markdownContentPath,
  });
}
