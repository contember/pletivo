import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes } from "./router";
import { matchRoute, resolveScriptRoute, type Route, type RouteParams, type StaticPath } from "@pletivo/core/router";
import { createPaginate } from "@pletivo/core/paginate";
import { escapeStyleEnd } from "@pletivo/core/inline-style";
import { getContentBaseDirs, initCollections, runWithBunContentRuntime } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "@pletivo/runtime/island";
import { runInPage, runWithRenderTracking, AstroCookies, MAX_REWRITE_DEPTH, type AstroResponse, type PageContext } from "@pletivo/runtime/astro-shim";
import { hydrationScript } from "@pletivo/runtime/hydration";
import { finalizeIslandScripts } from "@pletivo/runtime/astro-islands/index";
import { hmrClientScript } from "@pletivo/runtime/hmr-client";
import { devCss } from "./css";
import { extractAstroScopes, resolveScopedStyleStrategy } from "@pletivo/core/astro-host/scoped-style";
import { configureScopedStyleStrategy, registerAstroPlugin, getAstroCssForPage, getHoistedScriptByHash, getAllHoistedScripts, hoistedScriptBunPlugin, hoistedEntrypoint, getHoistedBundleCache, setHoistedBundleCache, HOISTED_URL_PATH } from "./astro-plugin";
import { bumpDevVersion, getDevVersion } from "@pletivo/core/dev-cache";
import { pageDoctype } from "@pletivo/core/page-doctype";
import { resolveCompressHTML } from "@pletivo/core/astro-host/compile-options";
import { bundlePageScripts } from "./astro-host/page-scripts";
import { ProjectConfigError, srcDirMismatch } from "./astro-host/config-loader";
import { configureMarkdown, resolveMarkdownOptions } from "@pletivo/core/content/markdown";
import { assertPageLayoutSupported } from "./markdown-page";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { configureMdModules, registerMdPlugin } from "./md-plugin";
import {
  initAstroHost,
  dispatchMiddlewares,
  bundleVirtualEntry,
  codeFromLoadResult,
  pluginLoad,
  pluginResolveId,
  type SetupFailure,
} from "./astro-host";
import { resolveConfigWatchFiles, watchConfigFiles, type ConfigWatcher } from "./dev-config-watch";
import { createSnapshotStore } from "./dev-snapshots";
import { createIdleRecycler, isHmrTransportPath, resolveIdleRecycleMs, type IdleRecycler } from "./dev-idle-recycle";
import { describeConfigChange, isSupervisedChild, RESTART_EXIT_CODE } from "./dev-supervisor";
import { resolveI18nConfig } from "@pletivo/core/i18n/config";
import { detectRouteLocale } from "@pletivo/core/i18n/route-expansion";
import { parsePreferredLocales } from "@pletivo/core/i18n/helpers";
import { setI18nRuntimeState } from "@pletivo/core/i18n/virtual-module";
import {
  setImageMode,
  parseCdnCgiImageUrl,
  resolveCfTargetFormat,
  transformCfImage,
  imageContentType,
  formatFromPath,
  formatFromContentType,
  sharpAvailable,
  setSharpResolveBase,
} from "./image";
import { setUrlAssetMode } from "./url-asset";
import { setBase, withBase, stripBase } from "@pletivo/runtime/base";
import {
  resolveFallbackRoute,
  resolveDefaultLocaleRedirect,
} from "@pletivo/core/i18n/fallback";
import { registerCssModulesPlugin, getCssModulesOutput } from "./css-modules";
import { registerProjectSourcePlugin } from "./project-source-plugin";
import { bundleRenderedIslands, setupAstroRenderers, type AstroRenderers } from "./astro-renderers";
import type { AstroIslandComponent } from "./astro-islands-bundle";
import { installImportMetaEnv } from "./import-meta-env";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import { islandPlugin, islandWrapperSource } from "./islands-bundle";
import { clearCollectedCss, clearJsImportedCssImportCache, collectCssSideEffectImports, collectPageModuleCss, configureJsImportedCss, cssSideEffectBunPlugin, jsOutputFromBuild, recordBuildCssOutputs } from "./js-imported-css";
import type { PletivoConfig } from "./config";
import type { Server, ServerWebSocket } from "bun";
import { createRequire } from "module";
import { withAstroMarkdownDefaults } from "./astro-markdown";
import { registerHtmlPlugin } from "./html-plugin";

const require_ = createRequire(import.meta.url);
const { version: PLETIVO_VERSION } = require_("../package.json");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Paths whose 2xx responses are dropped from the request log — they fire
// on every page load or on a heartbeat and would drown out user-visible
// requests. 4xx/5xx on these is still surfaced (a missing island bundle
// or a 500 from the styles pipeline is a real signal).
const LOG_NOISE_PREFIX = /^(\/__hmr|\/__styles\.css|\/__pletivo\/|\/_islands\/|\/@image\/)/;

// Static assets — fired by the browser as side effects of a page load,
// not user-visible navigations. Keeping them in the log buries the
// requests you actually care about (page renders, API calls, errors).
// Failures (4xx/5xx) still log so a missing image or font surfaces.
const LOG_STATIC_ASSET_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|css|map)(\?|$)/i;

function shouldSkipRequestLog(pathname: string, status: number): boolean {
  if (status >= 300) return false;
  if (LOG_NOISE_PREFIX.test(pathname)) return true;
  if (pathname.startsWith(HOISTED_URL_PATH)) return true;
  if (LOG_STATIC_ASSET_EXT.test(pathname)) return true;
  return false;
}

const IS_TTY = Boolean(process.stdout.isTTY);
const ANSI_DIM = "2";
const ANSI_RED = "31";
const ANSI_YELLOW = "33";
const ANSI_CYAN = "36";

function colorize(text: string, code: string): string {
  if (!IS_TTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * Did this request originate from another page on this server (a script,
 * image, fetch(), etc. fired by an already-loaded document)? Modern
 * browsers tell us via Sec-Fetch-Dest — anything other than "document"
 * is a subrequest. For curl or older clients without the header we fall
 * back to comparing Referer's path, treating same-origin different-path
 * referers as subrequests too.
 */
function isSubrequest(req: Request, origin: string, pathname: string): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest === "document") return false;
  if (dest) return true;
  const referer = req.headers.get("referer");
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return u.origin === origin && u.pathname !== pathname;
  } catch {
    return false;
  }
}

/**
 * Format an HMR transport event (ws/sse client connect or disconnect)
 * with the same column layout as request lines so the eye can scan a
 * single column for status. The whole line is dimmed because HMR
 * plumbing is not a user-visible signal; navigations and errors are.
 */
function logHmrEvent(transport: "ws" | "sse", action: "connected" | "disconnected", count: number): void {
  // HMR events have no duration — leave that column blank so it stays
  // semantically "ms" everywhere. Client total goes in the description.
  const blankDuration = " ".repeat(7);
  const line = `HMR  ${blankDuration}  ${transport.toUpperCase().padEnd(4)} client ${action} (${count} total)`;
  console.log(`  ${colorize(line, ANSI_DIM)}`);
}

function logRequest(
  method: string,
  pathname: string,
  status: number,
  ms: number,
  subrequest: boolean,
): void {
  if (shouldSkipRequestLog(pathname, status)) return;

  const statusStr = String(status).padEnd(3);
  const durationStr = `${ms} ms`.padStart(7);
  const methodStr = method.padEnd(4);

  // Successful subrequests dim the whole line so they group visually
  // under the most recent navigation. Failures (4xx/5xx) keep full
  // coloring — a missing asset is still a real signal.
  if (subrequest && status < 300) {
    console.log(`  ${colorize(`${statusStr}  ${durationStr}  ${methodStr} ${pathname}`, ANSI_DIM)}`);
    return;
  }

  const statusColor =
    status >= 500 ? ANSI_RED :
    status >= 400 ? ANSI_YELLOW :
    status >= 300 ? ANSI_CYAN :
    ANSI_DIM;
  const durationColor =
    ms >= 2000 ? ANSI_RED :
    ms >= 500 ? ANSI_YELLOW :
    ms < 20 ? ANSI_DIM :
    null;
  const statusCol = colorize(statusStr, statusColor);
  const durationCol = durationColor ? colorize(durationStr, durationColor) : durationStr;
  console.log(`  ${statusCol}  ${durationCol}  ${methodStr} ${pathname}`);
}

