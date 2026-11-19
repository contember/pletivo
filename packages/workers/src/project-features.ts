/**
 * Which features a project uses that this host renders only in part or not at all, so a
 * host can refuse the project up front with a reason instead of failing page by page.
 */

import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import type { AstroCompiler } from "./astro-compiler.ts";
import { extensionOf } from "./compile/module-kind.ts";
import type { ProjectFiles } from "./project-store.ts";
import { projectRoutes } from "./render.ts";

/** Project paths per feature, sorted; an empty list means the feature is unused. */
export interface ProjectFeatures {
  /** `.mdx` files: pages, content entries or components. A content entry does not render. */
  mdx: string[];
  /** Files that hydrate a component with a `client:*` directive; their islands need a prepared artifact. */
  islands: string[];
  /** Endpoint routes (`rss.xml.ts`): a page file that answers with a `Response`. */
  endpoints: string[];
  /** Pages that opt out of prerendering with `export const prerender = false`. */
  onDemand: string[];
}

export interface DetectFeaturesOptions {
  pagesDir?: string;
  compiler: AstroCompiler;
}

const CLIENT_DIRECTIVE = /\bclient:(?:load|idle|visible|media|only)\b/;
const PRERENDER_FALSE = /^\s*export\s+const\s+prerender\s*=\s*false\b/m;

export async function detectProjectFeatures(
  files: ProjectFiles,
  options: DetectFeaturesOptions,
): Promise<ProjectFeatures> {
  const pagesDir = options.pagesDir ?? "src/pages";
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const compiler = options.compiler;
  const features: ProjectFeatures = { mdx: [], islands: [], endpoints: [], onDemand: [] };

  const components: string[] = [];
  for (const file of files.keys()) {
    if (file.split("/").includes("node_modules")) continue;
    const extension = extensionOf(file);
    if (extension === ".mdx") features.mdx.push(file);
    if ([".astro", ".mdx", ".tsx", ".jsx"].includes(extension)) components.push(file);
  }
  const routes = projectRoutes(files, pagesDir);
  const pages = routes.filter((route) => !route.isEndpoint).map((route) => prefix + route.file);
  // Every file the scan reads, in one batch where the store can batch it.
  const wanted = [...new Set([...components, ...pages])];
  const sources = new Map<string, string | undefined>();
  const read = files.getMany ? files.getMany(wanted) : wanted.map((file) => files.get(file));
  wanted.forEach((file, index) => sources.set(file, read[index]));

  for (const file of components) {
    const source = sources.get(file);
    if (source === undefined || !CLIENT_DIRECTIVE.test(source)) continue;
    // The text names a directive; for `.astro`, only an attribute in the template counts.
    if (extensionOf(file) !== ".astro" || (await usesClientDirective(source, compiler))) features.islands.push(file);
  }

  for (const route of routes) {
    const file = prefix + route.file;
    if (route.isEndpoint) {
      features.endpoints.push(file);
      continue;
    }
    if (PRERENDER_FALSE.test(sources.get(file) ?? "")) features.onDemand.push(file);
  }

  for (const list of Object.values(features)) list.sort();
  return features;
}

async function usesClientDirective(source: string, compiler: AstroCompiler): Promise<boolean> {
  const { ast } = await compiler.parse(source);
  const visit = (node: Node): boolean => {
    if (is.element(node) || is.component(node) || is.customElement(node)) {
      if (node.attributes.some((attribute) => attribute.name.startsWith("client:"))) return true;
    }
    return is.parent(node) && node.children.some(visit);
  };
  return visit(ast);
}
