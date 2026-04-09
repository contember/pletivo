/**
 * Vite plugin host.
 *
 * Collects plugins registered by integrations (via `updateConfig({ vite:
 * { plugins } })`) and wires their relevant hooks into pavouk:
 *
 *  - `resolveId` + `load` → registered as Bun plugin `onResolve` / `onLoad`
 *    so bare specifiers like `virtual:cms-manifest` can be imported from
 *    anywhere at runtime (editor bundle, integration code, etc.).
 *  - `configureServer` → called once after the server shim is created.
 *  - `transformIndexHtml` → used by the server shim's own
 *    `transformIndexHtml(url, html)` method.
 *  - `transform` → not forwarded in MVP. Bun already handles TS/JSX and
 *    our Astro loader handles .astro; most Vite transforms integrate at
 *    levels pavouk bypasses.
 */

import path from "path";
import type { ServerShim } from "./server-shim";
import type { ViteLikePlugin } from "./types";

let bunPluginRegistered = false;
const collectedPlugins: ViteLikePlugin[] = [];

/**
 * Register all previously-collected plugins with Bun's module loader.
 * Idempotent: the Bun plugin is registered exactly once; subsequent calls
 * just ensure newly-added Vite plugins participate in resolution.
 */
export async function ensureBunPlugin(): Promise<void> {
  if (bunPluginRegistered) return;
  bunPluginRegistered = true;

  await Bun.plugin({
    name: "pavouk-vite-plugin-host",
    setup(build) {
      // onResolve: walk Vite plugins' resolveId hooks. First plugin to
      // return a string wins. Returned id may be prefixed with `\0` by
      // Vite convention (virtual modules) — we stash it in our own
      // namespace so Bun doesn't re-resolve it as a file path.
      //
      // Filter is restricted to the specifier prefixes that Vite plugins
      // typically intercept (virtual modules, dev `/@...` paths). A
      // catch-all filter makes every normal file import run through an
      // async callback, and Bun's module loader currently cannot await
      // plugin resolutions during root imports ("onResolve() doesn't
      // support pending promises yet"). Scoping the filter sidesteps
      // that limitation and costs us nothing — Vite plugins never
      // resolve bare filesystem paths.
      build.onResolve(
        { filter: /^(virtual:|\/@|@id\/|\0virtual:)/ },
        async (args) => {
          for (const p of collectedPlugins) {
            if (typeof p.resolveId !== "function") continue;
            try {
              const resolved = await p.resolveId(args.path, args.importer);
              if (typeof resolved === "string") {
                return {
                  path: resolved,
                  namespace: "pavouk-vite-virtual",
                };
              }
            } catch {
              // fall through to next plugin
            }
          }
          return undefined;
        },
      );

      build.onLoad(
        { filter: /.*/, namespace: "pavouk-vite-virtual" },
        async (args) => {
          for (const p of collectedPlugins) {
            if (typeof p.load !== "function") continue;
            try {
              const result = await p.load(args.path);
              if (result == null) continue;
              const code = typeof result === "string" ? result : result.code;
              // Pick a loader based on extension, default to ts for virtual
              const ext = path.extname(args.path.replace(/\0/g, "")).toLowerCase();
              const loader =
                ext === ".css"
                  ? "css"
                  : ext === ".js" || ext === ".mjs"
                    ? "js"
                    : ext === ".json"
                      ? "json"
                      : "ts";
              return { contents: code, loader };
            } catch (e) {
              console.error(
                `[pavouk-vite-host] ${p.name}.load failed for ${args.path}:`,
                (e as Error).message,
              );
            }
          }
          return undefined;
        },
      );
    },
  });
}

/**
 * Add a batch of plugins to the host. Returns the list of plugins that
 * were actually added (new ones, de-duped by identity).
 */
export function addVitePlugins(plugins: ViteLikePlugin[]): ViteLikePlugin[] {
  const added: ViteLikePlugin[] = [];
  for (const p of plugins) {
    if (!p || typeof p !== "object") continue;
    if (collectedPlugins.includes(p)) continue;
    collectedPlugins.push(p);
    added.push(p);
  }
  return added;
}

/**
 * Sync the host's current plugin list onto the given server shim's
 * `__plugins` array. Called after each batch so that the server's
 * `transformIndexHtml` walks the fresh list.
 */
export function syncServerPlugins(server: ServerShim): void {
  server.__plugins.length = 0;
  server.__plugins.push(...collectedPlugins);
}

/**
 * Run `configureServer` hooks on a set of plugins against the given
 * server shim. Called during `astro:server:setup`.
 */
export async function runConfigureServer(
  plugins: ViteLikePlugin[],
  server: ServerShim,
): Promise<void> {
  for (const p of plugins) {
    if (typeof p.configureServer !== "function") continue;
    try {
      await p.configureServer(server);
    } catch (e) {
      console.error(
        `[pavouk-vite-host] ${p.name}.configureServer failed:`,
        (e as Error).message,
      );
    }
  }
}

/** Test/reset helper. */
export function __resetForTests(): void {
  collectedPlugins.length = 0;
  bunPluginRegistered = false;
}
