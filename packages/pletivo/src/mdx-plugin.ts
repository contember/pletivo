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
import { compile, nodeTypes, type CompileOptions } from "@mdx-js/mdx";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import type { PletivoConfig } from "./config";
import { substituteImportMetaEnv } from "./import-meta-env";
import type { AstroIntegration } from "@pletivo/core/astro-host/types";
import { astroMarkdownSettings, splitFrontmatter, type AstroMarkdownConfig } from "@pletivo/core/content/markdown";
import { rehypeMdxHeadingIds } from "@pletivo/core/content/mdx-heading-ids";
import { rehypeAstroIslandMetadata } from "./mdx-island-metadata";
import { rehypeMdxPageCharset } from "./mdx-page-charset";
import {
  astroHighlightPlugins,
  parseShikiConfig,
  parseSyntaxHighlight,
  rehypeMdxMetaString,
  type SyntaxHighlight,
} from "./mdx-syntax-highlight";

// Resolve absolute path to pletivo's jsx-runtime so compiled MDX can
// import it even when pletivo isn't installed as a node_modules dep
// (e.g. running from source via `bun ~/pletivo/src/cli.ts build`).
const pletivoSrcDir = path.dirname(fileURLToPath(import.meta.url));
const jsxRuntimePath = path.resolve(pletivoSrcDir, "runtime/jsx-runtime.ts");
const mdxContentPath = path.resolve(pletivoSrcDir, "mdx-content.ts");

// `unified`'s `PluggableList` isn't re-exported by @mdx-js/mdx and `unified`
// itself isn't a direct dependency (only resolvable transitively), so derive
// the type from the published `CompileOptions` instead of importing it.
export type PluggableList = NonNullable<CompileOptions["remarkPlugins"]>;

export interface MdxOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** GitHub Flavored Markdown — on by default, matching Astro/@astrojs/mdx. */
  gfm?: boolean;
  /** Set in an Astro project only: its MDX gets `@astrojs/mdx`'s heading ids, `components` export and page charset. */
  astro?: AstroMdxSettings;
}

export interface AstroMdxSettings {
  /** The project root, absolute: Astro's highlighters load from its `astro`. */
  projectRoot: string;
  /** The project's `src/pages`, absolute. */
  pagesDir: string;
  /** Astro's `experimental.headingIdCompat`. */
  experimentalHeadingIdCompat: boolean;
  /** Astro's `markdown.syntaxHighlight`. */
  syntaxHighlight: SyntaxHighlight;
  /** Astro's `markdown.shikiConfig`. */
  shikiConfig: Record<string, unknown>;
}

/**
 * remark/rehype plugins extracted from a user's `mdx({...})` call in their
 * astro config, plus any options pletivo's native MDX compiler can't honor.
 * Surfaced on the loaded config under `MDX_INTEGRATION_OPTIONS_KEY`.
 */
export interface CapturedMdxIntegrationOptions {
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  /** `mdx({ gfm })` override, if the user set one (else undefined). */
  gfm?: boolean;
  unsupportedKeys: string[];
}

/** Key under which captured `mdx()` options are stashed on the AstroConfig. */
export const MDX_INTEGRATION_OPTIONS_KEY = "__pletivoMdxIntegrationOptions";

/** `mdx({...})` options that map onto pletivo's native compiler. */
const HONORED_MDX_OPTION_KEYS = new Set(["remarkPlugins", "rehypePlugins", "gfm"]);

// Matches any file inside an installed @astrojs/mdx package. The trailing
// separator means it won't match siblings like `@astrojs/mdx-*`.
const MDX_PACKAGE_FILTER = /[\/\\]@astrojs[\/\\]mdx[\/\\]/;
// Source pletivo substitutes for @astrojs/mdx's entry. pletivo compiles MDX
// natively, so the real package is never run — this stub only exposes the
// options a user passed to `mdx({...})` so the host can forward the
// remark/rehype plugins (see captureMdxIntegrationOptions).
const MDX_STUB_SOURCE = `
export default function mdx(options = {}) {
  return { name: "@astrojs/mdx", __pletivoMdxOptions: options || {} };
}
`;

let registered = false;
let userOptions: MdxOptions = {};

export function configureMdx(options: MdxOptions): void {
  userOptions = options;
}

