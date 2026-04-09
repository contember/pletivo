/**
 * Load a user's `astro.config.{mjs,js,ts,mts}` and extract the integrations
 * and relevant Astro config fields. We just `await import()` the file —
 * Bun handles TS natively — then normalize the result into our local
 * `AstroConfig` shape so the runner can operate on a single object.
 */

import path from "path";
import { pathToFileURL } from "url";
import { existsSync } from "fs";
import type { AstroConfig, AstroIntegration } from "./types";

const CONFIG_NAMES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.mjs",
  "astro.config.js",
];

/**
 * Locate the astro config file in `projectRoot`. Returns null if none.
 */
export function findAstroConfig(projectRoot: string): string | null {
  for (const name of CONFIG_NAMES) {
    const full = path.join(projectRoot, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Load the astro config file and return a normalized pavouk `AstroConfig`
 * view of it. The file's default export is typically the result of
 * `defineConfig({...})` — which is just the object itself — or a wrapper
 * like `@nuasite/nua/config`'s defineConfig that pre-injects the nua
 * integration. Either way, we pull out `integrations` + other relevant
 * fields and fill the rest with pavouk defaults.
 */
export async function loadAstroConfig(
  projectRoot: string,
): Promise<AstroConfig | null> {
  const configPath = findAstroConfig(projectRoot);
  if (!configPath) return null;

  let mod: { default?: unknown } | unknown;
  try {
    // pathToFileURL so Windows + symlinks work consistently
    mod = await import(pathToFileURL(configPath).href);
  } catch (e) {
    console.error(`  Failed to load ${path.basename(configPath)}: ${(e as Error).message}`);
    return null;
  }

  const raw =
    (mod as { default?: unknown })?.default ?? (mod as unknown);
  if (!raw || typeof raw !== "object") return null;

  const userConfig = raw as Record<string, unknown>;

  const rootUrl = pathToFileURL(projectRoot + path.sep);
  const srcDir = new URL(
    (userConfig.srcDir as string | undefined) ?? "src/",
    rootUrl,
  );
  const publicDir = new URL(
    (userConfig.publicDir as string | undefined) ?? "public/",
    rootUrl,
  );
  const outDir = new URL(
    (userConfig.outDir as string | undefined) ?? "dist/",
    rootUrl,
  );

  const integrations = Array.isArray(userConfig.integrations)
    ? (userConfig.integrations as AstroIntegration[])
    : [];

  const config: AstroConfig = {
    root: rootUrl,
    srcDir,
    publicDir,
    outDir,
    site: userConfig.site as string | undefined,
    base: (userConfig.base as string | undefined) ?? "/",
    integrations,
    vite: (userConfig.vite as AstroConfig["vite"]) ?? {},
    redirects:
      (userConfig.redirects as AstroConfig["redirects"]) ?? {},
  };

  // Preserve any extra fields users might put on their config (e.g. nua)
  for (const [k, v] of Object.entries(userConfig)) {
    if (!(k in config)) config[k] = v;
  }

  return config;
}
