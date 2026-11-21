/**
 * Bun plugin that teaches the runtime how to import `.mdx` files.
 *
 * On each `.mdx` import it reads the source, compiles it with
 * `@pletivo/core/content/mdx` (the Workers host's compile too) and returns the
 * generated JS code to Bun.
 *
 * The compiled module exports a default component function. When called,
 * it renders through pletivo's JSX runtime and returns an `HtmlString`.
 *
 * Call `registerMdxPlugin()` once at process start — before any `.mdx`
 * file is imported.
 */

import path from "path";
import { fileURLToPath } from "url";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import type { PletivoConfig } from "./config";
import { substituteImportMetaEnv } from "./import-meta-env";
import type { AstroIntegration } from "@pletivo/core/astro-host/types";
import { astroMarkdownSettings, type AstroMarkdownConfig } from "@pletivo/core/content/markdown";
import {
  compileMdxSource,
  mdxModule,
  type CompiledMdx,
  type MdxCompileSettings,
  type PluggableList,
} from "@pletivo/core/content/mdx";
import { resolveComponentPath } from "./astro-plugin";
import { parseHeadingIdCompat } from "./astro-markdown";
import {
  astroHighlightPlugins,
  parseMdxShikiConfig,
  parseMdxSyntaxHighlight,
  parseShikiConfig,
  parseSyntaxHighlight,
  SYNTAX_HIGHLIGHT_DEFAULT,
  type AstroHighlight,
  type ShikiConfig,
  type SyntaxHighlight,
} from "./mdx-syntax-highlight";

export { buildRehypePlugins, buildRemarkPlugins, type PluggableList } from "@pletivo/core/content/mdx";

// Resolve absolute path to pletivo's jsx-runtime so compiled MDX can
// import it even when pletivo isn't installed as a node_modules dep
// (e.g. running from source via `bun ~/pletivo/src/cli.ts build`).
const pletivoSrcDir = path.dirname(fileURLToPath(import.meta.url));
const jsxRuntimePath = path.resolve(pletivoSrcDir, "runtime/jsx-runtime.ts");
const mdxContentPath = path.resolve(pletivoSrcDir, "mdx-content.ts");

export interface MdxOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** GitHub Flavored Markdown — on by default, matching Astro/@astrojs/mdx. */
  gfm?: boolean;
  /** Set in an Astro project only: its MDX gets `@astrojs/mdx`'s heading ids, `components` export and page charset. */
  astro?: AstroMdxSettings;
}

export interface AstroMdxSettings {
  /** The project's `src/pages`, absolute. */
  pagesDir: string;
  /** Astro's `experimental.headingIdCompat`. */
  experimentalHeadingIdCompat: boolean;
  /** `syntaxHighlight` and `shikiConfig`, from `mdx({...})` or else Astro's `markdown`. */
  highlight: AstroHighlight;
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
  /** `mdx({ syntaxHighlight })`, `mdx({ shikiConfig })` and `mdx({ extendMarkdownConfig })`, if set. */
  syntaxHighlight?: SyntaxHighlight;
  shikiConfig?: ShikiConfig;
  extendMarkdownConfig?: boolean;
  unsupportedKeys: string[];
}

/** Key under which captured `mdx()` options are stashed on the AstroConfig. */
export const MDX_INTEGRATION_OPTIONS_KEY = "__pletivoMdxIntegrationOptions";

/** `mdx({...})` options that map onto pletivo's native compiler. */
const HONORED_MDX_OPTION_KEYS = new Set([
  "remarkPlugins",
  "rehypePlugins",
  "gfm",
  "syntaxHighlight",
  "shikiConfig",
  "extendMarkdownConfig",
]);

