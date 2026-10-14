/**
 * Freeze `markdown` from the Astro config. A plugin is a live function and cannot be
 * serialized; one that carries a portable module reference (`PORTABLE_MODULE`) is
 * recorded as that reference, and the render isolate imports it from there.
 */

import {
  ArtifactFormatError,
  isJsonObject,
  parseJson,
  PORTABLE_MODULE,
  type ArtifactJson,
  type ArtifactMarkdownConfig,
  type PortablePlugin,
} from "@pletivo/core/artifact";
import type { PrepareDiagnostic } from "./error";

export interface FrozenMarkdown {
  /** `null` when the config leaves Markdown at its defaults. */
  config: ArtifactMarkdownConfig | null;
  diagnostics: PrepareDiagnostic[];
}

const STAGES = ["remarkPlugins", "rehypePlugins"] as const;

export function freezeMarkdown(markdown: unknown): FrozenMarkdown {
  const diagnostics: PrepareDiagnostic[] = [];
  if (typeof markdown !== "object" || markdown === null) return { config: null, diagnostics };

  const plugins: Record<(typeof STAGES)[number], PortablePlugin[]> = { remarkPlugins: [], rehypePlugins: [] };
  for (const stage of STAGES) {
    const list: unknown = Reflect.get(markdown, stage);
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      diagnostics.push(markdownDiagnostic(`markdown.${stage} is not an array`));
      continue;
    }
    list.forEach((entry: unknown, index) => {
      const frozen = freezePlugin(entry, `markdown.${stage}[${index}]`);
      if (typeof frozen === "string") diagnostics.push(markdownDiagnostic(frozen));
      else plugins[stage].push(frozen);
    });
  }

  const config: ArtifactMarkdownConfig = { ...plugins };
  const remarkRehype: unknown = Reflect.get(markdown, "remarkRehype");
  if (remarkRehype !== undefined) {
    const options = jsonOf(remarkRehype, "markdown.remarkRehype");
    if (typeof options === "string") diagnostics.push(markdownDiagnostic(options));
    else if (!isJsonObject(options)) diagnostics.push(markdownDiagnostic("markdown.remarkRehype is not an object"));
    else if (Object.keys(options).length > 0) config.remarkRehype = options;
  }
  const gfm: unknown = Reflect.get(markdown, "gfm");
  if (gfm === false) config.gfm = false;

  const customized =
    config.remarkPlugins.length > 0 ||
    config.rehypePlugins.length > 0 ||
    config.remarkRehype !== undefined ||
    config.gfm !== undefined;
  return { config: customized ? config : null, diagnostics };
}

/** The portable form of one `plugin` or `[plugin, options]` entry, or why there is none. */
function freezePlugin(entry: unknown, at: string): PortablePlugin | string {
  const [plugin, options]: unknown[] = Array.isArray(entry) ? entry : [entry];
  if (typeof plugin !== "function") return `${at} is not a plugin function`;
  const reference: unknown = Reflect.get(plugin, PORTABLE_MODULE);
  if (reference === undefined) {
    const name = plugin.name ? ` (${plugin.name})` : "";
    return (
      `${at}${name} is a live function with no portable module reference, so the Workers ` +
      "host cannot import it. Tag it with Symbol.for(\"pletivo.portableModule\"): " +
      "{ module, export } — see packages/workers/README.md"
    );
  }
  const module: unknown = isObject(reference) ? Reflect.get(reference, "module") : undefined;
  const exportName: unknown = isObject(reference) ? Reflect.get(reference, "export") : undefined;
  if (typeof module !== "string" || module === "" || typeof exportName !== "string" || exportName === "") {
    return `${at} has a portable module reference that is not { module: string, export: string }`;
  }
  if (module.startsWith(".") || module.startsWith("/")) {
    return `${at} names ${JSON.stringify(module)}; a portable module must be a bare specifier`;
  }
  if (options === undefined) return { module, export: exportName };
  const json = jsonOf(options, `${at} options`);
  return typeof json === "string" ? json : { module, export: exportName, options: json };
}

function jsonOf(value: unknown, at: string): ArtifactJson | string {
  try {
    return parseJson(value, at);
  } catch (error) {
    if (!(error instanceof ArtifactFormatError)) throw error;
    return `${error.path} cannot be carried: it is not JSON data`;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markdownDiagnostic(reason: string): PrepareDiagnostic {
  return { source: "astro.config", hook: "markdown", reason };
}
