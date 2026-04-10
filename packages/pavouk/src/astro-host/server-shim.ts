/**
 * ViteDevServer-shaped object that we hand to integrations' `configureServer`
 * and `astro:server:setup` hooks. Only the fields actually touched by the
 * integrations in our support set are implemented; unused corners are
 * no-op stubs.
 *
 * Notably:
 *  - `watcher` is a real EventEmitter. Nua CMS monkey-patches
 *    `watcher.emit`, so we need something that tolerates that.
 *  - `environments.{ssr,client}.{moduleGraph,hot}` are no-op stubs.
 *    Pavouk does full-reload HMR, so module graph invalidation is moot.
 *  - `close` is chainable (Nua CMS overrides it and calls the original).
 *  - `transformIndexHtml` walks registered Vite plugins in order.
 */

import { EventEmitter } from "node:events";
import type {
  ConnectMiddleware,
  ViteDevServerLike,
  ViteLikePlugin,
} from "./types";

export interface ServerShim extends ViteDevServerLike {
  /** Exposed so the dev fetch handler can dispatch the chain */
  __middlewares: ConnectMiddleware[];
  /** Let the runner attach plugins after server creation */
  __plugins: ViteLikePlugin[];
}

export type HmrBroadcast = (payload: { type: string; [key: string]: unknown }) => void;

export function createServerShim(projectRoot: string, hmrBroadcast?: HmrBroadcast): ServerShim {
  const middlewares: ConnectMiddleware[] = [];
  const plugins: ViteLikePlugin[] = [];
  const watcher = new EventEmitter() as EventEmitter & {
    add(p: string): void;
    setMaxListeners(n: number): void;
  };
  // Node EventEmitter already has setMaxListeners; we add .add as a stub
  watcher.add = (_p: string) => {};

  const shim: ServerShim = {
    config: { root: projectRoot },

    middlewares: {
      use(
        middlewareOrPath: string | ConnectMiddleware,
        maybeMiddleware?: ConnectMiddleware,
      ) {
        if (typeof middlewareOrPath === "string") {
          if (maybeMiddleware) {
            const prefix = middlewareOrPath;
            middlewares.push((req, res, next) => {
              const url = req.url || "";
              if (!url.startsWith(prefix)) {
                next();
                return;
              }
              // Strip the prefix, like Connect does
              req.url = url.slice(prefix.length) || "/";
              maybeMiddleware(req, res, next);
            });
          }
        } else {
          middlewares.push(middlewareOrPath);
        }
      },
    },

    watcher,

    async transformIndexHtml(url, html, _originalUrl) {
      let result = html;
      for (const p of plugins) {
        if (typeof p.transformIndexHtml === "function") {
          try {
            const out = await p.transformIndexHtml(result, { path: url });
            if (typeof out === "string") result = out;
          } catch (e) {
            console.error(
              `[pavouk-astro-host] ${p.name}.transformIndexHtml failed:`,
              (e as Error).message,
            );
          }
        }
      }
      return result;
    },

    environments: {
      ssr: {
        moduleGraph: {
          getModuleById: () => undefined,
          invalidateModule: () => {},
        },
        hot: {
          send: () => {},
        },
      },
      client: {
        hot: {
          send: (payload: unknown) => {
            if (hmrBroadcast && payload && typeof payload === "object" && (payload as Record<string, unknown>).type === "full-reload") {
              hmrBroadcast({ type: "reload" });
            }
          },
        },
      },
    },

    ws: { send: () => {} },

    async close() {
      // Integrations may override this; we keep a base no-op that resolves.
    },

    printUrls() {},

    __middlewares: middlewares,
    __plugins: plugins,
  };

  return shim;
}