export function dev(projectRoot: string, config: PletivoConfig) {
  return runWithBunContentRuntime(() => devWithContentRuntime(projectRoot, config));
}

async function devWithContentRuntime(projectRoot: string, config: PletivoConfig) {
  const pagesDir = path.join(projectRoot, config.srcDir, "pages");
  const publicDir = path.join(projectRoot, config.publicDir);
  const islandsDir = path.join(projectRoot, config.srcDir, "islands");

  const sockets = new Set<ServerWebSocket<unknown>>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  const pollWaiters = new Set<(msg: string) => void>();

  function broadcastHmr(payload: string) {
    for (const ws of sockets) {
      ws.send(payload);
    }
    for (const ctrl of sseClients) {
      try {
        ctrl.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
      } catch {
        sseClients.delete(ctrl);
      }
    }
    for (const resolve of pollWaiters) {
      resolve(payload);
    }
  }

  await Promise.all([
    registerAstroPlugin(),
    registerMdxPlugin(),
    registerMdPlugin(),
    registerCssModulesPlugin(),
    registerScssPlugin(projectRoot),
    registerProjectSourcePlugin(projectRoot, config.srcDir),
  ]);
  const astroHost = await initAstroHost(projectRoot, "dev", (payload) => {
    broadcastHmr(JSON.stringify(payload));
  });
  if (astroHost) await registerHtmlPlugin();
  const srcDirError = srcDirMismatch(projectRoot, config.srcDir, astroHost?.configuredSrcDir);
  if (srcDirError) throw new ProjectConfigError(srcDirError);
  // Before initCollections: content.config.ts is the first project module imported.
  installImportMetaEnv({ mode: "dev", base: config.base, astroConfig: astroHost?.config });

  configureScopedStyleStrategy(resolveScopedStyleStrategy(astroHost?.config));
  configureMdx(resolveMdxOptions(config, astroHost?.config));
  const markdownOptions = resolveMarkdownOptions(astroHost?.config);
  configureMarkdown(astroHost ? await withAstroMarkdownDefaults(astroHost.config, markdownOptions) : markdownOptions);
  configureMdModules(projectRoot, config.base, astroHost?.config.trailingSlash, astroHost !== null);
  configureJsImportedCss(projectRoot, config.srcDir);
  // Before any project module loads: the renderers decide how its framework components compile.
  // Rewired after a failed astro:config:setup recovers, which may register renderers.
  let astroRenderers: AstroRenderers | null = null;
  let wiredRenderers = "";
  function rendererNames(): string {
    return (astroHost?.renderers ?? []).map((renderer) => renderer.name).join(", ");
  }
  async function wireAstroRenderers(): Promise<void> {
    const renderers = astroHost?.renderers ?? [];
    const names = rendererNames();
    if (astroRenderers !== null && names === wiredRenderers) return;
    astroRenderers = await setupAstroRenderers({
      projectRoot,
      renderers,
      base: typeof astroHost?.config.base === "string" ? astroHost.config.base : config.base,
      beforeHydrationScripts: astroHost?.injectedBeforeHydrationScripts ?? [],
    });
    wiredRenderers = names;
  }
  // A hook that fails only on a first pass (it needs a later integration's setup) passes on a retry.
  // Retry once now, so the process starts with the set a retry reaches and does not restart into it.
  if (astroHost && astroHost.setupErrors.length > 0) {
    const recovered = await astroHost.retryFailedSetup();
    if (recovered.length > 0) console.log(`  astro:config:setup recovered → ${recovered.join(", ")}`);
  }
  await wireAstroRenderers();
  {
    const vite = astroHost?.config.vite as
      | { css?: { preprocessorOptions?: { scss?: Record<string, unknown> } } }
      | undefined;
    configureScss(vite?.css?.preprocessorOptions?.scss);
  }

  // ── Failed astro:config:setup — surface it, then keep trying ──
  //
  // A hook that throws leaves its side effect undone (a generated module never
  // written, a route never injected) and the failure then resurfaces as
  // something unrelated — typically "Cannot find module" in a page that
  // imports what the hook was supposed to produce. Two things fix that: the
  // error rides along on the dev error overlay, and the hook gets re-run on
  // every file change (and, rate-limited, on requests) until it succeeds, so
  // fixing the cause heals the server without a restart.
  const SETUP_RETRY_INTERVAL_MS = 1000;
  let lastSetupRetry = 0;

  function setupErrors(): SetupFailure[] {
    return astroHost?.setupErrors ?? [];
  }

  async function retrySetup(force: boolean): Promise<void> {
    if (!astroHost || astroHost.setupErrors.length === 0) return;
    const now = Date.now();
    if (!force && now - lastSetupRetry < SETUP_RETRY_INTERVAL_MS) return;
    lastSetupRetry = now;
    const recovered = await astroHost.retryFailedSetup();
    if (recovered.length === 0) return;
    console.log(`  astro:config:setup recovered → ${recovered.join(", ")}`);
    // A recovered hook may have registered a renderer. A process wires one set (its compilers are
    // Bun plugins), so changing a wired set takes a new process, as a config change does.
    const names = rendererNames();
    if (wiredRenderers !== "" && names !== wiredRenderers) {
      const change = `framework renderers changed (${wiredRenderers} → ${names || "none"})`;
      if (isSupervisedChild()) {
        console.log(`\n  ${change} → restarting dev server\n`);
        void shutdown(RESTART_EXIT_CODE);
        return;
      }
      console.error(`  ${change}; restart \`pletivo dev\` to apply them`);
    } else {
      try {
        await wireAstroRenderers();
      } catch (error) {
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Whatever the hook (re)generated is a module some page already tried to
    // import. Bust the cache so the next render picks it up, and push the
    // browser off the error page.
    bumpDevVersion();
    broadcastHmr(JSON.stringify({ type: "reload" }));
  }

  await initCollections(projectRoot, config.srcDir);
  let routes = await scanRoutes(pagesDir, { html: astroHost !== null });
  // Resolve i18n once per dev-server start; renderPage uses it to set
  // Astro.currentLocale from the matched route and Astro.preferredLocale
  // from the incoming request's Accept-Language header. Null when the
  // user hasn't configured i18n, in which case the locale fields stay
  // undefined end-to-end.
  const i18n = resolveI18nConfig(astroHost?.config.i18n);
  // Seed the `astro:i18n` virtual module with the resolved config so
  // user templates can `import { getRelativeLocaleUrl } from
  // "astro:i18n"` and get correct URLs. Must happen before any .astro
  // page is imported.
  setI18nRuntimeState(
    i18n,
    (astroHost?.config.base as string | undefined) ?? "/",
    astroHost?.config.site as string | undefined,
  );
  setBase((astroHost?.config.base as string | undefined) ?? config.base ?? "/");
  setImageMode("dev");
  setUrlAssetMode("dev");
  // Resolve the optional `sharp` dep from the consumer project, not from
  // pletivo's own (possibly symlinked) location.
  setSharpResolveBase(projectRoot);
  // Mark the pletivo runtime so libraries can detect they run under pletivo
  // (e.g. @nuasite Image keeps emitting /cdn-cgi/image URLs because pletivo
  // serves the transform endpoint, instead of falling back to a raw <img>).
  (globalThis as Record<string, unknown>).__PLETIVO__ = true;

  function escapeHtmlSimple(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  type RenderOutcome =
    | { ok: true; html: string; response?: AstroResponse; cookies?: AstroCookies }
    // The page returned a Response itself (`Astro.redirect` / `Astro.rewrite`):
    // pass it through.
    | { ok: true; raw: Response }
    | { ok: false; error: unknown };

  /**
   * Backs `Astro.clientAddress`. Honours `x-forwarded-for` (dev behind a
   * proxy such as tudy) and otherwise asks Bun for the socket address.
   */
  function clientAddressOf(request: Request): string | undefined {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    return server?.requestIP(request)?.address;
  }

  /**
   * State carried into a rewritten render. `response` and `cookies` are the
   * *rewriting* page's: Astro shares one response across a rewrite, so a
   * cookie set before `return Astro.rewrite(...)` must still reach the
   * browser. `depth` guards against cycles.
   */
  interface RewriteContext {
    depth: number;
    response: AstroResponse;
    cookies: AstroCookies;
  }

  /**
   * Backs `Astro.rewrite` in dev: re-runs routing for `target` and serves that
   * route's response at the current URL.
   */
  async function resolveRewrite(
    target: string,
    req: Request,
    context: RewriteContext,
  ): Promise<Response | null> {
    if (context.depth > MAX_REWRITE_DEPTH) {
      throw new Error(
        `Astro.rewrite("${target}") exceeded ${MAX_REWRITE_DEPTH} hops (a cycle?)`,
      );
    }
    const rawPath = (target.split("?")[0] || "/").replace(/^\/+/, "/");
    const routePath = rawPath === "/" ? "/" : rawPath.replace(/\/$/, "");
    for (const route of routes) {
      const params = matchRoute(route, routePath);
      if (params === null) continue;
      const response = await resolveRoute(
        route,
        params,
        routePath,
        req,
        undefined,
        context,
      );
      if (response !== null) return response;
    }
    return null;
  }

  async function renderPage(
    route: Route,
    params: RouteParams,
    pathname: string,
    request: Request,
    localeOverride?: string,
    /** Set when this render is the target of an `Astro.rewrite`. */
    rewrittenFrom?: RewriteContext,
  ): Promise<RenderOutcome | null> {
    const fullPath = path.join(pagesDir, route.file);

    try {
      await assertPageLayoutSupported(fullPath, projectRoot);
      const importPath = fullPath + `?v=${getDevVersion()}`;
      const mod = await import(importPath);
      // Non-.astro page modules don't hit the astro plugin's onLoad, so
      // collect their CSS side-effect imports here for /__styles.css.
      await collectPageModuleCss(fullPath, `page:${route.file}`);
      if (resolveScriptRoute(route, mod).isEndpoint) {
        const response = await serveEndpoint(route, params, pathname, request);
        return response ? { ok: true, raw: response } : null;
      }
      const component = mod.default;

      if (typeof component !== "function") return null;

      const props = await routeProps(route, mod, params);
      if (props === null) return null;

      // Build Astro-style pageContext with url/site/params so .astro
      // templates that read `Astro.url.pathname` work correctly.
      const siteUrl = astroHost?.config.site ? new URL(astroHost.config.site) : undefined;
      const devHost = config.host === "0.0.0.0" ? "localhost" : config.host;
      const origin = siteUrl ? siteUrl.origin : `http://${devHost}:${config.port}`;
      let currentLocale: string | undefined;
      let preferredLocale: string | undefined;
      let preferredLocaleList: string[] = [];
      if (i18n) {
        currentLocale =
          localeOverride ?? detectRouteLocale(route, i18n).locale?.code;
        const accept = request.headers.get("accept-language");
        const parsed = parsePreferredLocales(i18n, accept);
        preferredLocale = parsed.preferredLocale;
        preferredLocaleList = parsed.preferredLocaleList;
      }
      // Backs `Astro.response` / `Astro.cookies` for this render; whatever
      // the page writes is merged into the dev server's Response below. A
      // rewritten render inherits the rewriting page's pair, so writes made
      // before `return Astro.rewrite(...)` survive.
      const astroResponse: AstroResponse = rewrittenFrom?.response ?? {
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      };
      const astroCookies = rewrittenFrom?.cookies ?? new AstroCookies(request);
      const pageContext = {
        url: new URL(pathname || "/", origin),
        site: siteUrl,
        params,
        request,
        currentLocale,
        preferredLocale,
        preferredLocaleList,
        response: astroResponse,
        cookies: astroCookies,
        rewrite: (target: string) =>
          resolveRewrite(target, request, {
            depth: (rewrittenFrom?.depth ?? 0) + 1,
            response: astroResponse,
            cookies: astroCookies,
          }),
        clientAddress: clientAddressOf(request),
      };

      resetIslandRegistry();
      const { value: renderResult, renderedModules, tsxStyles } = await runWithRenderTracking(async () => {
        let r = runInPage(pageContext, () => component({ ...props, __pageContext: pageContext }));
        if (r instanceof Promise) r = await r;
        return r;
      });

      // `return Astro.redirect(...)` — serve it as a real redirect. The
      // Response already carries the accumulated headers and cookies.
      if (renderResult instanceof Response) {
        return { ok: true, raw: renderResult };
      }

      let html: string;
      if (typeof renderResult === "string") {
        html = renderResult;
      } else if (renderResult && typeof renderResult === "object" && "__html" in renderResult) {
        html = (renderResult as { __html: string }).__html;
      } else {
        return null;
      }
      // Each Astro island carries its scripts; the page keeps the first of each, in document order.
      html = finalizeIslandScripts(html);
      const doctype = pageDoctype(html, { compressHTML: resolveCompressHTML(astroHost?.config), partial: Boolean(mod.partial) });

      // Inject dev stylesheet link + HMR / hydration scripts + any
      // integration-injected scripts (`injectScript('page', code)` from
      // Astro integrations). The stylesheet link is emitted unconditionally —
      // buildCss's Tailwind pipeline runs per-request, so even projects
      // without a manual <link> get styles.
      //
      // Scoped CSS from <style> blocks is inlined per-page: we match
      // astro scope ids present in this page's HTML to include only
      // relevant entries, avoiding cross-page leaks from unscoped rules.
      const styleLink = `<link rel="stylesheet" href="${withBase("/__styles.css")}">`;
      const pageAstroCss = await getAstroCssForPage({
        entryFile: fullPath,
        astroScopes: extractAstroScopes(html),
        renderedModules,
      });
      const pageTsxCss = tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
      const combinedCss = [pageAstroCss, pageTsxCss].filter(Boolean).join("\n");
      const scopedStyleTag = combinedCss ? `<style>${escapeStyleEnd(combinedCss)}</style>` : "";
      const beforeHydration = astroHost?.injectedBeforeHydrationScripts
        ?.map((s) => `<script type="module">${s}</script>`)
        .join("\n") ?? "";
      const hydrationBlock = getUsedIslands().size > 0
        ? (beforeHydration ? "\n" + beforeHydration : "") + "\n" + hydrationScript()
        : "";
      const scripts = hmrClientScript() + hydrationBlock;
      const pageScript = await devPageScript();
      const integrationScripts = astroHost
        ? [
            ...astroHost.injectedHeadScripts.map((s) => `<script>${s}</script>`),
            ...(pageScript === null ? [] : [`<script type="module">${pageScript}</script>`]),
          ].join("\n")
        : "";
      const headInjection = styleLink + "\n" + scopedStyleTag + "\n" + scripts + (integrationScripts ? "\n" + integrationScripts : "");
      if (html.includes("</head>")) {
        html = html.replace("</head>", () => headInjection + "\n</head>");
      } else if (html.includes("</body>")) {
        html = html.replace("</body>", () => headInjection + "\n</body>");
      } else {
        html += headInjection;
      }

      html = doctype + html;

      // Run registered Vite plugins' transformIndexHtml hooks. Nua CMS
      // relies on this being available even if it currently calls its own
      // html-processor from middleware instead.
      if (astroHost) {
        html = await astroHost.server.transformIndexHtml(pathname, html);
      }

      return { ok: true, html, response: astroResponse, cookies: astroCookies };
    } catch (e) {
      console.error(`Error rendering ${route.file}:`, e);
      return { ok: false, error: e };
    }
  }

  function formatDevErrorHtml(e: unknown): string {
    const msg = String(e instanceof Error ? e.stack || e.message : e);
    // A pending setup failure is usually the reason this render broke at all,
    // and its message names the actual file. Show it above the symptom.
    const pending = setupErrors();
    const context = pending.length
      ? `<pre data-pletivo-setup-error style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem 2rem 0">${escapeHtmlSimple(
          pending
            .map((f) => {
              const err = f.error;
              return `astro:config:setup failed in "${f.name}" — the page error below may be a side effect.\n${
                err instanceof Error ? err.stack || err.message : String(err)
              }`;
            })
            .join("\n\n"),
        )}</pre>`
      : "";
    return `<html><body>${context}<pre data-pletivo-error style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem">${escapeHtmlSimple(msg)}</pre>${hmrClientScript()}</body></html>`;
  }

  // Raw-error classification. Filtering only kicks in when either `stale` or
  // `errorPage` is configured — otherwise every request sees raw errors
  // (preserving the default behavior when no shielding is set up).
  const shieldingActive = !!(config.dev?.stale || config.dev?.errorPage);
  const debugHeaderName = (config.dev?.debugHeader || "x-pletivo-debug").toLowerCase();
  function seesRawErrors(req: Request): boolean {
    if (!shieldingActive) return true;
    return req.headers.get(debugHeaderName) !== null;
  }

  // The build's page-script bundle, rebuilt after a source change or a setup retry.
  let pageScriptBundle: { key: string; code: Promise<string | null> } | null = null;
  function devPageScript(): Promise<string | null> {
    const scripts = astroHost?.injectedPageScripts ?? [];
    const key = `${getDevVersion()}\0${scripts.join("\0")}`;
    if (pageScriptBundle?.key !== key) {
      pageScriptBundle = { key, code: bundlePageScripts(scripts, projectRoot) };
    }
    return pageScriptBundle.code;
  }

  async function buildDevHoistedScript(hash: string) {
    const result = await Bun.build({
      entrypoints: [hoistedEntrypoint(hash)],
      format: "esm",
      target: "browser",
      minify: false,
      plugins: [cssSideEffectBunPlugin(), hoistedScriptBunPlugin()],
    });
    if (result.success) {
      await recordBuildCssOutputs(result.outputs, `hoisted:${hash}`);
    }
    return result;
  }

  async function collectDevHoistedCss(): Promise<string | null> {
    clearCollectedCss("hoisted:");
    for (const entry of getAllHoistedScripts()) {
      await collectCssSideEffectImports(entry.sourceFile, entry.code, `hoisted:${entry.hash}`, {
        bundleExternalCss: false,
      });
      const result = await buildDevHoistedScript(entry.hash);
      if (!result.success) {
        return result.logs.map((log) => String(log)).join("\n");
      }
      const js = jsOutputFromBuild(result.outputs);
      if (js) {
        const bytes = new Uint8Array(await js.arrayBuffer());
        setHoistedBundleCache(entry.hash, bytes);
      }
    }
    return null;
  }

  // Per-pathname snapshot of the last HTML successfully served to a user, read when a later
  // render for the same path throws. Bounded, and stores nothing at all unless stale mode is
  // on to read it back — see dev-snapshots.ts.
  const snapshots = createSnapshotStore({ enabled: !!config.dev?.stale });

  const errorPagePath = config.dev?.errorPage
    ? path.resolve(projectRoot, config.dev.errorPage)
    : undefined;

  // Render a standalone component file (used for custom 404 + error pages).
  // Mirrors the CSS/HMR head injection that renderPage does, minus the
  // route-level integration scripts that don't apply to meta pages.
  async function renderComponentFile(
    fullPath: string,
    pageContext: PageContext = {},
  ): Promise<string | null> {
    const importPath = fullPath + `?v=${getDevVersion()}`;
    const mod = await import(importPath);
    await collectPageModuleCss(fullPath, `page:${fullPath}`);
    if (typeof mod.default !== "function") return null;
    resetIslandRegistry();
    const { value: result, renderedModules, tsxStyles } = await runWithRenderTracking(async () => {
      let r = runInPage(pageContext, () => mod.default({ __pageContext: pageContext }));
      if (r instanceof Promise) r = await r;
      return r;
    });
    let html: string;
    if (typeof result === "string") html = result;
    else if (result && typeof result === "object" && "__html" in result) html = (result as { __html: string }).__html;
    else return null;
    html = finalizeIslandScripts(html);
    const doctype = pageDoctype(html, { compressHTML: resolveCompressHTML(astroHost?.config), partial: Boolean(mod.partial) });

    const astroCss = await getAstroCssForPage({
      entryFile: fullPath,
      astroScopes: extractAstroScopes(html),
      renderedModules,
    });
    const tsxCss = tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
    const combinedCss = [astroCss, tsxCss].filter(Boolean).join("\n");
    const styleLink = `<link rel="stylesheet" href="${withBase("/__styles.css")}">`;
    const styleTag = combinedCss ? `<style>${escapeStyleEnd(combinedCss)}</style>` : "";
    const headInjection = `${styleLink}\n${styleTag}\n${hmrClientScript()}`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", () => headInjection + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", () => headInjection + "\n</body>");
    } else {
      html += headInjection;
    }
    html = doctype + html;
    return html;
  }

  /**
   * Props for a route's params, or null when a dynamic route cannot serve them
   * and the request should cascade to 404.
   */
  async function routeProps(
    route: Route,
    mod: Record<string, unknown>,
    params: RouteParams,
  ): Promise<Record<string, unknown> | null> {
    if (!route.isDynamic) return {};
    if (typeof mod.getStaticPaths === "function") {
      const paginate = createPaginate(route, config.base || "/", astroHost?.config.trailingSlash);
      const staticPaths: StaticPath[] = await mod.getStaticPaths({ paginate });
      const match = staticPaths.find((sp) => {
        return Object.entries(params).every(([k, v]) => sp.params[k] === v);
      });
      return match ? match.props || {} : null;
    }
    // `prerender = false`: an on-demand route has no path list to match
    // against — the params come from the URL, which is what a server
    // would do. A static build still cannot emit it, and says so
    // (see `warnDroppedSsrWrites` in build.ts); dev renders it, so pages
    // written for a server can be previewed instead of 404ing.
    return mod.prerender === false ? {} : null;
  }

  /**
   * Serve an endpoint route (`robots.txt.ts`, `rss.xml.ts`) by calling its
   * exported GET(). The handler's own Response is returned untouched, so it
   * keeps its status and Content-Type. A dynamic one serves only the params
   * its `getStaticPaths()` lists, like a dynamic page.
   */
  async function serveEndpoint(
    route: Route,
    params: RouteParams,
    pathname: string,
    req: Request,
  ): Promise<Response | null> {
    const fullPath = path.join(pagesDir, route.file);
    try {
      const mod = await import(fullPath + `?v=${getDevVersion()}`);
      if (typeof mod.GET !== "function") return null;
      const props = await routeProps(route, mod, params);
      if (props === null) return null;

      const siteUrl = astroHost?.config.site ? new URL(astroHost.config.site) : undefined;
      const devHost = config.host === "0.0.0.0" ? "localhost" : config.host;
      const origin = siteUrl ? siteUrl.origin : `http://${devHost}:${config.port}`;
      const url = new URL(pathname, origin);
      const response: unknown = await mod.GET({
        site: siteUrl,
        url,
        params,
        props,
        request: req,
        redirect: (dest: string, status = 302) => new Response(null, { status, headers: { Location: dest } }),
      });
      if (!(response instanceof Response)) {
        throw new Error(`${route.file}: endpoint GET() must return a Response`);
      }
      return response;
    } catch (e) {
      if (seesRawErrors(req)) {
        return new Response(formatDevErrorHtml(e as Error), {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      console.error(`Error rendering endpoint "${route.file}":`, e);
      return new Response("Endpoint error", { status: 500 });
    }
  }

  // Route rendering wrapper. Calls renderPage, then:
  // - success: update snapshot (for shielded requests), return Response
  // - miss (null): return null so the caller can cascade to the next route
  // - error: debug requests get raw stack trace; shielded requests get snapshot
  //   (if stale) → error page (if configured) → raw stack trace as last resort.
  async function resolveRoute(
    route: Route,
    params: RouteParams,
    pathname: string,
    req: Request,
    localeOverride?: string,
    rewrittenFrom?: RewriteContext,
  ): Promise<Response | null> {
    // Endpoint routes bypass the HTML render pipeline entirely — their GET()
    // owns the status and Content-Type, and the body must not be touched.
    if (route.isEndpoint) {
      return await serveEndpoint(route, params, pathname, req);
    }
    // Rate-limited: covers a fix landing somewhere no watcher sees.
    await retrySetup(false);
    const outcome = await renderPage(route, params, pathname, req, localeOverride, rewrittenFrom);
    if (outcome === null) return null;
    const htmlHeaders = { "Content-Type": "text/html; charset=utf-8" };
    if (outcome.ok) {
      if ("raw" in outcome) return outcome.raw;
      if (!seesRawErrors(req)) snapshots.remember(pathname, outcome.html);
      // Merge anything the page wrote to `Astro.response` / `Astro.cookies`.
      // Content-Type stays ours unless the page overrode it explicitly.
      const headers = new Headers(htmlHeaders);
      outcome.response?.headers.forEach((v, k) => headers.set(k, v));
      for (const cookie of outcome.cookies?.headers() ?? []) {
        headers.append("set-cookie", cookie);
      }
      return new Response(outcome.html, {
        status: outcome.response?.status ?? 200,
        headers,
      });
    }
    if (seesRawErrors(req)) {
      return new Response(formatDevErrorHtml(outcome.error), { headers: htmlHeaders });
    }
    if (config.dev?.stale) {
      const snap = snapshots.get(pathname);
      if (snap) return new Response(snap, { headers: htmlHeaders });
    }
    if (errorPagePath && fs.existsSync(errorPagePath)) {
      try {
        const html = await renderComponentFile(errorPagePath);
        if (html) return new Response(html, { headers: htmlHeaders });
      } catch (ee) {
        console.error("Error rendering errorPage:", ee);
      }
    }
    return new Response(formatDevErrorHtml(outcome.error), { headers: htmlHeaders });
  }

  const notFoundPagePath = config.notFoundPage
    ? path.resolve(projectRoot, config.notFoundPage)
    : undefined;

  async function render404(
    req?: Request,
    reqUrl?: URL,
  ): Promise<{ html: string; response: AstroResponse; cookies: AstroCookies } | null> {
    // Build the same Astro-style pageContext the normal render path does, so a
    // custom 404 page (and any component it pulls in, e.g. Seo reading
    // `Astro.url.pathname`) renders against a real `Astro.url`/`Astro.request`
    // instead of `undefined`.
    const siteUrl = astroHost?.config.site ? new URL(astroHost.config.site) : undefined;
    const devHost = config.host === "0.0.0.0" ? "localhost" : config.host;
    const origin = siteUrl ? siteUrl.origin : `http://${devHost}:${config.port}`;
    const response: AstroResponse = {
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
    };
    const cookies = new AstroCookies(req);
    const pageContext = {
      url: reqUrl ?? new URL("/", origin),
      site: siteUrl,
      params: {},
      request: req,
      currentLocale: undefined,
      preferredLocale: undefined,
      preferredLocaleList: [] as string[],
      response,
      cookies,
      rewrite: req
        ? (target: string) =>
            resolveRewrite(target, req, { depth: 1, response, cookies })
        : undefined,
      clientAddress: req ? clientAddressOf(req) : undefined,
    };
    // Explicit config override first; fall back to the pages/404.* convention.
    const candidates: string[] = [];
    if (notFoundPagePath) candidates.push(notFoundPagePath);
    for (const ext of astroHost ? [".tsx", ".jsx", ".astro", ".html"] : [".tsx", ".jsx", ".astro"]) {
      candidates.push(path.join(pagesDir, `404${ext}`));
    }
    for (const fullPath of candidates) {
      if (!fs.existsSync(fullPath)) continue;
      try {
        const html = await renderComponentFile(fullPath, pageContext);
        if (html) return { html, response, cookies };
      } catch (e) {
        console.error(`Error rendering 404 page ${fullPath}:`, e);
      }
    }
    return null;
  }

  async function dispatchRequest(
    req: Request,
    server: Server<undefined>,
    url: URL,
    pathname: string | null,
  ): Promise<Response | undefined> {
    // Cloudflare-style on-the-fly image resizing. In production these
    // `/cdn-cgi/image/<options>/<source>` URLs are served by Cloudflare's
    // edge; in dev we reimplement the common subset with sharp so the same
    // markup renders locally. Matched on the raw pathname — `/cdn-cgi/`
    // lives at the origin root, independent of the configured `base`.
    if (url.pathname.startsWith("/cdn-cgi/image/")) {
      return serveCdnCgiImage(req, url);
    }

    // Requests not under the configured base are 404'd outright.
    if (pathname === null) {
      return new Response("Not Found", { status: 404 });
    }

    // WebSocket upgrade for HMR — must bypass middleware chain
    if (pathname === "/__hmr") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // HMR ping — lightweight health check so the client can detect
    // whether the dev server is alive without triggering a full reload.
    if (pathname === "/__hmr_ping") {
      return new Response("ok", { status: 200 });
    }

    // SSE fallback for HMR when WebSocket is unavailable (e.g. behind
    // proxies that don't support WS upgrades).
    if (pathname === "/__hmr_sse") {
      let heartbeat: ReturnType<typeof setInterval>;
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          logHmrEvent("sse", "connected", sseClients.size);
          controller.enqueue(new TextEncoder().encode(":ok\n\n"));
          // Send comment heartbeat every 5s to prevent proxy idle timeout
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(":\n\n"));
            } catch {
              clearInterval(heartbeat);
              sseClients.delete(controller);
            }
          }, 5_000);
        },
        cancel(controller) {
          clearInterval(heartbeat);
          sseClients.delete(controller);
          logHmrEvent("sse", "disconnected", sseClients.size);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Long-poll fallback — last resort when both WS and SSE fail.
    // Hangs for up to 30s waiting for the next change, then returns.
    if (pathname === "/__hmr_poll") {
      const payload = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve("");
        }, 30_000);
        function onMessage(msg: string) {
          cleanup();
          resolve(msg);
        }
        function cleanup() {
          clearTimeout(timeout);
          pollWaiters.delete(onMessage);
        }
        pollWaiters.add(onMessage);
      });
      return new Response(payload || "noop", {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Route the request through the Astro integration middleware chain.
    // If a middleware ends the response itself (e.g. CMS API handler),
    // that Response is returned. Otherwise the chain exhausts and
    // `pletivoHandler` runs — integration middlewares that wrapped
    // res.write/res.end (e.g. CMS HTML marker) then see the page HTML
    // on its way out.
    if (astroHost) {
      const response = await dispatchMiddlewares(
        req,
        astroHost.server.__middlewares,
        () => pletivoHandler(req, url, pathname),
      );
      if (response) return response;
    }

    return (await pletivoHandler(req, url, pathname)) ?? new Response("Not Found", { status: 404 });
  }

  // Assigned below, once we know whether a supervisor is there to bring the server back.
  let idleRecycler: IdleRecycler | null = null;

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req, server) {
      return runWithBunContentRuntime(async () => {
        const url = new URL(req.url);
        const pathname = stripBase(url.pathname);
        const start = Date.now();
        const countsAsActivity =
          idleRecycler !== null && !isHmrTransportPath(pathname ?? url.pathname);
        if (countsAsActivity) idleRecycler?.requestStarted();
        try {
          const response = await dispatchRequest(req, server, url, pathname);
          if (response) {
            const logPath = pathname ?? url.pathname;
            const sub = isSubrequest(req, url.origin, logPath);
            logRequest(req.method, logPath, response.status, Date.now() - start, sub);
          }
          return response;
        } finally {
          if (countsAsActivity) idleRecycler?.requestFinished();
        }
      });
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        logHmrEvent("ws", "connected", sockets.size);
      },
      close(ws) {
        sockets.delete(ws);
        logHmrEvent("ws", "disconnected", sockets.size);
      },
      message() {},
    },
  });

  // In-memory cache of resized images, keyed by `<pathname>|<targetFormat>`.
  // Avoids re-encoding the same transform on every page load (e.g. a logo
  // repeated across pages). Local sources are invalidated by mtime; remote
  // sources are cached for the server's lifetime. Bounded to stay modest.
  const cdnImageCache = new Map<
    string,
    { data: Uint8Array<ArrayBuffer>; contentType: string; mtimeMs: number }
  >();
  const CDN_IMAGE_CACHE_MAX = 256;
  let warnedNoCdnSharp = false;

  async function serveCdnCgiImage(req: Request, url: URL): Promise<Response> {
    const parsed = parseCdnCgiImageUrl(url.pathname);
    if (!parsed) return new Response("Bad image request", { status: 400 });
    const { options, source } = parsed;

    const isRemote = /^https?:\/\//.test(source);
    let sourceFormat: string;
    let mtimeMs = 0;
    let localPath: string | null = null;

    if (isRemote) {
      sourceFormat = formatFromPath(source);
    } else {
      // Same-zone path → served from public/. Guard against traversal
      // outside the public root.
      const rel = source.replace(/^\/+/, "");
      const resolved = path.resolve(publicDir, rel);
      const resolvedPublic = path.resolve(publicDir);
      if (
        resolved !== resolvedPublic &&
        !resolved.startsWith(resolvedPublic + path.sep)
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      let stat: ReturnType<typeof fs.statSync> | null = null;
      try {
        stat = fs.statSync(resolved);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) {
        return new Response("Image source not found", { status: 404 });
      }
      localPath = resolved;
      mtimeMs = stat.mtimeMs;
      sourceFormat = formatFromPath(source);
    }

    const accept = req.headers.get("accept") ?? undefined;
    const targetFormat = resolveCfTargetFormat(options.format, sourceFormat, accept);

    const cacheKey = `${url.pathname}|${targetFormat}`;
    const cached = cdnImageCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) {
      return new Response(cached.data, {
        headers: { "Content-Type": cached.contentType, "Cache-Control": "no-cache" },
      });
    }

    // Load the source bytes (only on cache miss).
    let bytes: Uint8Array<ArrayBuffer>;
    let remoteFormat = sourceFormat;
    if (isRemote) {
      const upstream = await fetch(source).catch(() => null);
      if (!upstream || !upstream.ok) {
        return new Response("Image source not found", { status: 404 });
      }
      bytes = new Uint8Array(await upstream.arrayBuffer());
      remoteFormat =
        formatFromContentType(upstream.headers.get("content-type")) ?? sourceFormat;
    } else {
      bytes = new Uint8Array(await Bun.file(localPath!).arrayBuffer());
    }

    let data = bytes;
    let contentType = imageContentType(remoteFormat);
    try {
      const out = await transformCfImage(bytes, remoteFormat, options, accept);
      if (out) {
        data = out.data;
        contentType = out.contentType;
      } else if (remoteFormat !== "svg" && !sharpAvailable() && !warnedNoCdnSharp) {
        // out === null → sharp unavailable or SVG. For a non-SVG source
        // it means sharp is missing; warn once so the original bytes
        // being served as-is (no resize) isn't a silent mystery.
        warnedNoCdnSharp = true;
        console.warn(
          "  /cdn-cgi/image requested but sharp isn't installed — serving originals without resizing.",
        );
        console.warn("  Install sharp for dev image resizing: bun add sharp");
      }
      // out === null → sharp unavailable or SVG: serve the original bytes.
    } catch (e) {
      // A bad transform shouldn't 500 the page — fall back to the original.
      console.error(`cdn-cgi image transform failed for ${source}:`, e);
    }

    cdnImageCache.set(cacheKey, { data, contentType, mtimeMs });
    if (cdnImageCache.size > CDN_IMAGE_CACHE_MAX) {
      const oldest = cdnImageCache.keys().next().value;
      if (oldest !== undefined) cdnImageCache.delete(oldest);
    }

    return new Response(data, {
      headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
    });
  }

  // Astro island bundles, rebuilt on request once a component was hydrated or a file changed.
  const devIslandsDir = path.join(projectRoot, "node_modules", ".pletivo", "dev-islands");
  /** What an extensionless component import may resolve to, in Bun's order. */
  const SCRIPT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];
  /** The hydrated components still on disk, as of a dev version and a count of hydrated ones. */
  let bundledIslands: { version: number; hydrated: number; components: AstroIslandComponent[] } | null = null;
  let islandBundle: { key: string; done: Promise<void> } | null = null;

  /**
   * Whether a component is still on disk. Its path is the import as written, made absolute, so it
   * may lack an extension or name a directory. Checked on disk each time: Bun's resolver caches
   * directory listings, so it still finds a file renamed since. A package specifier is left to it.
   */
  function componentResolves(componentPath: string): boolean {
    if (!path.isAbsolute(componentPath)) {
      try {
        Bun.resolveSync(componentPath, projectRoot);
        return true;
      } catch {
        return false;
      }
    }
    const candidates = [componentPath, ...SCRIPT_EXTENSIONS.flatMap((ext) => [componentPath + ext, path.join(componentPath, `index${ext}`)])];
    return candidates.some((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
  }

  /**
   * Every component hydrated since start, by a page, an endpoint or the container API, that is
   * still on disk: a deleted or renamed one cannot be bundled and must not break the others.
   */
  function islandComponents(renderers: AstroRenderers): AstroIslandComponent[] {
    const hydrated = renderers.hydratedComponents();
    const version = getDevVersion();
    if (bundledIslands?.version !== version || bundledIslands.hydrated !== hydrated.length) {
      const components = hydrated.filter((component) => componentResolves(component.componentPath));
      bundledIslands = { version, hydrated: hydrated.length, components };
    }
    return bundledIslands.components;
  }

  async function serveAstroIslandBundle(renderers: AstroRenderers, pathname: string): Promise<Response | null> {
    const components = islandComponents(renderers);
    const ids = components.map((component) => `${component.componentPath}\0${component.exportName}`);
    const key = `${getDevVersion()}\0${ids.sort().join("\0")}`;
    if (islandBundle?.key !== key) {
      islandBundle = { key, done: bundleRenderedIslands(renderers, devIslandsDir, components) };
    }
    try {
      await islandBundle.done;
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
    const file = path.join(devIslandsDir, pathname);
    if (!file.startsWith(devIslandsDir + path.sep) || !fs.existsSync(file)) return null;
    return new Response(Bun.file(file), { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
  }

  async function pletivoHandler(req: Request, url: URL, pathname: string): Promise<Response | null> {
    {
      // Serve the morphdom ESM bundle for the HMR client's lazy import.
      // Resolve from this file's directory rather than the consumer's CWD so the
      // lookup walks up into pletivo's own node_modules — otherwise consumers
      // that don't list morphdom themselves get a 500 here and the HMR client
      // silently falls back to full-page reloads.
      if (pathname === "/__pletivo/morphdom.js") {
        try {
          const morphdomPath = require.resolve("morphdom/dist/morphdom-esm.js", {
            paths: [import.meta.dirname],
          });
          return new Response(Bun.file(morphdomPath), {
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
          });
        } catch {
          return new Response("morphdom not installed", { status: 500 });
        }
      }

      // Serve image assets in dev mode. `getImage()` returns URLs like
      // `/@image/hero.png?f=/abs/path/hero.png` that point to the
      // original unoptimized source file.
      if (pathname.startsWith("/@image/")) {
        const fsPathParam = url.searchParams.get("f");
        if (fsPathParam) {
          const file = Bun.file(fsPathParam);
          if (await file.exists()) {
            return new Response(file);
          }
        }
        return new Response("Image not found", { status: 404 });
      }

      // Serve `?url`-imported assets in dev mode. `registerUrlAsset()` returns
      // URLs like `/@asset/contact-form.js?f=/abs/path/contact-form.js` that
      // point to the original file, served as-is (Bun infers the content type).
      if (pathname.startsWith("/@asset/")) {
        const fsPathParam = url.searchParams.get("f");
        if (fsPathParam) {
          const file = Bun.file(fsPathParam);
          if (await file.exists()) {
            return new Response(file);
          }
        }
        return new Response("Asset not found", { status: 404 });
      }

      // Serve bundled CSS from src/ on-the-fly. Scoped styles from <style>
      // blocks are injected per-page as inline <style> tags, not here.
      if (pathname === "/__styles.css") {
        const hoistedCssError = await collectDevHoistedCss();
        if (hoistedCssError) {
          return new Response(`Hoisted script CSS collection failed:\n${hoistedCssError}`, { status: 500 });
        }
        let css = await devCss(projectRoot, config.srcDir);
        const cssModules = getCssModulesOutput();
        if (cssModules) css += "\n" + cssModules;
        return new Response(css, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      // Serve hoisted <script> bundles on-the-fly. The hash uniquely
      // identifies the script body, so a stale URL is never re-requested
      // — we cache the build output indefinitely.
      if (pathname.startsWith(HOISTED_URL_PATH) && pathname.endsWith(".js")) {
        const hash = pathname.slice(HOISTED_URL_PATH.length, -".js".length);
        const cached = getHoistedBundleCache(hash);
        if (cached) {
          return new Response(cached, {
            headers: { "Content-Type": "application/javascript" },
          });
        }
        if (!getHoistedScriptByHash(hash)) {
          return new Response("Hoisted script not found", { status: 404 });
        }
        const result = await buildDevHoistedScript(hash);
        const js = jsOutputFromBuild(result.outputs);
        if (result.success && js) {
          const bytes = new Uint8Array(await js.arrayBuffer());
          setHoistedBundleCache(hash, bytes);
          return new Response(bytes, {
            headers: { "Content-Type": "application/javascript" },
          });
        }
        const logs = result.logs.map((l) => String(l)).join("\n");
        return new Response(`Hoisted script bundle failed:\n${logs}`, { status: 500 });
      }

      if (astroRenderers && pathname.startsWith("/_astro/") && pathname.endsWith(".js")) {
        const served = await serveAstroIslandBundle(astroRenderers, pathname);
        if (served) return served;
      }

      // Serve island bundles on-the-fly
      if (pathname.startsWith("/_islands/")) {
        const name = pathname.slice("/_islands/".length).replace(/\.js$/, "");
        const candidates = [
          path.join(islandsDir, name + ".tsx"),
          path.join(islandsDir, name + ".ts"),
          path.join(islandsDir, name + ".jsx"),
          path.join(islandsDir, name + ".js"),
        ];

        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            const wrapper = islandWrapperSource(candidate);
            const tmpDir = path.join(projectRoot, "node_modules/.pletivo");
            const fsP = await import("fs/promises");
            await fsP.mkdir(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `${name}.ts`);
            await fsP.writeFile(tmpFile, wrapper);
            try {
              const result = await Bun.build({
                entrypoints: [tmpFile],
                format: "esm",
                minify: false,
                plugins: [islandPlugin(projectRoot)],
              });
              await fsP.unlink(tmpFile);
              if (result.success && result.outputs.length > 0) {
                return new Response(result.outputs[0], {
                  headers: { "Content-Type": "application/javascript" },
                });
              }
            } catch {
              await fsP.unlink(tmpFile).catch(() => {});
            }
          }
        }
        return new Response("Island not found", { status: 404 });
      }

      // Try static files from public/
      const publicPath = path.join(publicDir, pathname);
      const publicFile = Bun.file(publicPath);
      if (await publicFile.exists()) {
        const ext = path.extname(pathname);
        return new Response(publicFile, {
          headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
        });
      }

      // Route matching — try all matching routes so that when a dynamic
      // route's getStaticPaths doesn't contain the params we cascade to
      // the next matching route instead of falling through to 404.
      const routePath = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
      for (const route of routes) {
        const params = matchRoute(route, routePath);
        if (params !== null) {
          const response = await resolveRoute(route, params, routePath, req);
          if (response !== null) return response;
        }
      }

      // i18n fallback + default-locale redirect resolution. Kicks in
      // only when the user configured `i18n` and the regular route
      // match didn't produce a response. Matches Astro's behavior of
      // serving fallback content or 302-ing to the default locale.
      if (i18n) {
        const astroBase =
          (astroHost?.config.base as string | undefined) ?? config.base ?? "/";

        const redirectTo = resolveDefaultLocaleRedirect(
          routePath,
          routes,
          i18n,
          astroBase,
        );
        if (redirectTo) {
          return new Response(null, {
            status: 302,
            headers: { Location: redirectTo },
          });
        }

        const fallback = resolveFallbackRoute(
          routePath,
          routes,
          i18n,
          astroBase,
        );
        if (fallback) {
          if (fallback.mode === "redirect") {
            return new Response(null, {
              status: 302,
              headers: { Location: fallback.redirectTo ?? "/" },
            });
          }
          const response = await resolveRoute(
            fallback.route,
            fallback.params,
            routePath,
            req,
            fallback.targetLocale,
          );
          if (response !== null) return response;
        }
      }

      // Injected routes from integrations (injectRoute during config:setup).
      // Match against the request pathname and call the endpoint's GET handler
      // or render its default component.
      if (astroHost && astroHost.injectedRoutes.length > 0) {
        const cleanPathname = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
        for (const injected of astroHost.injectedRoutes) {
          const injectedPath = injected.pattern.startsWith("/") ? injected.pattern : "/" + injected.pattern;
          if (cleanPathname !== injectedPath) continue;
          try {
            const entrypoint = resolveInjectedEntrypoint(injected.entrypoint, projectRoot);
            await assertPageLayoutSupported(entrypoint, projectRoot);
            const importPath = entrypoint + `?v=${getDevVersion()}`;
            const mod = await import(importPath);
            if (typeof mod.GET === "function") {
              const siteUrl = astroHost.config.site ? new URL(astroHost.config.site) : undefined;
              const devHost = config.host === "0.0.0.0" ? "localhost" : config.host;
              const origin = siteUrl ? siteUrl.origin : `http://${devHost}:${config.port}`;
              const endpointUrl = new URL(cleanPathname, origin);
              const response: Response = await mod.GET({
                site: siteUrl,
                url: endpointUrl,
                params: {},
                props: {},
                request: req,
                redirect: (dest: string, status = 302) => new Response(null, { status, headers: { Location: dest } }),
              });
              return response;
            } else if (typeof mod.default === "function") {
              const fakeRoute: Route = {
                file: injected.entrypoint,
                segments: [],
                isDynamic: false,
                priority: 0,
                isEndpoint: false,
              };
              const response = await resolveRoute(fakeRoute, {}, cleanPathname, req);
              if (response !== null) return response;
            }
          } catch (e) {
            console.error(`Error rendering injected route "${injected.pattern}":`, e);
            return new Response(`Error: ${(e as Error).message}`, { status: 500 });
          }
        }
      }

      // Virtual-URL requests (e.g. `/@nuasite/cms-editor.js`,
      // `/@nuasite/notes-overlay`) are served by asking each registered
      // Astro-integration Vite plugin to `resolveId` the path, then
      // either taking its `load` result (pre-bundled, like CMS) or
      // bundling the resolved file entry point through Bun.build
      // (source, like notes overlay). Bundling runs Vite plugins'
      // `transform` hooks so integrations that prepend JSX pragmas or
      // do similar source rewrites work drop-in.
      if (astroHost && /^(\/@|\/virtual:)/.test(pathname)) {
        for (const p of astroHost.server.__plugins) {
          let resolved: string | null;
          try {
            resolved = await pluginResolveId(p, pathname);
          } catch {
            continue;
          }
          if (resolved === null) continue;

          // First try plugin-provided load() for pre-bundled content
          try {
            const loaded = await pluginLoad(p, resolved);
            if (loaded !== null) {
              return new Response(codeFromLoadResult(loaded), {
                headers: { "Content-Type": "application/javascript; charset=utf-8" },
              });
            }
          } catch {
            // fall through to bundling path
          }

          // No (usable) load() hook — resolved id is probably an
          // absolute file path. Bundle it through Bun.build with the
          // Vite transform chain applied.
          if (path.isAbsolute(resolved) && fs.existsSync(resolved)) {
            const bundled = await bundleVirtualEntry(resolved, projectRoot);
            if (bundled) {
              return new Response(bundled, {
                headers: { "Content-Type": "application/javascript; charset=utf-8" },
              });
            }
          }
        }
      }

      // Custom 404 page
      const custom404 = await render404(req, url);
      if (custom404) {
        // Same merge as the normal render path — a 404 page can set cache
        // headers or cookies. `status` starts at 404, so a page that wants a
        // different one (410, say) can still say so.
        const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
        custom404.response.headers.forEach((v, k) => headers.set(k, v));
        for (const cookie of custom404.cookies.headers()) {
          headers.append("set-cookie", cookie);
        }
        return new Response(custom404.html, {
          status: custom404.response.status,
          headers,
        });
      }

      return new Response("Not Found", { status: 404 });
    }
  }

  // Watch for file changes
  const srcDir = path.join(projectRoot, config.srcDir);
  const watcher = watch(srcDir, { recursive: true }, async (_event, filename) =>
    runWithBunContentRuntime(async () => {
      if (!filename) return;
      // Skip tmp files
      if (filename.includes("_tmp_")) return;
      bumpDevVersion();
      const ext = path.extname(filename).toLowerCase();
      const isCss = ext === ".css";
      const isScss = ext === ".scss" || ext === ".sass";
      if (/\.(css|js|jsx|ts|tsx|mjs|cjs)$/i.test(filename)) {
        clearJsImportedCssImportCache();
      }
      // scss changes: clear the cache so stale entries for deleted/renamed
      // files don't linger (active entries are overwritten on re-import).
      // Serve as a full reload so the page re-renders and re-imports scss
      // before the client fetches /__styles.css.
      if (isScss) clearScss();
      const hmrType = isCss ? "css" : isScss ? "reload" : "html";
      const clients = sockets.size + sseClients.size + pollWaiters.size;
      console.log(`  ${config.srcDir}/${filename} changed → ${hmrType} update (${clients} clients)`);

      if (filename.startsWith("content/") || /^content\.config\.(ts|mts|mjs|js)$/.test(filename)) {
        await initCollections(projectRoot, config.srcDir);
      }

      if (filename.startsWith("pages/")) {
        routes = await scanRoutes(pagesDir, { html: astroHost !== null });
      }

      // Forward to Astro host watcher — integrations like Nua CMS subscribe
      // to `change` / `add` / `unlink` events on `server.watcher`.
      if (astroHost) {
        const absPath = path.join(srcDir, filename);
        // Node's fs.watch uses "rename" for both creation and deletion.
        // Check if the file still exists to distinguish add/change vs unlink.
        const exists = fs.existsSync(absPath);
        const viteEvent = exists ? "change" : "unlink";
        astroHost.server.watcher.emit(viteEvent, absPath);
      }

      await retrySetup(true);
      broadcastHmr(JSON.stringify({ type: hmrType }));
    }),
  );

  try {
    watch(publicDir, { recursive: true }, () => {
      broadcastHmr(JSON.stringify({ type: "reload" }));
    });
  } catch {
    // no public dir
  }

  // Content that lives OUTSIDE `src/` — e.g. a project-root `content/` dir referenced by a
  // collection's `glob({ base })` — is invisible to the srcDir watcher above, so a CMS or
  // external write there never invalidates the collection cache and the preview keeps serving
  // stale entries. Watch each such content root's top-level project dir; on a change, drop the
  // collection cache (initCollections) and reload the page so getCollection re-reads from disk.
  const watchedContentRoots = new Set<string>();
  for (const baseDir of getContentBaseDirs(projectRoot)) {
    const rel = path.relative(projectRoot, baseDir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue; // outside the project
    const top = rel.split(path.sep)[0];
    if (!top || top === "." || top === config.srcDir) continue; // srcDir is already watched
    const rootDir = path.join(projectRoot, top);
    if (watchedContentRoots.has(rootDir) || !fs.existsSync(rootDir)) continue;
    watchedContentRoots.add(rootDir);
    try {
      watch(rootDir, { recursive: true }, async (_event, filename) =>
        runWithBunContentRuntime(async () => {
          if (!filename || filename.includes("_tmp_")) return;
          await initCollections(projectRoot, config.srcDir); // clears the collection cache
          if (astroHost) {
            const absPath = path.join(rootDir, filename);
            astroHost.server.watcher.emit(fs.existsSync(absPath) ? "change" : "unlink", absPath);
          }
          await retrySetup(true);
          broadcastHmr(JSON.stringify({ type: "html" }));
        }),
      );
      console.log(`  watching ${top}/ for content changes`);
    } catch {
      // dir vanished between existsSync and watch
    }
  }

  const displayHost = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`\n  pletivo v${PLETIVO_VERSION} dev server running at http://${displayHost}:${config.port}\n`);

  for (const failure of setupErrors()) {
    const err = failure.error;
    console.error(
      `  ⚠ astro:config:setup failed in "${failure.name}" — pages depending on it will error.\n` +
        `    ${err instanceof Error ? err.message : String(err)}\n` +
        `    Retrying on every file change; fix the cause and the server recovers without a restart.`,
    );
  }

  if (astroHost) {
    await astroHost.runServerStart({
      address: config.host === "0.0.0.0" ? "127.0.0.1" : config.host,
      port: config.port,
      family: "IPv4",
    });
  }

  // A dev server should survive a single bad render. If an async error escapes a
  // request (e.g. a component rendered via a promise the request handler can't
  // await — a `404.astro` reading `Astro.url` is the classic case), the default
  // runtime behaviour can terminate the process, which then needs a manual
  // restart. Log it loudly and keep serving instead.
  process.on("unhandledRejection", (reason) => {
    console.error("[pletivo] unhandled rejection (dev server kept alive):", reason);
  });

  let configWatcher: ConfigWatcher | null = null;
  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    watcher.close();
    configWatcher?.close();
    if (astroHost) {
      try {
        await astroHost.runServerDone();
        await astroHost.server.close();
      } catch {
        // ignore
      }
    }
    // A restart wants the port back now; a Ctrl-C can let requests finish.
    server.stop(code !== 0);
    process.exit(code);
  }

  process.on("SIGINT", () => {
    void shutdown(0);
  });

  // ── Config files: read once per process, so a change needs a new one ──
  //
  // Only under the supervisor — without a parent to bring the server back,
  // exiting on a config edit would just kill it.
  if (isSupervisedChild()) {
    const configFiles = await resolveConfigWatchFiles(projectRoot);
    if (configFiles.length > 0) {
      configWatcher = watchConfigFiles(configFiles, (file) => {
        console.log(`\n  ${describeConfigChange(projectRoot, file)} changed → restarting dev server\n`);
        void shutdown(RESTART_EXIT_CODE);
      });
    }

    // Same reasoning, same restart path: a server that has been idle for a while is holding
    // memory it can no longer give back, and only a new process returns it.
    idleRecycler = createIdleRecycler({
      thresholdMs: resolveIdleRecycleMs(config.dev?.idleRecycleMs),
      onRecycle: idleMs => {
        console.log(`\n  idle for ${Math.round(idleMs / 1000)}s → recycling dev server\n`);
        void shutdown(RESTART_EXIT_CODE);
      },
    });
  }
}

/**
 * Resolve an injected route entrypoint to an absolute file path.
 * Handles relative paths (./src/...) and bare specifiers (packages).
 */
function resolveInjectedEntrypoint(entrypoint: string, projectRoot: string): string {
  if (entrypoint.startsWith(".") || entrypoint.startsWith("/")) {
    return path.resolve(projectRoot, entrypoint);
  }
  return require.resolve(entrypoint, { paths: [projectRoot] });
}