/**
 * Read the remark/rehype plugins (and `gfm` flag) a user passed to `mdx({...})`
 * in their astro config off the (stubbed) integration object. Returns null when
 * the integration carries no recognizable options. Any keys pletivo's native
 * MDX compiler can't honor (e.g. `optimize`, `recmaPlugins`, `syntaxHighlight`)
 * are reported in `unsupportedKeys` so the caller can warn about them.
 */
export function captureMdxIntegrationOptions(
  integration: AstroIntegration,
): CapturedMdxIntegrationOptions | null {
  const opts = (integration as { __pletivoMdxOptions?: unknown }).__pletivoMdxOptions;
  if (!opts || typeof opts !== "object") return null;
  const record = opts as Record<string, unknown>;
  const remarkPlugins = Array.isArray(record.remarkPlugins) ? (record.remarkPlugins as PluggableList) : [];
  const rehypePlugins = Array.isArray(record.rehypePlugins) ? (record.rehypePlugins as PluggableList) : [];
  const gfm = typeof record.gfm === "boolean" ? record.gfm : undefined;
  const unsupportedKeys = Object.keys(record).filter(
    (k) => !HONORED_MDX_OPTION_KEYS.has(k) && record[k] != null,
  );
  return { remarkPlugins, rehypePlugins, gfm, unsupportedKeys };
}

/**
 * Merge MDX options from three sources, in pipeline order:
 *  1. Astro config `markdown` plugins, a `unified()` processor's included (astroMarkdownSettings)
 *  2. Plugins passed to the `mdx({...})` integration (captured by the host
 *     and stashed under `MDX_INTEGRATION_OPTIONS_KEY`) — mirrors Astro, where
 *     @astrojs/mdx extends the top-level markdown config with its own plugins
 *  3. Pletivo-specific `mdx.remarkPlugins` / `mdx.rehypePlugins`
 *
 * Later sources run later in the unified pipeline. Plugins are de-duplicated by
 * function reference (first occurrence wins) so a plugin listed in both
 * `markdown.*` and `mdx({...})` — common when a meta-framework configures both —
 * runs once rather than twice.
 */
export function resolveMdxOptions(
  pletivoConfig: PletivoConfig,
  astroConfig?: { markdown?: AstroMarkdownConfig; root?: URL; srcDir?: URL; [key: string]: unknown } | null,
): MdxOptions {
  const astroMarkdown = astroMarkdownSettings(astroConfig);
  const mdxIntegration = astroConfig?.[MDX_INTEGRATION_OPTIONS_KEY] as
    | { remarkPlugins?: PluggableList; rehypePlugins?: PluggableList; gfm?: boolean }
    | undefined;
  const remarkPlugins = dedupePlugins([
    ...(astroMarkdown?.remarkPlugins ?? []),
    ...(mdxIntegration?.remarkPlugins ?? []),
    ...(pletivoConfig.mdx?.remarkPlugins ?? []),
  ]);
  const rehypePlugins = dedupePlugins([
    ...(astroMarkdown?.rehypePlugins ?? []),
    ...(mdxIntegration?.rehypePlugins ?? []),
    ...(pletivoConfig.mdx?.rehypePlugins ?? []),
  ]);
  return {
    // Precedence mirrors @astrojs/mdx: an explicit `mdx({ gfm })` wins over
    // top-level `markdown.gfm`, which defaults to on.
    gfm: mdxIntegration?.gfm ?? astroMarkdown?.gfm ?? true,
    ...(remarkPlugins.length ? { remarkPlugins } : {}),
    ...(rehypePlugins.length ? { rehypePlugins } : {}),
    ...(astroConfig?.srcDir ? { astro: astroMdxSettings(astroConfig) } : {}),
  };
}

