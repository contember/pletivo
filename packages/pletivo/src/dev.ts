import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes, findRoute, matchRoute, type Route, type StaticPath } from "./router";
import { createPaginate } from "./paginate";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { runWithRenderTracking } from "./runtime/astro-shim";
import { hydrationScript } from "./runtime/hydration";
import { hmrClientScript } from "./runtime/hmr-client";
import { devCss } from "./css";
import { registerAstroPlugin, getScopedCssForPage, extractAstroClasses, getGlobalCssForPage, getHoistedScriptByHash, hoistedScriptBunPlugin, hoistedEntrypoint, getHoistedBundleCache, setHoistedBundleCache, HOISTED_URL_PATH } from "./astro-plugin";
import { bumpDevVersion, getDevVersion } from "./dev-cache";
import { parseMarkdown, configureMarkdown, resolveMarkdownOptions } from "./content/markdown";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { initAstroHost, dispatchMiddlewares, bundleVirtualEntry } from "./astro-host";
import { resolveI18nConfig } from "./i18n/config";
import { detectRouteLocale } from "./i18n/route-expansion";
import { parsePreferredLocales } from "./i18n/helpers";
import { setI18nRuntimeState } from "./i18n/virtual-module";
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
import { setBase, withBase, stripBase } from "./base";
import {
  resolveFallbackRoute,
  resolveDefaultLocaleRedirect,
} from "./i18n/fallback";
import { registerCssModulesPlugin, getCssModulesOutput } from "./css-modules";
import { registerDevTsPlugin } from "./dev-ts-plugin";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import type { PletivoConfig } from "./config";
import type { Server, ServerWebSocket } from "bun";
import { createRequire } from "module";

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

