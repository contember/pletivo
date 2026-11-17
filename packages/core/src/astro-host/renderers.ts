import { fileURLToPath } from "node:url";

/** A renderer an integration registered with `addRenderer()`, parsed once at the hook. */
export interface AstroRendererEntry {
  /** E.g. `@astrojs/react`. Renderers are tried in registration order, as Astro does. */
  name: string;
  /** A package specifier or an absolute file path, resolved from the project root. */
  serverEntrypoint: string;
  /** `null` for a server-only renderer. */
  clientEntrypoint: string | null;
}

/** Astro accepts a string or a `URL` for both entrypoints. */
function entrypoint(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value.href) : value.href;
  return null;
}

/** The renderer an `addRenderer()` argument describes, or a reason it describes none. */
export function parseAstroRenderer(value: unknown): AstroRendererEntry | { error: string } {
  if (typeof value !== "object" || value === null) return { error: "not an object" };
  const name = "name" in value && typeof value.name === "string" && value.name !== "" ? value.name : null;
  if (!name) return { error: "no name" };
  const serverEntrypoint = entrypoint("serverEntrypoint" in value ? value.serverEntrypoint : undefined);
  if (!serverEntrypoint) return { error: `"${name}" has no serverEntrypoint` };
  const clientEntrypoint = entrypoint("clientEntrypoint" in value ? value.clientEntrypoint : undefined);
  return { name, serverEntrypoint, clientEntrypoint };
}
