/**
 * The islands' client bundle `pletivo prepare` built: served at the URLs a render's
 * `<astro-island>`s name, and scanned for the Tailwind classes those islands can apply.
 */

import type { ArtifactIslandClient } from "@pletivo/core/artifact";
import { base64url, sha256 } from "@pletivo/core/sha256";
import type { ProjectIslands } from "./artifact.ts";
import { attributeValue, htmlTags } from "./html-tags.ts";
import type { ProjectFiles } from "./project-store.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Per client module of a loaded artifact, so a module is digested once, on its first request. */
const etags = new WeakMap<ArtifactIslandClient, string>();

function etagOf(client: ArtifactIslandClient): string {
  let etag = etags.get(client);
  if (etag === undefined) {
    etag = `"${base64url(sha256(client.source))}"`;
    etags.set(client, etag);
  }
  return etag;
}

/** `If-None-Match` names this entity: `*`, or one of its listed tags, weak or strong. */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed === etag || trimmed === `W/${etag}`;
  });
}

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
  const headers = new Headers({ "content-type": "text/javascript; charset=utf-8" });
  if (client.chunk) {
    headers.set("cache-control", IMMUTABLE);
  } else {
    // A path-named module changes under its URL with the next prepare; revalidating it is cheap.
    const etag = etagOf(client);
    headers.set("cache-control", "no-cache");
    headers.set("etag", etag);
    if (matches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : client.source, { headers });
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