const MDX_OPTIONS_SOURCE = "astro config: mdx({...})";

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
 * Parse the options of a user's `mdx({...})` off the stubbed integration, or null without any.
 * Keys pletivo's native MDX can't honor (`optimize`, `recmaPlugins`) land in `unsupportedKeys`.
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
  const { extendMarkdownConfig } = record;
  if (extendMarkdownConfig != null && typeof extendMarkdownConfig !== "boolean") {
    throw new Error(
      `${MDX_OPTIONS_SOURCE}.extendMarkdownConfig must be a boolean, got ${JSON.stringify(extendMarkdownConfig)}`,
    );
  }
  const unsupportedKeys = Object.keys(record).filter(
    (k) => !HONORED_MDX_OPTION_KEYS.has(k) && record[k] != null,
  );
  return {
    remarkPlugins,
    rehypePlugins,
    gfm,
    syntaxHighlight: parseMdxSyntaxHighlight(record.syntaxHighlight, MDX_OPTIONS_SOURCE),
    shikiConfig: parseMdxShikiConfig(record.shikiConfig, MDX_OPTIONS_SOURCE),
    extendMarkdownConfig: extendMarkdownConfig ?? undefined,
    unsupportedKeys,
  };
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
  const mdxIntegration = astroConfig?.[MDX_INTEGRATION_OPTIONS_KEY] as RecordedMdxIntegrationOptions | undefined;
  // As @astrojs/mdx: `mdx({ extendMarkdownConfig: false })` drops the `markdown` config.
  const extendMarkdownConfig = mdxIntegration?.extendMarkdownConfig ?? true;
  const astroMarkdown = extendMarkdownConfig ? astroMarkdownSettings(astroConfig) : undefined;
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
    ...(astroConfig?.srcDir ? { astro: astroMdxSettings(astroConfig, mdxIntegration, extendMarkdownConfig) } : {}),
  };
}

/** What `recordMdxIntegrationOptions` (astro-host) stashes under `MDX_INTEGRATION_OPTIONS_KEY`. */
export type RecordedMdxIntegrationOptions = Partial<Omit<CapturedMdxIntegrationOptions, "unsupportedKeys">>;

function astroMdxSettings(
  astroConfig: { markdown?: AstroMarkdownConfig; root?: URL; srcDir?: URL; experimental?: unknown },
  mdxIntegration: RecordedMdxIntegrationOptions | undefined,
  extendMarkdownConfig: boolean,
): AstroMdxSettings {
  const { root, srcDir, experimental, markdown } = astroConfig;
  if (!root || !srcDir) throw new Error("astro config: root and srcDir must be set");
  const syntaxHighlight = parseSyntaxHighlight(markdown?.syntaxHighlight, "astro config: markdown");
  const shikiConfig = parseShikiConfig(markdown?.shikiConfig, "astro config: markdown");
  return {
    pagesDir: path.join(fileURLToPath(srcDir), "pages"),
    experimentalHeadingIdCompat: parseHeadingIdCompat(experimental),
    highlight: {
      subject: "MDX",
      projectRoot: fileURLToPath(root),
      syntaxHighlight: mdxIntegration?.syntaxHighlight ?? (extendMarkdownConfig ? syntaxHighlight : SYNTAX_HIGHLIGHT_DEFAULT),
      shikiConfig: mdxIntegration?.shikiConfig ?? (extendMarkdownConfig ? shikiConfig : {}),
    },
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

/** What `compileMdx` compiles with; `highlight` is the highlighter's plugins. */
function compileSettings(options: MdxOptions, highlight: PluggableList): MdxCompileSettings {
  const astro = options.astro;
  return {
    remarkPlugins: options.remarkPlugins,
    rehypePlugins: options.rehypePlugins,
    gfm: options.gfm !== false,
    astro: astro
      ? { pagesDir: astro.pagesDir, experimentalHeadingIdCompat: astro.experimentalHeadingIdCompat, highlight }
      : null,
    resolveComponentPath,
  };
}

/**
 * One `.mdx` file compiled as `compileMdx` compiles it, for what `pletivo prepare` reads off it:
 * its imports and its hydrations. Unhighlighted: a highlighter touches neither.
 */
export function mdxSourceFacts(source: string, filePath: string, options: MdxOptions): Promise<CompiledMdx> {
  return compileMdxSource(source, filePath, compileSettings(options, []));
}

/** Compile one `.mdx` file's source to the JS module the Bun loader returns. */
export async function compileMdx(source: string, filePath: string): Promise<string> {
  const rel = path.relative(process.cwd(), filePath);
  const astro = userOptions.astro;
  let compiled: CompiledMdx;
  try {
    const highlight = astro ? await astroHighlightPlugins(astro.highlight) : [];
    compiled = await compileMdxSource(source, filePath, compileSettings(userOptions, highlight));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`MDX compilation error in ${rel}:\n${msg}`);
  }

  // In dev mode, append version query to .astro and .json imports for
  // cache busting (same as the astro plugin does for its own output).
  // JSON needs this too so translation dictionaries reload on edit.
  const code = applyDevCacheBust(substituteImportMetaEnv(compiled.code, "js"), getDevVersion());
  // Absolute paths, so the imports resolve even when pletivo is run from source.
  return mdxModule(code, compiled.exportsComponents, {
    astro: astro !== undefined,
    jsxRuntime: jsxRuntimePath,
    mdxContent: mdxContentPath,
    label: rel,
  });
}
