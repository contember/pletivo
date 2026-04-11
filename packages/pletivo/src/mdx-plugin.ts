/**
 * Bun plugin that teaches the runtime how to import `.mdx` files.
 *
 * On each `.mdx` import:
 *  - reads the source
 *  - strips YAML frontmatter (so it doesn't interfere with MDX compilation)
 *  - runs `@mdx-js/mdx`'s `compile()` with `jsxImportSource: "pletivo"`
 *  - returns the generated JS code to Bun
 *
 * The compiled module exports a default component function. When called,
 * it renders through pletivo's JSX runtime and returns an `HtmlString`.
 *
 * Call `registerMdxPlugin()` once at process start — before any `.mdx`
 * file is imported.
 */

import path from "path";
import { fileURLToPath } from "url";
import { compile, type CompileOptions } from "@mdx-js/mdx";
import { getDevVersion } from "./astro-plugin";
import type { PluggableList } from "unified";
import type { PletivoConfig } from "./config";

// Resolve absolute path to pletivo's jsx-runtime so compiled MDX can
// import it even when pletivo isn't installed as a node_modules dep
// (e.g. running from source via `bun ~/pletivo/src/cli.ts build`).
const pletivoSrcDir = path.dirname(fileURLToPath(import.meta.url));
const jsxRuntimePath = path.resolve(pletivoSrcDir, "runtime/jsx-runtime.ts");

export interface MdxOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
}

let registered = false;
let userOptions: MdxOptions = {};

export function configureMdx(options: MdxOptions): void {
  userOptions = options;
}

/**
 * Merge MDX options from Astro config (`markdown.remarkPlugins` /
 * `markdown.rehypePlugins`) and pletivo config (`mdx.remarkPlugins` /
 * `mdx.rehypePlugins`). Pletivo-specific config is appended after
 * Astro's, so it runs later in the pipeline.
 */
export function resolveMdxOptions(
  pletivoConfig: PletivoConfig,
  astroConfig?: { markdown?: { remarkPlugins?: PluggableList; rehypePlugins?: PluggableList }; [key: string]: unknown } | null,
): MdxOptions {
  const astroMarkdown = astroConfig?.markdown;
  const remarkPlugins: PluggableList = [
    ...(astroMarkdown?.remarkPlugins ?? []),
    ...(pletivoConfig.mdx?.remarkPlugins ?? []),
  ];
  const rehypePlugins: PluggableList = [
    ...(astroMarkdown?.rehypePlugins ?? []),
    ...(pletivoConfig.mdx?.rehypePlugins ?? []),
  ];
  return {
    ...(remarkPlugins.length ? { remarkPlugins } : {}),
    ...(rehypePlugins.length ? { rehypePlugins } : {}),
  };
}

export async function registerMdxPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  await Bun.plugin({
    name: "pletivo-mdx",
    setup(build) {
      build.onLoad({ filter: /\.mdx(\?.*)?$/ }, async (args) => {
        const cleanPath = args.path.replace(/\?.*$/, "");
        const rel = path.relative(process.cwd(), cleanPath);
        const source = await Bun.file(cleanPath).text();

        // Strip YAML frontmatter before MDX compilation
        const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        const body = fmMatch ? fmMatch[2] : source;

        let code: string;
        try {
          const compileOptions: CompileOptions = {
            jsxImportSource: "pletivo",
            development: false,
          };
          if (userOptions.remarkPlugins?.length) {
            compileOptions.remarkPlugins = userOptions.remarkPlugins;
          }
          if (userOptions.rehypePlugins?.length) {
            compileOptions.rehypePlugins = userOptions.rehypePlugins;
          }
          const result = await compile(body, compileOptions);
          code = String(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`MDX compilation error in ${rel}:\n${msg}`);
        }

        // Rewrite bare `pletivo/jsx-runtime` to an absolute path so the
        // import resolves even when pletivo is run from source.
        code = code.replace(
          /(from\s+["'])pletivo\/jsx-runtime(["'])/g,
          `$1${jsxRuntimePath}$2`,
        );

        // In dev mode, append version query to .astro imports for cache
        // busting (same as the astro plugin does for its own output).
        const devVersion = getDevVersion();
        if (devVersion > 0) {
          code = code.replace(
            /(from\s+['"])([^'"]+\.astro)(['"])/g,
            `$1$2?v=${devVersion}$3`,
          );
        }

        return {
          contents: code,
          loader: "js",
        };
      });
    },
  });
}
