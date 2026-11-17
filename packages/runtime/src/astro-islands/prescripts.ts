/**
 * Astro writes island scripts at flush time, in document order. pletivo renders siblings
 * concurrently, so each island carries all its prescripts between sentinels, and
 * `finalizeIslandScripts` keeps the first of each on the written page: Astro's choices.
 */
import type { AstroIslandsConfig, LoadedRenderer } from "./types";
import type { HydrateDirective } from "./hydration";

const ISLAND_STYLES = "astro-island,astro-slot,astro-static-slot{display:contents}";

const OPEN = "<!--pletivo-island-prescript:";
const CLOSE = "<!--/pletivo-island-prescript-->";
const BLOCK = /<!--pletivo-island-prescript:([^>]*?)-->([\s\S]*?)<!--\/pletivo-island-prescript-->/g;

function block(key: string, content: string): string {
  return `${OPEN}${encodeURIComponent(key)}-->${content}${CLOSE}`;
}

/** Everything an island needs ahead of its element, in the order Astro writes it. */
export function islandPrescripts(config: AstroIslandsConfig, directive: HydrateDirective, renderer: LoadedRenderer): string {
  const directiveScript = config.scripts.directives[directive];
  if (directiveScript === undefined) throw new Error(`Unknown directive: ${directive}`);
  let out =
    block("style", `<style>${ISLAND_STYLES}</style>`) +
    block(`directive:${directive}`, `<script>${directiveScript}</script>`) +
    block("island", `<script>${config.scripts.island}</script>`);
  if (directive !== "only" && renderer.ssr.renderHydrationScript) {
    out += block(`renderer:${renderer.name}`, renderer.ssr.renderHydrationScript());
  }
  return out;
}

/**
 * Split rendered HTML into its prescripts and the rest. A slot's prescripts go ahead of
 * the component that receives the slot, as Astro writes a slot's instructions first.
 */
export function takePrescripts(html: string): { prescripts: string; html: string } {
  let prescripts = "";
  const rest = html.replace(BLOCK, (found) => {
    prescripts += found;
    return "";
  });
  return { prescripts, html: rest };
}

/**
 * Move every prescript in `html` to its start, keeping their order. Astro does this for
 * MDX content: its renderer returns the content with the instructions written first.
 */
export function hoistIslandScripts(html: string): string {
  const { prescripts, html: rest } = takePrescripts(html);
  return prescripts + rest;
}

/** Keep the first occurrence of each prescript in document order and remove the sentinels. */
export function finalizeIslandScripts(html: string): string {
  const seen = new Set<string>();
  return html.replace(BLOCK, (_found, key: string, content: string) => {
    if (seen.has(key)) return "";
    seen.add(key);
    return content;
  });
}
