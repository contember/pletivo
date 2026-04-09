/**
 * Shared types for pavouk's Astro integration host.
 *
 * These re-declare the shapes pavouk needs from `astro` to avoid an import
 * cycle and to stay compatible across Astro versions. Only the fields that
 * at least one integration in our support set actually reads are modeled;
 * the rest are `unknown` or `any` on purpose.
 */

import type { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Astro integration shape ─────────────────────────────────────────

export interface AstroIntegration {
  name: string;
  hooks: Partial<AstroHooks>;
}

export interface AstroHooks {
  "astro:config:setup": (ctx: AstroConfigSetupContext) => void | Promise<void>;
  "astro:config:done": (ctx: AstroConfigDoneContext) => void | Promise<void>;
  "astro:server:setup": (ctx: AstroServerSetupContext) => void | Promise<void>;
  "astro:server:start": (ctx: AstroServerStartContext) => void | Promise<void>;
  "astro:server:done": (ctx: AstroServerDoneContext) => void | Promise<void>;
  "astro:build:start": (ctx: AstroBuildStartContext) => void | Promise<void>;
  "astro:build:setup": (ctx: AstroBuildSetupContext) => void | Promise<void>;
  "astro:build:generated": (ctx: AstroBuildGeneratedContext) => void | Promise<void>;
  "astro:build:ssr": (ctx: AstroBuildSsrContext) => void | Promise<void>;
  "astro:build:done": (ctx: AstroBuildDoneContext) => void | Promise<void>;
}

// ── Mutable Astro config view shared across hooks ───────────────────

export interface AstroConfig {
  root: URL;
  srcDir: URL;
  publicDir: URL;
  outDir: URL;
  site?: string;
  base: string;
  integrations: AstroIntegration[];
  vite: ViteUserConfig;
  redirects: Record<string, string | { status: number; destination: string }>;
  [key: string]: unknown;
}

export interface ViteUserConfig {
  plugins?: ViteLikePlugin[];
  resolve?: { alias?: Record<string, string> | Array<{ find: string | RegExp; replacement: string }> };
  server?: {
    proxy?: Record<string, unknown>;
    watch?: { usePolling?: boolean };
  };
  [key: string]: unknown;
}

export interface ViteLikePlugin {
  name: string;
  enforce?: "pre" | "post";
  resolveId?(id: string, importer?: string): string | null | undefined | Promise<string | null | undefined>;
  load?(id: string): LoadResult | null | undefined | Promise<LoadResult | null | undefined>;
  transform?(
    code: string,
    id: string,
  ): TransformResult | null | undefined | Promise<TransformResult | null | undefined>;
  configureServer?(server: ViteDevServerLike): void | Promise<void>;
  transformIndexHtml?(html: string, ctx?: { path: string }): string | Promise<string>;
  [key: string]: unknown;
}

export type LoadResult = string | { code: string; map?: unknown };
export type TransformResult = string | { code: string; map?: unknown };

// ── Integration hook contexts ───────────────────────────────────────

export type InjectScriptStage = "page" | "page-ssr" | "before-hydration" | "head-inline";

export interface AstroConfigSetupContext {
  config: AstroConfig;
  command: "dev" | "build" | "preview";
  isRestart: boolean;
  updateConfig(patch: DeepPartial<AstroConfig>): AstroConfig;
  addRenderer(renderer: unknown): void;
  addWatchFile(path: string | URL): void;
  addClientDirective(directive: unknown): void;
  addMiddleware(entry: { order?: "pre" | "post"; entrypoint: string | URL }): void;
  addDevToolbarApp(app: unknown): void;
  addPageExtension(ext: string | string[]): void;
  addContentEntryType(entryType: unknown): void;
  addDataEntryType(entryType: unknown): void;
  injectRoute(route: unknown): void;
  injectScript(stage: InjectScriptStage, content: string): void;
  logger: IntegrationLogger;
}

export interface AstroConfigDoneContext {
  config: AstroConfig;
  logger: IntegrationLogger;
  setAdapter(adapter: unknown): void;
  injectTypes(injectedType: { filename: string; content: string }): URL;
}

export interface AstroServerSetupContext {
  server: ViteDevServerLike;
  logger: IntegrationLogger;
  toolbar: { send(event: string, payload: unknown): void; onAppInitialized(): void; onAppToggled(): void };
}

export interface AstroServerStartContext {
  address: { address: string; port: number; family: string };
  logger: IntegrationLogger;
}

export interface AstroServerDoneContext {
  logger: IntegrationLogger;
}

export interface AstroBuildStartContext {
  logger: IntegrationLogger;
}

export interface AstroBuildSetupContext {
  target: "client" | "server";
  vite: ViteUserConfig;
  logger: IntegrationLogger;
  updateConfig(patch: ViteUserConfig): void;
  pages: Map<string, unknown>;
}

export interface AstroBuildGeneratedContext {
  dir: URL;
  logger: IntegrationLogger;
}

export interface AstroBuildSsrContext {
  manifest: unknown;
  entryPoints: Map<unknown, URL>;
  middlewareEntryPoint: URL | undefined;
  logger: IntegrationLogger;
}

export interface AstroBuildDoneContext {
  dir: URL;
  pages: Array<{ pathname: string }>;
  routes: Array<{
    component: string;
    pathname?: string;
    route: string;
    type: "page" | "endpoint";
    distURL?: URL[];
  }>;
  assets: Map<string, URL[]>;
  logger: IntegrationLogger;
}

// ── Logger ──────────────────────────────────────────────────────────

export interface IntegrationLogger {
  options: { dest: unknown; level: "info" | "warn" | "error" | "debug" };
  label: string;
  fork(label: string): IntegrationLogger;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ── ViteDevServer-shaped object our shim exposes ───────────────────

export interface ViteDevServerLike {
  config: { root: string; [key: string]: unknown };
  middlewares: {
    use(
      middlewareOrPath: string | ConnectMiddleware,
      maybeMiddleware?: ConnectMiddleware,
    ): void;
  };
  watcher: EventEmitter & {
    add(path: string): void;
    setMaxListeners(n: number): void;
  };
  transformIndexHtml(url: string, html: string, originalUrl?: string): Promise<string>;
  environments: {
    ssr: {
      moduleGraph: {
        getModuleById(id: string): { id: string } | undefined;
        invalidateModule(
          mod: { id: string } | undefined,
          seen?: unknown,
          timestamp?: number,
          isHmr?: boolean,
        ): void;
      };
      hot: { send(event: string, payload?: unknown): void };
    };
    client: {
      hot: { send(payload: { type: string; path?: string }): void };
    };
  };
  ws: { send(payload: unknown): void };
  close(): Promise<void>;
  printUrls(): void;
}

export type ConnectMiddleware = (
  req: IncomingMessage & { url?: string; originalUrl?: string },
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void | Promise<void>;

// ── Utility ─────────────────────────────────────────────────────────

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;