function astroMdxSettings(astroConfig: { markdown?: unknown; root?: URL; srcDir?: URL; experimental?: unknown }): AstroMdxSettings {
  const { root, srcDir, experimental, markdown } = astroConfig;
  if (!root || !srcDir) throw new Error("astro config: root and srcDir must be set");
  const headingIdCompat = experimental && typeof experimental === "object" ? Reflect.get(experimental, "headingIdCompat") : undefined;
  if (headingIdCompat !== undefined && typeof headingIdCompat !== "boolean") {
    throw new Error(`astro config: experimental.headingIdCompat must be a boolean, got ${JSON.stringify(headingIdCompat)}`);
  }
  const markdownRecord = markdown && typeof markdown === "object" ? markdown : {};
  return {
    projectRoot: fileURLToPath(root),
    pagesDir: path.join(fileURLToPath(srcDir), "pages"),
    experimentalHeadingIdCompat: headingIdCompat ?? false,
    syntaxHighlight: parseSyntaxHighlight(Reflect.get(markdownRecord, "syntaxHighlight"), "astro config: markdown"),
    shikiConfig: parseShikiConfig(Reflect.get(markdownRecord, "shikiConfig"), "astro config: markdown"),
  };
}

/** Extract the plugin function from a `Pluggable` (`fn` or `[fn, ...opts]`). */
function pluginFn(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

/**
 * De-duplicate a plugin list by function reference, keeping the first
 * occurrence (and its options). Prevents a plugin configured in more than one
 * source — e.g. both `markdown.*` and `mdx({...})` — from running twice.
 */
function dedupePlugins(plugins: PluggableList): PluggableList {
  const seen = new Set<unknown>();
  const out: PluggableList = [];
  for (const entry of plugins) {
    const fn = pluginFn(entry);
    if (seen.has(fn)) continue;
    seen.add(fn);
    out.push(entry);
  }
  return out;
}

/** True for `remark-gfm` in any form (reference or function name). */
function isRemarkGfm(entry: unknown): boolean {
  const fn = pluginFn(entry);
  return fn === remarkGfm || (typeof fn === "function" && fn.name === "remarkGfm");
}

/**
 * Assemble the remark pipeline for MDX, mirroring `@astrojs/mdx`: prepend
 * `remark-gfm` (unless disabled) so GFM features — tables, strikethrough,
 * autolinks — work, then the user's remark plugins. If the user already
 * configured their own `remark-gfm`, theirs is kept (with its options) and we
 * don't add a second copy.
 */
export function buildRemarkPlugins(userRemark: PluggableList | undefined, gfm: boolean): PluggableList {
  const user = userRemark ?? [];
  if (gfm && !user.some(isRemarkGfm)) return [remarkGfm, ...user];
  return [...user];
}

/**
 * True for `rehype-raw` in any form. A *bare* `rehype-raw` re-parses the whole
 * tree through hast-util-raw and throws on MDX's JSX nodes (`mdxJsxFlowElement`
 * etc.). We supply our own `rehype-raw` configured with `passThrough: nodeTypes`
 * (see buildRehypePlugins), so any user-forwarded copy must be dropped.
 */
function isRehypeRaw(entry: unknown): boolean {
  const fn = pluginFn(entry);
  return fn === rehypeRaw || (typeof fn === "function" && fn.name === "rehypeRaw");
}

/**
 * Assemble the rehype pipeline for MDX, mirroring `@astrojs/mdx`: always
 * prepend `[rehypeRaw, { passThrough: nodeTypes }]` so embedded raw HTML is
 * handled while MDX's own JSX/expression nodes pass through untouched, then
 * append the user's rehype plugins with any bare `rehype-raw` stripped (it
 * can't run on MDX and our managed copy supersedes it).
 */
export function buildRehypePlugins(userRehype: PluggableList | undefined, highlight: PluggableList = []): PluggableList {
  const user = (userRehype ?? []).filter((p) => !isRehypeRaw(p));
  return [[rehypeRaw, { passThrough: nodeTypes }], ...highlight, ...user];
}

export async function registerMdxPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  await Bun.plugin({
    name: "pletivo-mdx",
    setup(build) {
      // Shadow @astrojs/mdx with a lightweight stub. pletivo compiles MDX
      // natively, so the real package is never run — but a user's astro config
      // still `import`s it and calls `mdx({ remarkPlugins })`. Replacing the
      // package's module with the stub exposes those options on the returned
      // integration object so the host can forward them into the native
      // compiler (see filterOverrides / captureMdxIntegrationOptions).
      //
      // We intercept on the resolved file path (onLoad) rather than the bare
      // specifier (onResolve): Bun's runtime resolver bypasses onResolve for
      // bare ESM imports, but onLoad reliably fires for locally-installed
      // packages.
      build.onLoad({ filter: MDX_PACKAGE_FILTER }, () => ({
        contents: MDX_STUB_SOURCE,
        loader: "js",
      }));

      build.onLoad({ filter: /\.mdx(\?.*)?$/ }, async (args) => {
        const cleanPath = stripQuery(args.path);
        const source = await Bun.file(cleanPath).text();
        return {
          contents: await compileMdx(source, cleanPath),
          loader: "js",
        };
      });
    },
  });
}

