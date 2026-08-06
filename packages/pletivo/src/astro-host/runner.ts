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
 *  5. Later, in build mode:
 *     - `astro:build:start` before any rendering
 *     - `astro:build:setup` once with target "client" (pletivo is SSG-only,
 *       there is no separate server target)
 *     - `astro:routes:resolved` after the route tree is known
 *     - `astro:build:generated` once all files are written
 *     - `astro:build:done` with dir + pages list
 *
 *  `astro:build:ssr` is intentionally never fired — pletivo has no SSR
 *  manifest to hand to it.
 *
 * This module is intentionally stateful — there is one host per pletivo
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
  InjectedRoute,
  InjectScriptStage,
  ViteLikePlugin,
} from "./types";
import { createLogger } from "./logger";
import { isOverridden } from "./overrides";
import { loadAstroConfig } from "./config-loader";
import {
  captureMdxIntegrationOptions,
  type CapturedMdxIntegrationOptions,
  type PluggableList,
  MDX_INTEGRATION_OPTIONS_KEY,
} from "../mdx-plugin";
import { createServerShim, type ServerShim, type HmrBroadcast } from "./server-shim";
import {
  __resetForTests as resetVitePluginHost,
  addVitePlugins,
  configureVitePluginHost,
  ensureBunPlugin,
  hasVitePluginNamed,
  runConfigureServer,
  syncServerPlugins,
} from "./vite-plugins";
import { stripTypes } from "../transpile";

/** An integration whose `astro:config:setup` threw, with its latest error. */
export interface SetupFailure {
  name: string;
  error: unknown;
}

export interface AstroHost {
  config: AstroConfig;
  server: ServerShim;
  /** Scripts injected via `injectScript('page', code)` — wrapped into <script type="module"> by dev/build */
  injectedPageScripts: string[];
  /** Scripts injected via `injectScript('head-inline', code)` — wrapped into inline <script> */
  injectedHeadScripts: string[];
  /** Scripts injected via `injectScript('before-hydration', code)` — run before island hydration */
  injectedBeforeHydrationScripts: string[];
  /** Scripts injected via `injectScript('page-ssr', code)` — executed at build time */
  injectedPageSsrScripts: string[];
  /** Routes injected via `injectRoute()` during config:setup */
  injectedRoutes: InjectedRoute[];
  /** Ran once on startup (setup + server:setup in dev; setup + config:done in build) */
  ready: Promise<void>;
  /**
   * Integrations whose `astro:config:setup` threw. A live array — dev reads it
   * after startup and on every failed render, so the overlay can name the real
   * cause instead of whatever the missing side effect broke downstream.
   */
  setupErrors: SetupFailure[];
  /**
   * Re-run `astro:config:setup` for the integrations in `setupErrors`, in
   * their original order. Returns the names that recovered.
   *
   * The retry runs against a deduplicating setup context, so a hook that got
   * partway through before throwing does not register its routes, scripts or
   * Vite plugins twice. Calls are serialized — a second caller awaits the
   * first one's result instead of starting a competing pass.
   */
  retryFailedSetup(): Promise<string[]>;
  /** Returns true if an integration with the given name is active after overrides */
  hasIntegration(name: string): boolean;
  runRoutesResolved(routes: AstroRoute[]): Promise<void>;
  runBuildStart(): Promise<void>;
  runBuildSetup(): Promise<void>;
  runBuildGenerated(distDir: string): Promise<void>;
  runBuildDone(
    routes: AstroRoute[],
    pages: Array<{ pathname: string }>,
    distDir: string,
  ): Promise<void>;
  runServerStart(address: { address: string; port: number; family: string }): Promise<void>;
  runServerDone(): Promise<void>;
}

let activeHost: AstroHost | null = null;
let activeHostRoot: string | null = null;

export function getHost(): AstroHost | null {
  return activeHost;
}

/**
 * Initialize the Astro host for the given project. Returns the existing
 * host when called again for the same `projectRoot` within a single
 * process; re-initializes for a different root (e.g. test harness
 * running multiple fixtures in one process).
 */
