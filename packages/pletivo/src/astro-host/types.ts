/**
 * Shared types for pletivo's Astro integration host.
 *
 * These re-declare the shapes pletivo needs from `astro` to avoid an import
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
  "astro:routes:resolved": (ctx: AstroRoutesResolvedContext) => void | Promise<void>;
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
  trailingSlash: string;
  build: {
    format: "file" | "directory" | "preserve";
    client: URL;
    server: URL;
    assets: string;
    [key: string]: unknown;
  };
  integrations: AstroIntegration[];
  vite: ViteUserConfig;
  redirects: Record<string, string | { status: number; destination: string }>;
  i18n?: {
    defaultLocale: string;
    locales: Array<string | { path: string; codes: string[] }>;
    [key: string]: unknown;
  };
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

/**
 * Route shape passed to `astro:routes:resolved` and also used to populate
 * `pages` in `astro:build:done`. Mirrors a minimal subset of Astro's
 * internal route object — enough that `@astrojs/sitemap`,
 * `@nuasite/agent-summary`, and similar integrations can read what they
 * need without pletivo pulling in Astro's internals.
 */
export interface AstroRoute {
  /** "page" for rendered routes, "redirect" for config redirects, "endpoint" reserved */
  type: "page" | "redirect" | "endpoint";
  /**
   * Fully-resolved URL path for this route, without the leading slash
   * (`""` for the index, `"about"`, `"blog/hello"`). For dynamic pletivo
   * routes, each entry produced by `getStaticPaths` becomes its own
   * AstroRoute with the concrete pathname filled in.
   */
  pathname: string;
  /**
   * Original route pattern — the unexpanded form from the source
   * filename (`/`, `/about`, `/[category]`, `/kurzy/[slug]`). Used by
   * integrations that group dynamic children under their parent route.
   */
  route: string;
  /** Source file relative to the pages directory */
  component: string;
  /** Params map for dynamic routes, or empty for static routes */
  params: string[];
  /** Simple regex that matches the resolved pathname */
  pattern: RegExp;
  /**
   * Astro-compatible URL generator. Most integrations just call this
   * with the route's own pathname and treat it as an identity function;
   * we implement it that way.
   */
  generate(pathname?: string | Record<string, string>): string;
  /** Built file URL, populated in `astro:build:done` */
  distURL?: URL[];
  /** Redirect destination for `type: 'redirect'` routes */
  redirect?: { destination: string; status: number } | string;
  redirectRoute?: { pathname?: string; pattern?: string | RegExp };
  /** Astro i18n fallback chain — pletivo doesn't do i18n, always empty */
  fallbackRoutes: AstroRoute[];
  /** Prerender flag — always true for pletivo (SSG-only) */
  prerender: boolean;
  /** Route is a localized fallback — false */
  isIndex: boolean;
}

export interface AstroRoutesResolvedContext {
  routes: AstroRoute[];
  logger: IntegrationLogger;
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
  routes: AstroRoute[];
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
