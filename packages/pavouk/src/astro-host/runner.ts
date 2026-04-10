/**
 * Astro integration hook runner.
 *
 * Orchestrates the lifecycle:
 *  1. Load astro.config — produces `AstroConfig` with root integrations
 *  2. Run `astro:config:setup` on every integration, in order
 *     - integrations may call `updateConfig({ integrations: [...] })`
 *       to add children; we immediately run setup on those too
 *     - integrations may call `updateConfig({ vite: { plugins: [...] } })`
 *       to register Vite plugins; we funnel those into the plugin host
 *     - integrations may call `injectScript('page', code)`; we collect
 *       the fragments and expose them to dev/build HTML injection
 *  3. Run `astro:config:done`
 *  4. Run `astro:server:setup` with the server shim (dev only)
 *  5. Later, run `astro:build:done` with dir + pages list (build only)
 *
 * This module is intentionally stateful — there is one host per pavouk
 * process. Dev and build both use the same instance through the
 * module-level `getHost()` accessor.
 */

import path from "path";
import { pathToFileURL } from "url";
import type {
  AstroConfig,
  AstroConfigSetupContext,
  AstroIntegration,
  AstroRoute,
  InjectScriptStage,
  ViteLikePlugin,
} from "./types";
import { createLogger } from "./logger";
import { isOverridden } from "./overrides";
import { loadAstroConfig } from "./config-loader";
import { createServerShim, type ServerShim } from "./server-shim";
import {
  addVitePlugins,
  ensureBunPlugin,
  runConfigureServer,
  syncServerPlugins,
} from "./vite-plugins";

export interface AstroHost {
  config: AstroConfig;
  server: ServerShim;
  /** Scripts injected via `injectScript('page', code)` — wrapped into <script type="module"> by dev/build */
  injectedPageScripts: string[];
  /** Scripts injected via `injectScript('head-inline', code)` — wrapped into inline <script> */
  injectedHeadScripts: string[];
  /** Ran once on startup (setup + server:setup in dev; setup + config:done in build) */
  ready: Promise<void>;
  /** Returns true if an integration with the given name is active after overrides */
  hasIntegration(name: string): boolean;
  runRoutesResolved(routes: AstroRoute[]): Promise<void>;
  runBuildDone(
    routes: AstroRoute[],
    pages: Array<{ pathname: string }>,
    distDir: string,
  ): Promise<void>;
  runServerStart(address: { address: string; port: number; family: string }): Promise<void>;
  runServerDone(): Promise<void>;
}

let activeHost: AstroHost | null = null;

export function getHost(): AstroHost | null {
  return activeHost;
}

/**
 * Initialize the Astro host for the given project. Idempotent — returns
 * the existing host on subsequent calls.
 */
