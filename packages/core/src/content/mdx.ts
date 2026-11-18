/**
 * An `.mdx` file compiled as `@astrojs/mdx` compiles it, on any host: the plugin pipeline and
 * the module pletivo renders it with. The Bun host runs it in its loader, the Workers host in
 * an isolate that holds the project's plugins.
 */

import { compile, nodeTypes, type CompileOptions } from "@mdx-js/mdx";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import type { Transformer } from "unified";
import { splitFrontmatter } from "./markdown";
import { rehypeMdxHeadingIds } from "./mdx-heading-ids";
import { rehypeAstroIslandMetadata, type MdxHydration } from "./mdx-island-metadata";
import { rehypeMdxPageCharset } from "./mdx-page-charset";

export type { MdxHydration } from "./mdx-island-metadata";

// `unified`'s `PluggableList` isn't re-exported by @mdx-js/mdx, so derive it from `CompileOptions`.
export type PluggableList = NonNullable<CompileOptions["remarkPlugins"]>;

/** What `@astrojs/mdx` adds in an Astro project. */
export interface AstroMdxCompileSettings {
  /** The project's `src/pages`, in the same terms as the compiled file's path. */
  pagesDir: string;
  /** Astro's `experimental.headingIdCompat`. */
  experimentalHeadingIdCompat: boolean;
  /** The highlighter `@astrojs/mdx` runs after `rehype-raw`; empty for none. */
  highlight: PluggableList;
}

export interface MdxCompileSettings {
  /** The user's plugins, in pipeline order. */
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** GitHub Flavored Markdown, on by default as in `@astrojs/mdx`. */
  gfm: boolean;
  /** `null` outside an Astro project. */
  astro: AstroMdxCompileSettings | null;
  /** The host's `.astro` `resolvePath`, for a hydrated component's `client:component-path`. */
  resolveComponentPath(specifier: string, importer: string): string;
}

/** How the module pletivo renders an `.mdx` file with is written. */
export interface MdxModuleOptions {
  /** In an Astro project, `Content` passes `Fragment` and the file's `components` on. */
  astro: boolean;
  /** Replaces `pletivo/jsx-runtime`, which `@mdx-js/mdx` imports. */
  jsxRuntime: string;
  /** Exports `mdxContent` (`@pletivo/runtime/mdx-content`). */
  mdxContent: string;
  /** Names the file in an error. */
  label: string;
}

export interface CompiledMdx {
  /** `@mdx-js/mdx`'s output; it imports `pletivo/jsx-runtime`. */
  code: string;
  /** Whether the file exports `components`, which an Astro project's `Content` passes on. */
  exportsComponents: boolean;
  /** The components the file hydrates, in document order. */
  hydrated: MdxHydration[];
}

/** Compile one `.mdx` file's source (frontmatter included) at `filePath`. */
export async function compileMdxSource(source: string, filePath: string, settings: MdxCompileSettings): Promise<CompiledMdx> {
  // The same split the page `layout:` check reads.
  const { body } = splitFrontmatter(source);
  const hydrated: MdxHydration[] = [];
  const exportNames = new Set<string>();
  const { astro } = settings;
  const astroPlugins: PluggableList = astro
    ? [
        [rehypeMdxHeadingIds, { experimentalHeadingIdCompat: astro.experimentalHeadingIdCompat }],
        [rehypeMdxPageCharset, { pagesDir: astro.pagesDir }],
      ]
    : [];
  const compileOptions: CompileOptions = {
    jsxImportSource: "pletivo",
    development: false,
    // As @astrojs/mdx: hast attributes keep their HTML names (`class`, `tabindex`).
    ...(astro ? { elementAttributeNameCase: "html" } : {}),
    remarkPlugins: buildRemarkPlugins(settings.remarkPlugins, settings.gfm),
    // @astrojs/mdx's order: fence meta, rehype-raw, highlighter, user plugins, heading ids, charset,
    // island metadata. Outside an Astro project only rehype-raw, user plugins and island metadata run.
    rehypePlugins: [
      ...(astro ? [rehypeMdxMetaString] : []),
      ...buildRehypePlugins(settings.rehypePlugins, astro?.highlight ?? []),
      ...astroPlugins,
      [
        rehypeAstroIslandMetadata,
        { resolveComponentPath: settings.resolveComponentPath, hydrated: (hydration: MdxHydration) => hydrated.push(hydration) },
      ],
    ],
    recmaPlugins: [[recmaExportNames, exportNames]],
  };
  // The path lets the island metadata resolve relative imports, as Astro's does.
  const result = await compile({ value: body, path: filePath }, compileOptions);
  return { code: String(result), exportsComponents: exportNames.has("components"), hydrated };
}