export async function dev(projectRoot: string, config: PletivoConfig) {
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
    registerCssModulesPlugin(),
    registerScssPlugin(projectRoot),
    registerDevTsPlugin(projectRoot, config.srcDir),
  ]);
  const astroHost = await initAstroHost(projectRoot, "dev", (payload) => {
    broadcastHmr(JSON.stringify(payload));
  });
  configureMdx(resolveMdxOptions(config, astroHost?.config));
  configureMarkdown(resolveMarkdownOptions(astroHost?.config));
  {
    const vite = astroHost?.config.vite as
      | { css?: { preprocessorOptions?: { scss?: Record<string, unknown> } } }
      | undefined;
    configureScss(vite?.css?.preprocessorOptions?.scss);
  }
  await initCollections(projectRoot);
  let routes = await scanRoutes(pagesDir);
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

  async function renderPage(
    route: Route,
    params: Record<string, string>,
    pathname: string = "/",
    request?: Request,
    localeOverride?: string,
  ): Promise<string | null> {
    const fullPath = path.join(pagesDir, route.file);

    try {
      // Markdown pages — render directly without module import
      if (route.file.endsWith(".md")) {
        const source = await Bun.file(fullPath).text();
        const { html: body, frontmatter } = await parseMarkdown(source);
        const title = (frontmatter.title as string) || "";
        return `<!DOCTYPE html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>`;
      }

      const importPath = fullPath + `?v=${getDevVersion()}`;
      const mod = await import(importPath);
      const component = mod.default;

      if (typeof component !== "function") return null;

      let props: Record<string, unknown> = {};

      if (route.isDynamic) {
        if (typeof mod.getStaticPaths !== "function") {
          // Dynamic route without getStaticPaths — cannot resolve, treat as miss
          return null;
        }
        const paginate = createPaginate(route, config.base || "/");
        const staticPaths: StaticPath[] = await mod.getStaticPaths({ paginate });
        const match = staticPaths.find((sp) => {
          return Object.entries(params).every(([k, v]) => sp.params[k] === v);
        });
        if (!match) {
          // No matching static path — cascade to 404
          return null;
        }
        props = match.props || {};
      }

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
        const accept = request?.headers.get("accept-language");
        const parsed = parsePreferredLocales(i18n, accept);
        preferredLocale = parsed.preferredLocale;
        preferredLocaleList = parsed.preferredLocaleList;
      }
      const pageContext = {
        url: new URL(pathname || "/", origin),
        site: siteUrl,
        params,
        request,
        currentLocale,
        preferredLocale,
        preferredLocaleList,
      };

      resetIslandRegistry();
      const { value: renderResult, renderedModules, tsxStyles } = await runWithRenderTracking(async () => {
        let r = component({ ...props, __pageContext: pageContext });
        if (r instanceof Promise) r = await r;
        return r;
      });

      let html: string;
      if (typeof renderResult === "string") {
        html = renderResult;
      } else if (renderResult && typeof renderResult === "object" && "__html" in renderResult) {
        html = (renderResult as { __html: string }).__html;
      } else {
        return null;
      }

      // Inject dev stylesheet link + HMR / hydration scripts + any
      // integration-injected scripts (`injectScript('page', code)` from
      // Astro integrations). The stylesheet link is emitted unconditionally —
      // buildCss's Tailwind pipeline runs per-request, so even projects
      // without a manual <link> get styles.
      //
      // Scoped CSS from <style> blocks is inlined per-page: we match
      // astro scope classes present in this page's HTML to include only
      // relevant entries, avoiding cross-page leaks from unscoped rules.
      const styleLink = `<link rel="stylesheet" href="${withBase("/__styles.css")}">`;
      const pageAstroClasses = extractAstroClasses(html);
      const pageScopedCss = getScopedCssForPage(pageAstroClasses);
      const pageGlobalCss = getGlobalCssForPage(renderedModules);
      const pageTsxCss = tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
      const combinedCss = [pageGlobalCss, pageScopedCss, pageTsxCss].filter(Boolean).join("\n");
      const scopedStyleTag = combinedCss ? `<style>${combinedCss}</style>` : "";
      const beforeHydration = astroHost?.injectedBeforeHydrationScripts
        ?.map((s) => `<script type="module">${s}</script>`)
        .join("\n") ?? "";
      const hydrationBlock = getUsedIslands().size > 0
        ? (beforeHydration ? "\n" + beforeHydration : "") + "\n" + hydrationScript()
        : "";
      const scripts = hmrClientScript() + hydrationBlock;
      const integrationScripts = astroHost
        ? [
            ...astroHost.injectedHeadScripts.map((s) => `<script>${s}</script>`),
            ...astroHost.injectedPageScripts.map((s) => `<script type="module">${s}</script>`),
          ].join("\n")
        : "";
      const headInjection = styleLink + "\n" + scopedStyleTag + "\n" + scripts + (integrationScripts ? "\n" + integrationScripts : "");
      if (html.includes("</head>")) {
        html = html.replace("</head>", headInjection + "\n</head>");
      } else if (html.includes("</body>")) {
        html = html.replace("</body>", headInjection + "\n</body>");
      } else {
        html += headInjection;
      }

      if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
        html = "<!DOCTYPE html>\n" + html;
      }

      // Run registered Vite plugins' transformIndexHtml hooks. Nua CMS
      // relies on this being available even if it currently calls its own
      // html-processor from middleware instead.
      if (astroHost) {
        html = await astroHost.server.transformIndexHtml(pathname, html);
      }

      return html;
    } catch (e) {
      console.error(`Error rendering ${route.file}:`, e);
      return `<html><body><pre data-pletivo-error style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem">${escapeHtmlSimple(String(e instanceof Error ? e.stack || e.message : e))}</pre>${hmrClientScript()}</body></html>`;
    }
  }

  async function render404(): Promise<string | null> {
    for (const ext of [".tsx", ".jsx", ".astro"]) {
      const fullPath = path.join(pagesDir, `404${ext}`);
      if (fs.existsSync(fullPath)) {
        try {
          const mod = await import(fullPath + `?v=${getDevVersion()}`);
          if (typeof mod.default === "function") {
            resetIslandRegistry();
            const { value: result, renderedModules: rm404, tsxStyles: tsx404 } = await runWithRenderTracking(async () => {
              let r = mod.default({});
              if (r instanceof Promise) r = await r;
              return r;
            });
            let html: string;
            if (typeof result === "string") html = result;
            else if (result && typeof result === "object" && "__html" in result) html = (result as { __html: string }).__html;
            else return null;

            const classes404 = extractAstroClasses(html);
            const scoped404 = getScopedCssForPage(classes404);
            const global404 = getGlobalCssForPage(rm404);
            const tsx404Css = tsx404.length > 0 ? tsx404.join("\n") : "";
            const combined404 = [global404, scoped404, tsx404Css].filter(Boolean).join("\n");
            const styleTag404 = combined404 ? `<style>${combined404}</style>` : "";
            const headInjection404 = `<link rel="stylesheet" href="${withBase("/__styles.css")}">\n${styleTag404}\n${hmrClientScript()}`;
            if (html.includes("</head>")) {
              html = html.replace("</head>", headInjection404 + "\n</head>");
            } else {
              html = html + headInjection404;
            }
            return html;
          }
        } catch {
          return null;
        }
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

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = stripBase(url.pathname);
      const start = Date.now();
      const response = await dispatchRequest(req, server, url, pathname);
      if (response) {
        const logPath = pathname ?? url.pathname;
        const sub = isSubrequest(req, url.origin, logPath);
        logRequest(req.method, logPath, response.status, Date.now() - start, sub);
      }
      return response;
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
    { data: Uint8Array; contentType: string; mtimeMs: number }
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
    let bytes: Uint8Array;
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

      // Serve bundled CSS from src/ on-the-fly. Scoped styles from <style>
      // blocks are injected per-page as inline <style> tags, not here.
      if (pathname === "/__styles.css") {
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
        const result = await Bun.build({
          entrypoints: [hoistedEntrypoint(hash)],
          format: "esm",
          target: "browser",
          minify: false,
          plugins: [hoistedScriptBunPlugin()],
        });
        if (result.success && result.outputs.length > 0) {
          const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
          setHoistedBundleCache(hash, bytes);
          return new Response(bytes, {
            headers: { "Content-Type": "application/javascript" },
          });
        }
        const logs = result.logs.map((l) => String(l)).join("\n");
        return new Response(`Hoisted script bundle failed:\n${logs}`, { status: 500 });
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
            const wrapper =
              `import { hydrate, h } from "preact";\n` +
              `import Component from "${candidate}";\n` +
              `export function mount(el, props) { hydrate(h(Component, props), el); }\n`;
            const tmpDir = path.join(projectRoot, "node_modules/.pletivo");
            const fsP = await import("fs/promises");
            await fsP.mkdir(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `${name}.ts`);
            await fsP.writeFile(tmpFile, wrapper);
            try {
              const preactJsx = require.resolve("preact/jsx-runtime");
              const preactHooks = require.resolve("preact/hooks");
              const islandPlugin = {
                name: "pletivo-island",
                setup(build: any) {
                  build.onResolve({ filter: /^pletivo\/jsx-runtime$/ }, () => ({ path: preactJsx }));
                  build.onResolve({ filter: /^pletivo\/jsx-dev-runtime$/ }, () => ({ path: preactJsx }));
                  build.onResolve({ filter: /^pletivo\/hooks$/ }, () => ({ path: preactHooks }));
                },
              };
              const result = await Bun.build({
                entrypoints: [tmpFile],
                format: "esm",
                minify: false,
                plugins: [islandPlugin],
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
          const html = await renderPage(route, params, routePath, req);
          if (html !== null) {
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
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
          const html = await renderPage(
            fallback.route,
            fallback.params,
            routePath,
            req,
            fallback.targetLocale,
          );
          if (html !== null) {
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
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
              };
              const html = await renderPage(fakeRoute, {}, cleanPathname, req);
              if (html !== null) {
                return new Response(html, {
                  headers: { "Content-Type": "text/html; charset=utf-8" },
                });
              }
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
          const resolveId = (p as { resolveId?: (id: string) => unknown }).resolveId;
          if (typeof resolveId !== "function") continue;
          let resolved: unknown;
          try {
            resolved = await resolveId(pathname);
          } catch {
            continue;
          }
          if (typeof resolved !== "string") continue;

          // First try plugin-provided load() for pre-bundled content
          const load = (p as { load?: (id: string) => unknown }).load;
          if (typeof load === "function") {
            try {
              const loaded = await load(resolved);
              if (loaded != null) {
                const code = typeof loaded === "string" ? loaded : (loaded as { code: string }).code;
                return new Response(code, {
                  headers: { "Content-Type": "application/javascript; charset=utf-8" },
                });
              }
            } catch {
              // fall through to bundling path
            }
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
      const custom404 = await render404();
      if (custom404) {
        return new Response(custom404, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    }
  }

  // Watch for file changes
  const srcDir = path.join(projectRoot, config.srcDir);
  const watcher = watch(srcDir, { recursive: true }, async (event, filename) => {
    if (!filename) return;
    // Skip tmp files
    if (filename.includes("_tmp_")) return;
    bumpDevVersion();
    const ext = path.extname(filename).toLowerCase();
    const isCss = ext === ".css";
    const isScss = ext === ".scss" || ext === ".sass";
    // scss changes: clear the cache so stale entries for deleted/renamed
    // files don't linger (active entries are overwritten on re-import).
    // Serve as a full reload so the page re-renders and re-imports scss
    // before the client fetches /__styles.css.
    if (isScss) clearScss();
    const hmrType = isCss ? "css" : isScss ? "reload" : "html";
    const clients = sockets.size + sseClients.size + pollWaiters.size;
    console.log(`  ${config.srcDir}/${filename} changed → ${hmrType} update (${clients} clients)`);

    if (filename.startsWith("content/") || filename === "content.config.ts") {
      await initCollections(projectRoot);
    }

    if (filename.startsWith("pages/")) {
      routes = await scanRoutes(pagesDir);
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

    broadcastHmr(JSON.stringify({ type: hmrType }));
  });

  try {
    watch(publicDir, { recursive: true }, () => {
      broadcastHmr(JSON.stringify({ type: "reload" }));
    });
  } catch {
    // no public dir
  }

  const displayHost = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`\n  pletivo v${PLETIVO_VERSION} dev server running at http://${displayHost}:${config.port}\n`);

  if (astroHost) {
    await astroHost.runServerStart({
      address: config.host === "0.0.0.0" ? "127.0.0.1" : config.host,
      port: config.port,
      family: "IPv4",
    });
  }

  process.on("SIGINT", async () => {
    watcher.close();
    if (astroHost) {
      try {
        await astroHost.runServerDone();
        await astroHost.server.close();
      } catch {
        // ignore
      }
    }
    server.stop();
    process.exit(0);
  });
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