export async function initAstroHost(
  projectRoot: string,
  command: "dev" | "build",
): Promise<AstroHost | null> {
  if (activeHost) return activeHost;

  const config = await loadAstroConfig(projectRoot);
  if (!config) return null;

  const server = createServerShim(projectRoot);
  const injectedPageScripts: string[] = [];
  const injectedHeadScripts: string[] = [];
  const setupLog: string[] = [];

  const host: AstroHost = {
    config,
    server,
    injectedPageScripts,
    injectedHeadScripts,
    ready: Promise.resolve(),
    hasIntegration: (name) => config.integrations.some((i) => i?.name === name),
    runRoutesResolved: async () => {},
    runBuildDone: async () => {},
    runServerStart: async () => {},
    runServerDone: async () => {},
  };

  await ensureBunPlugin();

  // ── Filter overridden integrations from the initial root set ──
  const rootIntegrations = filterOverrides(config.integrations, setupLog);
  config.integrations = rootIntegrations;

  // ── Run config:setup on every integration ──
  const alreadySetup = new WeakSet<AstroIntegration>();
  const queue: AstroIntegration[] = [...rootIntegrations];

  const makeSetupContext = (
    integration: AstroIntegration,
  ): AstroConfigSetupContext => {
    const logger = createLogger(integration.name);
    return {
      config,
      command,
      isRestart: false,
      logger,
      updateConfig(patch) {
        applyConfigPatch(config, patch, host, queue, alreadySetup);
        return config;
      },
      addRenderer() {},
      addWatchFile() {},
      addClientDirective() {},
      addMiddleware() {},
      addDevToolbarApp() {},
      addPageExtension() {},
      addContentEntryType() {},
      addDataEntryType() {},
      injectRoute() {
        // Pavouk doesn't support dynamic route injection from integrations.
        // We log once and ignore.
      },
      injectScript(stage, content) {
        if (stage === "page") {
          injectedPageScripts.push(content);
        } else if (stage === "head-inline") {
          injectedHeadScripts.push(content);
        } else {
          // `page-ssr` and `before-hydration` stages are runtime-module
          // injection hooks that pavouk doesn't need; log + ignore.
          logger.warn(`injectScript stage "${stage}" not supported, ignoring`);
        }
      },
    };
  };

  while (queue.length > 0) {
    const integration = queue.shift()!;
    if (alreadySetup.has(integration)) continue;
    alreadySetup.add(integration);

    const hook = integration.hooks?.["astro:config:setup"];
    if (typeof hook !== "function") continue;

    try {
      await hook(makeSetupContext(integration));
      setupLog.push(`✓ ${integration.name} configured`);
    } catch (e) {
      console.error(
        `[pavouk-astro-host] ${integration.name}.astro:config:setup failed:`,
        (e as Error).stack ?? (e as Error).message,
      );
    }
  }

  syncServerPlugins(server);

  // ── astro:config:done ──
  for (const integration of config.integrations) {
    const hook = integration.hooks?.["astro:config:done"];
    if (typeof hook !== "function") continue;
    try {
      await hook({
        config,
        logger: createLogger(integration.name),
        setAdapter: () => {},
        injectTypes: ({ filename }) => new URL(`./${filename}`, pathToFileURL(projectRoot + path.sep)),
      });
    } catch (e) {
      console.error(
        `[pavouk-astro-host] ${integration.name}.astro:config:done failed:`,
        (e as Error).message,
      );
    }
  }

  // ── astro:server:setup (dev only) ──
  if (command === "dev") {
    await runConfigureServer(server.__plugins, server);

    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:server:setup"];
      if (typeof hook !== "function") continue;
      try {
        await hook({
          server,
          logger: createLogger(integration.name),
          toolbar: {
            send: () => {},
            onAppInitialized: () => {},
            onAppToggled: () => {},
          },
        });
      } catch (e) {
        console.error(
          `[pavouk-astro-host] ${integration.name}.astro:server:setup failed:`,
          (e as Error).message,
        );
      }
    }
  }

  // ── astro:routes:resolved — called once per build / once after initial
  // dev scan. Integrations like @astrojs/sitemap and @nuasite/agent-summary
  // capture the routes array here and use it later in astro:build:done.
  host.runRoutesResolved = async (routes) => {
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:routes:resolved"];
      if (typeof hook !== "function") continue;
      try {
        await hook({
          routes,
          logger: createLogger(integration.name),
        });
      } catch (e) {
        console.error(
          `[pavouk-astro-host] ${integration.name}.astro:routes:resolved failed:`,
          (e as Error).message,
        );
      }
    }
  };

  // ── Build done hook — exposed for build.ts to call ──
  host.runBuildDone = async (routes, pages, distDir) => {
    const dirUrl = pathToFileURL(distDir + path.sep);
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:build:done"];
      if (typeof hook !== "function") continue;
      try {
        await hook({
          dir: dirUrl,
          pages,
          routes,
          assets: new Map(),
          logger: createLogger(integration.name),
        });
      } catch (e) {
        console.error(
          `[pavouk-astro-host] ${integration.name}.astro:build:done failed:`,
          (e as Error).message,
        );
      }
    }
  };

  host.runServerStart = async (address) => {
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:server:start"];
      if (typeof hook !== "function") continue;
      try {
        await hook({ address, logger: createLogger(integration.name) });
      } catch (e) {
        console.error(
          `[pavouk-astro-host] ${integration.name}.astro:server:start failed:`,
          (e as Error).message,
        );
      }
    }
  };

  host.runServerDone = async () => {
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:server:done"];
      if (typeof hook !== "function") continue;
      try {
        await hook({ logger: createLogger(integration.name) });
      } catch {
        // ignore
      }
    }
  };

  if (setupLog.length > 0) {
    for (const line of setupLog) console.log(`  ${line}`);
  }

  activeHost = host;
  return host;
}

/**
 * Apply a partial config update from an integration. Handles the two
 * complex cases:
 *  - `integrations: [...]` — new integrations, queued for config:setup
 *  - `vite.plugins: [...]` — new Vite plugins, added to the host
 * Everything else is a shallow merge onto `config`.
 */
function applyConfigPatch(
  config: AstroConfig,
  patch: Record<string, unknown>,
  host: AstroHost,
  queue: AstroIntegration[],
  alreadySetup: WeakSet<AstroIntegration>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) continue;

    if (key === "integrations" && Array.isArray(value)) {
      const filtered = filterOverrides(value as AstroIntegration[], []);
      for (const integ of filtered) {
        if (config.integrations.includes(integ)) continue;
        if (alreadySetup.has(integ)) continue;
        config.integrations.push(integ);
        queue.push(integ);
      }
      continue;
    }

    if (key === "vite" && typeof value === "object") {
      const vitePatch = value as Record<string, unknown>;
      if (Array.isArray(vitePatch.plugins)) {
        // Flatten one level — integrations sometimes call
        // `updateConfig({ vite: { plugins: [...tailwindcss(), ...] } })`
        // where tailwindcss() returns an array.
        const flat: ViteLikePlugin[] = [];
        const walk = (arr: unknown[]) => {
          for (const item of arr) {
            if (Array.isArray(item)) walk(item);
            else if (item && typeof item === "object") flat.push(item as ViteLikePlugin);
          }
        };
        walk(vitePatch.plugins);
        const added = addVitePlugins(flat);
        if (added.length > 0) {
          syncServerPlugins(host.server);
        }
      }
      // Merge other vite fields (resolve.alias, server.proxy, etc.)
      config.vite = mergeDeep(config.vite ?? {}, { ...vitePatch, plugins: undefined });
      continue;
    }

    // Shallow merge for everything else
    if (typeof value === "object" && !Array.isArray(value)) {
      (config as Record<string, unknown>)[key] = {
        ...((config as Record<string, unknown>)[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      (config as Record<string, unknown>)[key] = value;
    }
  }
}

function filterOverrides(
  integrations: AstroIntegration[],
  log: string[],
): AstroIntegration[] {
  const out: AstroIntegration[] = [];
  for (const integration of integrations) {
    if (!integration || typeof integration !== "object") continue;
    const override = isOverridden(integration.name);
    if (override) {
      log.push(`↷ replaced ${integration.name} with ${override} (pavouk native)`);
      continue;
    }
    out.push(integration);
  }
  return out;
}

function mergeDeep<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] != null) {
      out[k] = mergeDeep(
        out[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Test reset */
export function __resetForTests(): void {
  activeHost = null;
}
