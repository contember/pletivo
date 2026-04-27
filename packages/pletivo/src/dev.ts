import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes, matchRoute, type Route, type StaticPath } from "./router";
import { createPaginate } from "./paginate";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { runWithRenderTracking } from "./runtime/astro-shim";
import { hydrationScript } from "./runtime/hydration";
import { hmrClientScript } from "./runtime/hmr-client";
import { devCss } from "./css";
import { registerAstroPlugin, getScopedCssForPage, extractAstroClasses, getGlobalCssForPage } from "./astro-plugin";
import { bumpDevVersion, getDevVersion } from "./dev-cache";
import { parseMarkdown } from "./content/markdown";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { initAstroHost, dispatchMiddlewares, bundleVirtualEntry } from "./astro-host";
import { resolveI18nConfig } from "./i18n/config";
import { detectRouteLocale } from "./i18n/route-expansion";
import { parsePreferredLocales } from "./i18n/helpers";
import { setI18nRuntimeState } from "./i18n/virtual-module";
import { setImageMode } from "./image";
import {
  resolveFallbackRoute,
  resolveDefaultLocaleRedirect,
} from "./i18n/fallback";
import { registerCssModulesPlugin, getCssModulesOutput } from "./css-modules";
import { registerDevTsPlugin } from "./dev-ts-plugin";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import type { PletivoConfig } from "./config";
import type { ServerWebSocket } from "bun";
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
  setImageMode("dev", "/");

  function escapeHtmlSimple(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  type RenderOutcome =
    | { ok: true; html: string }
    | { ok: false; error: unknown };

  async function renderPage(
    route: Route,
    params: Record<string, string>,
    pathname: string = "/",
    request?: Request,
    localeOverride?: string,
  ): Promise<RenderOutcome | null> {
    const fullPath = path.join(pagesDir, route.file);

    try {
      // Markdown pages — render directly without module import
      if (route.file.endsWith(".md")) {
        const source = await Bun.file(fullPath).text();
        const { html: body, frontmatter } = parseMarkdown(source);
        const title = (frontmatter.title as string) || "";
        return { ok: true, html: `<!DOCTYPE html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>` };
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
      const styleLink = `<link rel="stylesheet" href="/__styles.css">`;
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
        ? (beforeHydration ? "\n" + beforeHydration : "") + "\n" + hydrationScript
        : "";
      const scripts = hmrClientScript + hydrationBlock;
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

      return { ok: true, html };
    } catch (e) {
      console.error(`Error rendering ${route.file}:`, e);
      return { ok: false, error: e };
    }
  }

  function formatDevErrorHtml(e: unknown): string {
    const msg = String(e instanceof Error ? e.stack || e.message : e);
    return `<html><body><pre data-pletivo-error style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem">${escapeHtmlSimple(msg)}</pre>${hmrClientScript}</body></html>`;
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

  // Per-pathname snapshot of the last HTML successfully served to a user.
  // Populated on successful user renders; read when a later render for the
  // same path throws and stale mode is on.
  const snapshots = new Map<string, string>();

  const errorPagePath = config.dev?.errorPage
    ? path.resolve(projectRoot, config.dev.errorPage)
    : undefined;

  // Render a standalone component file (used for custom 404 + error pages).
  // Mirrors the CSS/HMR head injection that renderPage does, minus the
  // route-level integration scripts that don't apply to meta pages.
  async function renderComponentFile(
    fullPath: string,
    props: Record<string, unknown> = {},
  ): Promise<string | null> {
    const importPath = fullPath + `?v=${getDevVersion()}`;
    const mod = await import(importPath);
    if (typeof mod.default !== "function") return null;
    resetIslandRegistry();
    const { value: result, renderedModules, tsxStyles } = await runWithRenderTracking(async () => {
      let r = mod.default(props);
      if (r instanceof Promise) r = await r;
      return r;
    });
    let html: string;
    if (typeof result === "string") html = result;
    else if (result && typeof result === "object" && "__html" in result) html = (result as { __html: string }).__html;
    else return null;

    const classes = extractAstroClasses(html);
    const scopedCss = getScopedCssForPage(classes);
    const globalCss = getGlobalCssForPage(renderedModules);
    const tsxCss = tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
    const combinedCss = [globalCss, scopedCss, tsxCss].filter(Boolean).join("\n");
    const styleLink = `<link rel="stylesheet" href="/__styles.css">`;
    const styleTag = combinedCss ? `<style>${combinedCss}</style>` : "";
    const headInjection = `${styleLink}\n${styleTag}\n${hmrClientScript}`;
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
    return html;
  }

  // Route rendering wrapper. Calls renderPage, then:
  // - success: update snapshot (for shielded requests), return Response
  // - miss (null): return null so the caller can cascade to the next route
  // - error: debug requests get raw stack trace; shielded requests get snapshot
  //   (if stale) → error page (if configured) → raw stack trace as last resort.
  async function resolveRoute(
    route: Route,
    params: Record<string, string>,
    pathname: string,
    req: Request,
    localeOverride?: string,
  ): Promise<Response | null> {
    const outcome = await renderPage(route, params, pathname, req, localeOverride);
    if (outcome === null) return null;
    const htmlHeaders = { "Content-Type": "text/html; charset=utf-8" };
    if (outcome.ok) {
      if (!seesRawErrors(req)) snapshots.set(pathname, outcome.html);
      return new Response(outcome.html, { headers: htmlHeaders });
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

  async function render404(): Promise<string | null> {
    // Explicit config override first; fall back to the pages/404.* convention.
    const candidates: string[] = [];
    if (notFoundPagePath) candidates.push(notFoundPagePath);
    for (const ext of [".tsx", ".jsx", ".astro"]) {
      candidates.push(path.join(pagesDir, `404${ext}`));
    }
    for (const fullPath of candidates) {
      if (!fs.existsSync(fullPath)) continue;
      try {
        const html = await renderComponentFile(fullPath);
        if (html) return html;
      } catch (e) {
        console.error(`Error rendering 404 page ${fullPath}:`, e);
      }
    }
    return null;
  }

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for HMR — must bypass middleware chain
      if (url.pathname === "/__hmr") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // HMR ping — lightweight health check so the client can detect
      // whether the dev server is alive without triggering a full reload.
      if (url.pathname === "/__hmr_ping") {
        return new Response("ok", { status: 200 });
      }

      // SSE fallback for HMR when WebSocket is unavailable (e.g. behind
      // proxies that don't support WS upgrades).
      if (url.pathname === "/__hmr_sse") {
        let heartbeat: ReturnType<typeof setInterval>;
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            console.log(`  HMR sse connected (${sseClients.size} clients)`);
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
            console.log(`  HMR sse disconnected (${sseClients.size} clients)`);
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
      if (url.pathname === "/__hmr_poll") {
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
          () => pletivoHandler(req, url),
        );
        if (response) return response;
      }

      return (await pletivoHandler(req, url)) ?? new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        console.log(`  HMR ws connected (${sockets.size} clients)`);
      },
      close(ws) {
        sockets.delete(ws);
        console.log(`  HMR ws disconnected (${sockets.size} clients)`);
      },
      message() {},
    },
  });

  async function pletivoHandler(req: Request, url: URL): Promise<Response | null> {
    {
      // Serve the morphdom ESM bundle for the HMR client's lazy import
      if (url.pathname === "/__pletivo/morphdom.js") {
        try {
          const morphdomPath = require.resolve("morphdom/dist/morphdom-esm.js");
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
      if (url.pathname.startsWith("/@image/")) {
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
      if (url.pathname === "/__styles.css") {
        let css = await devCss(projectRoot, config.srcDir);
        const cssModules = getCssModulesOutput();
        if (cssModules) css += "\n" + cssModules;
        return new Response(css, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      // Serve island bundles on-the-fly
      if (url.pathname.startsWith("/_islands/")) {
        const name = url.pathname.slice("/_islands/".length).replace(/\.js$/, "");
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
      const publicPath = path.join(publicDir, url.pathname);
      const publicFile = Bun.file(publicPath);
      if (await publicFile.exists()) {
        const ext = path.extname(url.pathname);
        return new Response(publicFile, {
          headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
        });
      }

      // Route matching — try all matching routes so that when a dynamic
      // route's getStaticPaths doesn't contain the params we cascade to
      // the next matching route instead of falling through to 404.
      const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
      for (const route of routes) {
        const params = matchRoute(route, pathname);
        if (params !== null) {
          const response = await resolveRoute(route, params, pathname, req);
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
          pathname,
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
          pathname,
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
            pathname,
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
        const cleanPathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
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
      if (astroHost && /^(\/@|\/virtual:)/.test(url.pathname)) {
        for (const p of astroHost.server.__plugins) {
          const resolveId = (p as { resolveId?: (id: string) => unknown }).resolveId;
          if (typeof resolveId !== "function") continue;
          let resolved: unknown;
          try {
            resolved = await resolveId(url.pathname);
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
