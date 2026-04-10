/**
 * Integrations that pletivo handles natively and therefore silently removes
 * from the Astro config before running the integration host.
 *
 * Match on integration `name` (the `name` property of the returned
 * AstroIntegration object) OR on the imported module specifier — in
 * practice we only see `name`, since the config-loader evaluates the file.
 */
export const NATIVE_OVERRIDES: Record<string, string> = {
  // Tailwind: pletivo has its own v4 pipeline in css.ts
  "@tailwindcss/vite": "pletivo-native-tailwind",
  "vite:tailwindcss": "pletivo-native-tailwind",
  "@astrojs/tailwind": "pletivo-native-tailwind",

  // MDX: pletivo currently handles .mdx as markdown fallback; a proper
  // native plugin lives on the roadmap. @astrojs/mdx is tightly coupled
  // to Astro's compiler + content entry pipeline and can't be hosted
  // via our Vite-plugin shim.
  "@astrojs/mdx": "pletivo-native-mdx-pending",
};

/** Returns true if the integration should be skipped and native path used */
export function isOverridden(name: string): string | null {
  return NATIVE_OVERRIDES[name] ?? null;
}
