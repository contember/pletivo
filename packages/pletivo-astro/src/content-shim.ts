/**
 * Content collections shim — wraps Astro's content API to match pletivo's API.
 *
 * This module is aliased from `pletivo` imports so that the same page code
 * works in both pletivo and Astro.
 *
 * import { getCollection, getEntry } from "pletivo";
 * // In pletivo: uses pletivo's own content system
 * // In Astro:  uses this shim which delegates to astro:content
 */

// @ts-ignore — astro:content is a virtual module only available in Astro
import { getCollection as astroGetCollection, getEntry as astroGetEntry } from "astro:content";
import { z } from "zod";

export interface RenderResult {
  html: string;
}

export interface CollectionEntry<T = Record<string, unknown>> {
  id: string;
  data: T;
  body: string;
  render(): Promise<RenderResult>;
}

function wrapEntry<T>(entry: any): CollectionEntry<T> {
  return {
    id: entry.id ?? entry.slug,
    data: entry.data,
    body: entry.body ?? "",
    render: async () => {
      // Use Astro's render() and extract HTML
      const rendered = await entry.render();
      // Astro's render returns { Content, headings, remarkPluginFrontmatter }
      // Content is an Astro component — we can't easily get raw HTML from it
      // For JSX pages, return body as-is (user should use dangerouslySetInnerHTML with rendered markdown)
      // If Astro's compiledContent is available, use that
      if (typeof rendered === "object" && "compiledContent" in rendered) {
        return { html: rendered.compiledContent };
      }
      // Fallback: return empty (user will need to use <Content /> in .astro files)
      return { html: entry.body ?? "" };
    },
  };
}

export async function getCollection<T = Record<string, unknown>>(
  name: string,
  filter?: (entry: CollectionEntry<T>) => boolean,
): Promise<CollectionEntry<T>[]> {
  const entries = await astroGetCollection(name);
  let wrapped = entries.map((e: any) => wrapEntry<T>(e));
  if (filter) {
    wrapped = wrapped.filter(filter);
  }
  return wrapped;
}

export async function getEntry<T = Record<string, unknown>>(
  name: string,
  id: string,
): Promise<CollectionEntry<T> | undefined> {
  const entry = await astroGetEntry(name, id);
  if (!entry) return undefined;
  return wrapEntry<T>(entry);
}

export function defineCollection(config: any) {
  // In Astro, defineCollection is from astro:content
  // This is a passthrough for compatibility
  return config;
}

export { z };