/** Compile one `.mdx` file's source to the JS module the Bun loader returns. */
export async function compileMdx(source: string, filePath: string): Promise<string> {
  const rel = path.relative(process.cwd(), filePath);

  // Strip YAML frontmatter before MDX compilation; the same split the page `layout:` check reads.
  const { body } = splitFrontmatter(source);

  let code: string;
  try {
    const compileOptions: CompileOptions = {
      jsxImportSource: "pletivo",
      development: false,
      // As @astrojs/mdx: hast attributes keep their HTML names (`class`, `tabindex`).
      ...(userOptions.astro ? { elementAttributeNameCase: "html" } : {}),
    };
    // Mirror @astrojs/mdx: GFM on by default (remark-gfm prepended),
    // then the user's remark plugins.
    compileOptions.remarkPlugins = buildRemarkPlugins(
      userOptions.remarkPlugins,
      userOptions.gfm !== false,
    );
    // A managed `rehype-raw` (passing MDX nodes through) always runs, with the user's rehype plugins
    // after it. An Astro project adds @astrojs/mdx's: the code-fence meta before `rehype-raw`, the
    // highlighter after it, heading ids and the page charset after the user's. The island metadata
    // runs last, as in @astrojs/mdx.
    const astro = userOptions.astro;
    const highlight = astro ? await astroHighlightPlugins(astro.projectRoot, astro.syntaxHighlight, astro.shikiConfig) : [];
    const astroPlugins: PluggableList = astro
      ? [
          [rehypeMdxHeadingIds, { experimentalHeadingIdCompat: astro.experimentalHeadingIdCompat }],
          [rehypeMdxPageCharset, { pagesDir: astro.pagesDir }],
        ]
      : [];
    compileOptions.rehypePlugins = [
      ...(astro ? [rehypeMdxMetaString] : []),
      ...buildRehypePlugins(userOptions.rehypePlugins, highlight),
      ...astroPlugins,
      rehypeAstroIslandMetadata,
    ];
    // The path lets the island metadata resolve relative imports, as Astro's does.
    const result = await compile({ value: body, path: filePath }, compileOptions);
    code = String(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`MDX compilation error in ${rel}:\n${msg}`);
  }

  // Rewrite bare `pletivo/jsx-runtime` to an absolute path so the
  // import resolves even when pletivo is run from source.
  code = code.replace(
    /(from\s+["'])pletivo\/jsx-runtime(["'])/g,
    (_match, open: string, close: string) => open + jsxRuntimePath + close,
  );

  // In dev mode, append version query to .astro and .json imports for
  // cache busting (same as the astro plugin does for its own output).
  // JSON needs this too so translation dictionaries reload on edit.
  code = applyDevCacheBust(substituteImportMetaEnv(code, "js"), getDevVersion());
  // The default export renders natively and hoists its islands' scripts (mdx-content.ts).
  const exported = "export default function MDXContent(";
  if (!code.includes(exported)) throw new Error(`MDX compilation of ${rel} produced no default MDXContent export`);
  code = code.replace(exported, "function MDXContent(");
  code += `\nimport { mdxContent as __pletivoMdxContent } from ${JSON.stringify(mdxContentPath)};\n`;
  if (userOptions.astro) {
    // As @astrojs/mdx's `Content`: `Fragment` and the module's `components` export, under the caller's.
    const exportsComponents = new Bun.Transpiler({ loader: "js" }).scan(code).exports.includes("components");
    code += `import { Fragment as __pletivoFragment } from ${JSON.stringify(jsxRuntimePath)};\n`;
    code += `export default __pletivoMdxContent(MDXContent, { Fragment: __pletivoFragment${exportsComponents ? ", ...components" : ""} });\n`;
  } else {
    code += "export default __pletivoMdxContent(MDXContent);\n";
  }
  return code;
}
