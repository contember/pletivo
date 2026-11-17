/**
 * The islands' client bundle `pletivo prepare` built: served at the URLs a render's
 * `<astro-island>`s name, and scanned for the Tailwind classes those islands can apply.
 */

import type { ArtifactIslandClient } from "@pletivo/core/artifact";
import type { ProjectIslands } from "./artifact.ts";
import { attributeValue, htmlTags } from "./html-tags.ts";
import type { ProjectFiles } from "./project-store.ts";

/** Bun names a shared chunk by its content; every other client module by its path (docs/todos/025). */
const CONTENT_HASHED = /^\/_astro\/chunk-[^/]+\.js$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** A render hydrates an island whose client module the artifact does not carry. */
export class MissingIslandClientError extends Error {
  constructor(readonly url: string, readonly componentExport: string | null) {
    super(
      `[pletivo-workers] an island loads ${url}${componentExport === null ? "" : ` (export ${JSON.stringify(componentExport)})`}, ` +
        "which the artifact's islands client bundle does not hold. Re-run `pletivo prepare`.",
    );
    this.name = "MissingIslandClientError";
  }
}

/** The response for a client module, or `null` when `pathname` names none. */
export function islandClientResponse(request: Request, pathname: string, islands: ProjectIslands | null): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const client = islands?.clients.get(pathname);
  if (client === undefined) return null;
  return new Response(request.method === "HEAD" ? null : client.source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // A path-named module changes under its URL with the next prepare.
      "cache-control": CONTENT_HASHED.test(client.url) ? IMMUTABLE : "no-cache",
    },
  });
}

/**
 * Every client module the page's islands load: each `component-url` and `renderer-url`, and what
 * they import. Throws `MissingIslandClientError` for one the artifact does not hold.
 */
export function pageIslandClients(html: string, islands: ProjectIslands): ArtifactIslandClient[] {
  const loaded = new Map<string, ArtifactIslandClient>();
  const queue: ArtifactIslandClient[] = [];
  const load = (url: string, componentExport: string | null) => {
    if (loaded.has(url)) return;
    const client = islands.clients.get(url);
    if (client === undefined) throw new MissingIslandClientError(url, componentExport);
    loaded.set(url, client);
    queue.push(client);
  };
  for (const tag of htmlTags(html)) {
    if (tag.name !== "astro-island" || tag.closing) continue;
    const componentUrl = attributeValue(tag, "component-url");
    if (componentUrl !== null) load(componentUrl, attributeValue(tag, "component-export"));
    const rendererUrl = attributeValue(tag, "renderer-url");
    if (rendererUrl !== null) load(rendererUrl, null);
  }
  for (let client = queue.pop(); client !== undefined; client = queue.pop()) {
    for (const url of client.imports) load(url, null);
  }
  return [...loaded.values()];
}

/**
 * The project files those modules were bundled from, as the project holds them now. The Bun host's
 * Tailwind scans the project's sources, not `node_modules`, so the frameworks' own code adds nothing.
 */
export function islandCandidateSources(clients: readonly ArtifactIslandClient[], files: ProjectFiles, rootDir: string): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const client of clients) {
    for (const file of client.sources) {
      const key = rootDir === "" ? file : `${rootDir}/${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = files.get(key);
      if (source !== undefined) sources.push(source);
    }
  }
  return sources;
}
