import type { AstroConfig } from "./types";

/** `@astrojs/compiler`'s `scopedStyleStrategy`. */
export type ScopedStyleStrategy = "where" | "class" | "attribute";

/**
 * The scoped-style strategy an Astro project compiles `.astro` with: its
 * `scopedStyleStrategy`, or Astro's default `attribute`. Without an Astro config
 * (a pletivo-native project) it is `undefined`, leaving the compiler's own
 * default (`where`). Both hosts read it here so they scope styles alike.
 */
export function resolveScopedStyleStrategy(config: AstroConfig | undefined): ScopedStyleStrategy | undefined {
  if (!config) return undefined;
  const configured = config.scopedStyleStrategy;
  if (configured === undefined) return "attribute";
  if (configured === "where" || configured === "class" || configured === "attribute") return configured;
  throw new Error(
    `scopedStyleStrategy ${JSON.stringify(configured)} is not "where", "class" or "attribute"`,
  );
}

/**
 * The scope ids of the components an HTML page shows, under any strategy:
 * `class="astro-{scope}"` (`where`, `class`) or `data-astro-cid-{scope}` (`attribute`).
 */
export function extractAstroScopes(html: string): Set<string> {
  const scopes = new Set<string>();
  for (const match of html.matchAll(/\bdata-astro-cid-([a-z0-9]+)|\bastro-([a-z0-9]+)/g)) {
    scopes.add(match[1] ?? match[2]);
  }
  return scopes;
}