const MDX_CONTENT_EXPORT = "export default function MDXContent(";

/**
 * The module the host loads: `@mdx-js/mdx`'s output with its JSX runtime import replaced and its
 * default export wrapped by `mdxContent`, which renders natively and hoists the islands' scripts.
 */
export function mdxModule(code: string, exportsComponents: boolean, options: MdxModuleOptions): string {
  const { astro, jsxRuntime, mdxContent, label } = options;
  let out = code.replace(
    /(from\s+["'])pletivo\/jsx-runtime(["'])/g,
    (_match, open: string, close: string) => open + jsxRuntime + close,
  );
  if (!out.includes(MDX_CONTENT_EXPORT)) throw new Error(`MDX compilation of ${label} produced no default MDXContent export`);
  out = out.replace(MDX_CONTENT_EXPORT, "function MDXContent(");
  out += `\nimport { mdxContent as __pletivoMdxContent } from ${JSON.stringify(mdxContent)};\n`;
  if (astro) {
    // As @astrojs/mdx's `Content`: `Fragment` and the module's `components` export, under the caller's.
    out += `import { Fragment as __pletivoFragment } from ${JSON.stringify(jsxRuntime)};\n`;
    out += `export default __pletivoMdxContent(MDXContent, { Fragment: __pletivoFragment${exportsComponents ? ", ...components" : ""} });\n`;
  } else {
    out += "export default __pletivoMdxContent(MDXContent);\n";
  }
  return out;
}

/** Extract the plugin function from a `Pluggable` (`fn` or `[fn, ...opts]`). */
function pluginFn(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface CodeElement {
  type: "element";
  tagName: "code";
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function isCodeElement(node: unknown): node is CodeElement {
  return isRecord(node) && node.type === "element" && node.tagName === "code";
}

function visit(node: unknown, fn: (node: unknown) => void): void {
  fn(node);
  if (isRecord(node) && Array.isArray(node.children)) for (const child of node.children) visit(child, fn);
}

/**
 * Port of `@astrojs/mdx`'s `rehypeMetaString`: `rehype-raw` drops `data`, so a code fence's meta
 * (```js {1:3}) is kept as the `metastring` property for the highlighter.
 */
export function rehypeMdxMetaString(): Transformer {
  return (tree) => {
    visit(tree, (node) => {
      if (!isCodeElement(node) || !node.data?.meta) return;
      node.properties ??= {};
      node.properties.metastring = node.data.meta;
    });
  };
}

/** Collects the names the compiled module exports into `names`, off the final estree: any plugin may add one. */
function recmaExportNames(names: Set<string>): Transformer {
  return (tree) => {
    const body = isRecord(tree) && Array.isArray(tree.body) ? tree.body : [];
    for (const statement of body) for (const name of exportedNames(statement)) names.add(name);
  };
}

function exportedNames(statement: unknown): string[] {
  if (!isRecord(statement)) return [];
  if (statement.type === "ExportAllDeclaration") return moduleExportName(statement.exported);
  if (statement.type !== "ExportNamedDeclaration") return [];
  const names = Array.isArray(statement.specifiers)
    ? statement.specifiers.flatMap((specifier: unknown) => (isRecord(specifier) ? moduleExportName(specifier.exported) : []))
    : [];
  const declaration = statement.declaration;
  if (!isRecord(declaration)) return names;
  if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
    for (const declarator of declaration.declarations) {
      if (isRecord(declarator)) names.push(...bindingNames(declarator.id));
    }
  } else {
    names.push(...bindingNames(declaration.id));
  }
  return names;
}

/** An `Identifier` or string `Literal` export name. */
function moduleExportName(node: unknown): string[] {
  if (!isRecord(node)) return [];
  if (node.type === "Identifier" && typeof node.name === "string") return [node.name];
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  return [];
}

/** The names a declaration binds, destructuring included. */
function bindingNames(pattern: unknown): string[] {
  if (!isRecord(pattern)) return [];
  switch (pattern.type) {
    case "Identifier":
      return typeof pattern.name === "string" ? [pattern.name] : [];
    case "ObjectPattern":
      return Array.isArray(pattern.properties)
        ? pattern.properties.flatMap((property: unknown) =>
            isRecord(property) ? bindingNames(property.type === "RestElement" ? property.argument : property.value) : [],
          )
        : [];
    case "ArrayPattern":
      return Array.isArray(pattern.elements) ? pattern.elements.flatMap(bindingNames) : [];
    case "RestElement":
      return bindingNames(pattern.argument);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    default:
      return [];
  }
}
