/** Tailwind sources embedded by this example's Worker bundle. */

import type { TailwindStylesheets } from "@pletivo/workers/tailwind";
import index from "tailwindcss/index.css";
import preflight from "tailwindcss/preflight.css";
import theme from "tailwindcss/theme.css";
import utilities from "tailwindcss/utilities.css";

export const TAILWIND: TailwindStylesheets = {
  tailwindcss: index,
  "tailwindcss/preflight": preflight,
  "tailwindcss/theme": theme,
  "tailwindcss/utilities": utilities,
};
