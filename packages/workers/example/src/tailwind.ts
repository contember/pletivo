/**
 * Tailwind's own four stylesheets, embedded in the worker.
 *
 * `@tailwindcss/node` resolves these off disk; an isolate has no disk, so the host
 * worker's bundler has to carry the text. That is what the `{ "type": "Text",
 * "globs": ["**\/*.css"] }` rule in `wrangler.jsonc` is for.
 *
 * A host that knows its projects never use Tailwind can leave `tailwind` off
 * `renderPage` entirely and not pay for any of this — a project that then imports
 * Tailwind gets `TailwindNotConfiguredError` rather than a page with no utilities.
 */

import index from "tailwindcss/index.css";
import preflight from "tailwindcss/preflight.css";
import theme from "tailwindcss/theme.css";
import utilities from "tailwindcss/utilities.css";
import type { TailwindStylesheets } from "@pletivo/workers/tailwind";

export const TAILWIND: TailwindStylesheets = {
  tailwindcss: index,
  "tailwindcss/preflight": preflight,
  "tailwindcss/theme": theme,
  "tailwindcss/utilities": utilities,
};