export async function initAstroHost(
  projectRoot: string,
  command: "dev" | "build",
  hmrBroadcast?: HmrBroadcast,
): Promise<AstroHost | null> {
  if (activeHost && activeHostRoot === projectRoot) return activeHost;
  // Drop any previous host so we don't mix integrations, injected
  // scripts, or resolved config across projects.
  activeHost = null;
  activeHostRoot = null;

  const config = await loadAstroConfig(projectRoot);
  if (!config) return null;
  configureVitePluginHost(projectRoot);

  // Seed astro:env virtual module with the env.schema from config
  try {
    const { setEnvSchema } = await import("../astro-plugin");
    const env = (config as Record<string, unknown>).env as Record<string, unknown> | undefined;
    setEnvSchema(env?.schema as Record<string, unknown> | undefined);
  } catch {
    // astro-plugin not yet loaded — env module will be empty
  }

  const server = createServerShim(projectRoot, hmrBroadcast);
  const injectedPageScripts: string[] = [];
  const injectedHeadScripts: string[] = [];
  const injectedBeforeHydrationScripts: string[] = [];
  const injectedPageSsrScripts: string[] = [];
  const injectedRoutes: InjectedRoute[] = [];
  const setupLog: string[] = [];
  const setupErrors: SetupFailure[] = [];
  /** Integrations to re-run, in setup order. Keyed so a repeat failure updates in place. */
  const failedSetup = new Map<AstroIntegration, SetupFailure>();

  const host: AstroHost = {
    config,
    server,
    injectedPageScripts,
    injectedHeadScripts,
    injectedBeforeHydrationScripts,
    injectedPageSsrScripts,
    injectedRoutes,
    ready: Promise.resolve(),
    setupErrors,
    retryFailedSetup: async () => [],
    hasIntegration: (name) => config.integrations.some((i) => i?.name === name),
    runRoutesResolved: async () => {},
    runBuildStart: async () => {},
    runBuildSetup: async () => {},
    runBuildGenerated: async () => {},
    runBuildDone: async () => {},
    runServerStart: async () => {},
    runServerDone: async () => {},
  };

  await ensureBunPlugin();

  // ── Filter overridden integrations from the initial root set ──
  const rootIntegrations = filterOverrides(config.integrations, setupLog, (captured) =>
    recordMdxIntegrationOptions(config, captured),
  );
  config.integrations = rootIntegrations;

  // ── Run config:setup on every integration ──
  const alreadySetup = new WeakSet<AstroIntegration>();
  const queue: AstroIntegration[] = [...rootIntegrations];

  // `dedupe` is on for retries only: the hook already ran once and may have
  // registered some of its side effects before throwing, so re-registering
  // them must be a no-op rather than a second copy.
  const makeSetupContext = (
    integration: AstroIntegration,
    dedupe = false,
  ): AstroConfigSetupContext => {
    const logger = createLogger(integration.name);
    return {
      config,
      command,
      // Stays false on retries — some integrations skip work when restarting,
      // and a retry exists precisely to make that work happen.
      isRestart: false,
      logger,
      updateConfig(patch) {
        applyConfigPatch(config, patch, host, queue, alreadySetup, dedupe);
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
      injectRoute(route: unknown) {
        if (!route || typeof route !== "object") return;
        const r = route as Record<string, unknown>;
        const pattern = r.pattern as string | undefined;
        const entrypoint = (r.entrypoint ?? r.entryPoint) as string | undefined;
        if (!pattern || !entrypoint) return;
        // SSG-only: reject routes that explicitly opt out of prerendering
        if (r.prerender === false) {
          logger.warn(`injectRoute "${pattern}" skipped (prerender: false not supported in SSG mode)`);
          return;
        }
        if (dedupe && injectedRoutes.some((x) => x.pattern === pattern && x.entrypoint === entrypoint)) return;
        injectedRoutes.push({ pattern, entrypoint, prerender: true });
      },
      injectScript(stage, content) {
        // Integrations may pass TypeScript here (Vite would otherwise
        // transform it). Strip TS once at injection time so dev/build
        // can emit the stored strings directly into <script> tags.
        const transpiled = stripTypes(content);
        const target: Record<InjectScriptStage, string[]> = {
          "page": injectedPageScripts,
          "head-inline": injectedHeadScripts,
          "before-hydration": injectedBeforeHydrationScripts,
          "page-ssr": injectedPageSsrScripts,
        };
        const bucket = target[stage];
        if (!bucket) return;
        if (dedupe && bucket.includes(transpiled)) return;
        bucket.push(transpiled);
      },
    };
  };

  /**
   * Run one integration's `astro:config:setup` and record the outcome.
   * Returns false when the hook threw — the integration then sits in
   * `failedSetup` until a `retryFailedSetup()` pass gets it through.
   */
  const runSetupHook = async (integration: AstroIntegration, dedupe: boolean): Promise<boolean> => {
    const hook = integration.hooks?.["astro:config:setup"];
    if (typeof hook !== "function") return true;

    try {
      await hook(makeSetupContext(integration, dedupe));
      setupLog.push(`✓ ${integration.name} configured`);
      failedSetup.delete(integration);
      return true;
    } catch (e) {
      console.error(
        `[pletivo-astro-host] ${integration.name}.astro:config:setup failed:`,
        (e as Error).stack ?? (e as Error).message,
      );
      failedSetup.set(integration, { name: integration.name, error: e });
      return false;
    }
  };

  /** Drain the setup queue, including children added through `updateConfig`. */
  const drainSetupQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const integration = queue.shift()!;
      if (alreadySetup.has(integration)) continue;
      alreadySetup.add(integration);
      await runSetupHook(integration, false);
    }
  };

  /** Mirror `failedSetup` into the live array dev reads. */
  const syncSetupErrors = (): void => {
    setupErrors.length = 0;
    setupErrors.push(...failedSetup.values());
  };

  let retryInFlight: Promise<string[]> | null = null;

  host.retryFailedSetup = async () => {
    if (retryInFlight) return retryInFlight;
    if (failedSetup.size === 0) return [];

    retryInFlight = (async () => {
      const recovered: string[] = [];
      for (const integration of [...failedSetup.keys()]) {
        if (await runSetupHook(integration, true)) recovered.push(integration.name);
      }
      // A recovered hook may have queued child integrations of its own.
      await drainSetupQueue();
      syncSetupErrors();
      if (recovered.length > 0) syncServerPlugins(server);
      return recovered;
    })();

    try {
      return await retryInFlight;
    } finally {
      retryInFlight = null;
    }
  };

  await drainSetupQueue();
  syncSetupErrors();

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
        `[pletivo-astro-host] ${integration.name}.astro:config:done failed:`,
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
          `[pletivo-astro-host] ${integration.name}.astro:server:setup failed:`,
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
          `[pletivo-astro-host] ${integration.name}.astro:routes:resolved failed:`,
          (e as Error).message,
        );
      }
    }
  };

  // ── astro:build:start — fired once before rendering begins ──
  host.runBuildStart = async () => {
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:build:start"];
      if (typeof hook !== "function") continue;
      try {
        await hook({ logger: createLogger(integration.name) });
      } catch (e) {
        console.error(
          `[pletivo-astro-host] ${integration.name}.astro:build:start failed:`,
          (e as Error).message,
        );
      }
    }
  };

  // ── astro:build:setup — pletivo has no Vite build phase, but we fire
  // this once with target "client" so integrations that use it to pin
  // their vite plugins to the build (rather than dev) still get a turn.
  // `updateConfig` is wired into the same plugin host as config:setup.
  host.runBuildSetup = async () => {
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:build:setup"];
      if (typeof hook !== "function") continue;
      try {
        await hook({
          target: "client",
          vite: config.vite ?? {},
          pages: new Map(),
          logger: createLogger(integration.name),
          updateConfig: (patch) => {
            if (Array.isArray(patch?.plugins)) {
              const flat: ViteLikePlugin[] = [];
              const walk = (arr: unknown[]) => {
                for (const item of arr) {
                  if (Array.isArray(item)) walk(item);
                  else if (item && typeof item === "object") flat.push(item as ViteLikePlugin);
                }
              };
              walk(patch.plugins);
              const added = addVitePlugins(flat);
              if (added.length > 0) syncServerPlugins(host.server);
            }
            config.vite = mergeDeep(config.vite ?? {}, { ...patch, plugins: undefined });
          },
        });
      } catch (e) {
        console.error(
          `[pletivo-astro-host] ${integration.name}.astro:build:setup failed:`,
          (e as Error).message,
        );
      }
    }
  };

  // ── astro:build:generated — files are on disk, but before build:done.
  // Integrations that post-process the output directory (rewriting
  // HTML, adding files beside pages) hook in here.
  host.runBuildGenerated = async (distDir) => {
    const dirUrl = pathToFileURL(distDir + path.sep);
    for (const integration of config.integrations) {
      const hook = integration.hooks?.["astro:build:generated"];
      if (typeof hook !== "function") continue;
      try {
        await hook({ dir: dirUrl, logger: createLogger(integration.name) });
      } catch (e) {
        console.error(
          `[pletivo-astro-host] ${integration.name}.astro:build:generated failed:`,
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
          `[pletivo-astro-host] ${integration.name}.astro:build:done failed:`,
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
          `[pletivo-astro-host] ${integration.name}.astro:server:start failed:`,
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
  activeHostRoot = projectRoot;
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
  // Set on a `retryFailedSetup()` pass. Identity checks are useless there —
  // a re-run hook builds fresh integration and plugin objects — so fall back
  // to matching by name.
  dedupe = false,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) continue;

    if (key === "integrations" && Array.isArray(value)) {
      const filtered = filterOverrides(value as AstroIntegration[], [], (captured) =>
        recordMdxIntegrationOptions(config, captured),
      );
      for (const integ of filtered) {
        if (config.integrations.includes(integ)) continue;
        if (alreadySetup.has(integ)) continue;
        if (dedupe && integ?.name && config.integrations.some((i) => i?.name === integ.name)) continue;
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
        const added = addVitePlugins(dedupe ? flat.filter((p) => !hasVitePluginNamed(p?.name)) : flat);
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
  onMdxOptions?: (captured: CapturedMdxIntegrationOptions) => void,
): AstroIntegration[] {
  const out: AstroIntegration[] = [];
  for (const integration of integrations) {
    if (!integration || typeof integration !== "object") continue;
    const override = isOverridden(integration.name);
    if (override) {
      log.push(`↷ replaced ${integration.name} with ${override} (pletivo native)`);
      if (integration.name === "@astrojs/mdx") {
        const captured = captureMdxIntegrationOptions(integration);
        if (captured) {
          const { remarkPlugins, rehypePlugins, gfm, unsupportedKeys } = captured;
          if (remarkPlugins.length || rehypePlugins.length) {
            log.push(
              `  ↳ forwarded ${remarkPlugins.length} remark + ${rehypePlugins.length} rehype plugin(s) from @astrojs/mdx options`,
            );
          }
          // Record whenever there's anything to carry — plugins or an explicit
          // gfm override (which has no plugins of its own).
          if (remarkPlugins.length || rehypePlugins.length || gfm !== undefined) {
            onMdxOptions?.(captured);
          }
          if (unsupportedKeys.length) {
            log.push(
              `  ⚠ @astrojs/mdx option(s) not supported by pletivo's native MDX, ignored: ${unsupportedKeys.join(", ")}`,
            );
          }
        }
      }
      continue;
    }
    out.push(integration);
  }
  return out;
}

/**
 * Merge remark/rehype plugins extracted from a `mdx({...})` call into the
 * loaded config so `resolveMdxOptions` can forward them to the native MDX
 * compiler. Accumulates across multiple `@astrojs/mdx` integrations.
 */
function recordMdxIntegrationOptions(
  config: AstroConfig,
  captured: CapturedMdxIntegrationOptions,
): void {
  const existing = config[MDX_INTEGRATION_OPTIONS_KEY] as
    | { remarkPlugins: PluggableList; rehypePlugins: PluggableList; gfm?: boolean }
    | undefined;
  config[MDX_INTEGRATION_OPTIONS_KEY] = {
    remarkPlugins: [...(existing?.remarkPlugins ?? []), ...captured.remarkPlugins],
    rehypePlugins: [...(existing?.rehypePlugins ?? []), ...captured.rehypePlugins],
    gfm: captured.gfm ?? existing?.gfm,
  };
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
  activeHostRoot = null;
  resetVitePluginHost();
}
