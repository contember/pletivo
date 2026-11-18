/** A remark/rehype plugin the generated program imported from an artifact module, made pluggable again. */

import type { PluggableList } from "@pletivo/core/content/mdx";

type Pluggable = PluggableList[number];
type Plugin = Extract<Pluggable, (...parameters: never[]) => unknown>;

/** One configured plugin: the Loader module namespace it is exported from. */
export interface IsolatePlugin {
  module: object;
  exportName: string;
  options?: unknown;
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "function";
}

export function pluggable(plugin: IsolatePlugin): Pluggable {
  const value: unknown = Reflect.get(plugin.module, plugin.exportName);
  if (!isPlugin(value)) {
    throw new Error(
      `[pletivo-workers] Markdown plugin export ${JSON.stringify(plugin.exportName)} is not a function`,
    );
  }
  return plugin.options === undefined ? value : [value, plugin.options];
}
