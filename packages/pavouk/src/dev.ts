import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes, findRoute, type Route, type StaticPath } from "./router";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { hydrationScript } from "./runtime/hydration";
import { hmrClientScript } from "./runtime/hmr-client";
import { devCss } from "./css";
import { registerAstroPlugin, getScopedCss } from "./astro-plugin";
import { initAstroHost, dispatchMiddlewares, bundleVirtualEntry } from "./astro-host";
import type { PavoukConfig } from "./config";
import type { ServerWebSocket } from "bun";

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

export async function dev(projectRoot: string, config: PavoukConfig) {
  const pagesDir = path.join(projectRoot, config.srcDir, "pages");
  const publicDir = path.join(projectRoot, config.publicDir);
  const islandsDir = path.join(projectRoot, config.srcDir, "islands");

  const sockets = new Set<ServerWebSocket<unknown>>();
  let moduleVersion = 0;

  await registerAstroPlugin();
  const astroHost = await initAstroHost(projectRoot, "dev");
  await initCollections(projectRoot);
  let routes = await scanRoutes(pagesDir);

  function escapeHtmlSimple(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function renderPage(
    route: Route,
    params: Record<string, string>,
    pathname: string = "/",
  ): Promise<string | null> {
    const fullPath = path.join(pagesDir, route.file);

    try {
      const importPath = fullPath + `?v=${moduleVersion}`;
      const mod = await import(importPath);
      const component = mod.default;

      if (typeof component !== "function") return null;

      let props: Record<string, unknown> = {};

      if (route.isDynamic) {
        if (typeof mod.getStaticPaths !== "function") {
          // Dynamic route without getStaticPaths — cannot resolve, treat as miss
          return null;
        }
        const staticPaths: StaticPath[] = await mod.getStaticPaths();
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
      const origin = siteUrl ? siteUrl.origin : `http://localhost:${config.port}`;
      const pageContext = {
        url: new URL(pathname || "/", origin),
        site: siteUrl,
        params,
      };

      resetIslandRegistry();
      let result = component({ ...props, __pageContext: pageContext });
      if (result instanceof Promise) result = await result;

      let html: string;
      if (typeof result === "string") {
        html = result;
      } else if (result && typeof result === "object" && "__html" in result) {
        html = (result as { __html: string }).__html;
      } else {
        return null;
      }

      // Inject dev stylesheet link + HMR / hydration scripts + any
      // integration-injected scripts (`injectScript('page', code)` from
      // Astro integrations). The stylesheet link is emitted unconditionally —
      // buildCss's Tailwind pipeline runs per-request, so even projects
      // without a manual <link> get styles.
      //
      // Scoped CSS from <style> blocks in .astro components is inlined as
      // a <style> tag rather than served via /__styles.css. This avoids a
      // race condition: the browser fetches CSS and HTML in parallel, but
      // scoped styles are only collected when .astro modules are imported
      // during page render. Inlining guarantees the styles are present on
      // first load.
      const styleLink = `<link rel="stylesheet" href="/__styles.css">`;
      const scopedCss = getScopedCss();
      const scopedStyleTag = scopedCss ? `<style>${scopedCss}</style>` : "";
      const scripts = hmrClientScript + (getUsedIslands().size > 0 ? "\n" + hydrationScript : "");
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
      return `<html><body><pre style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem">${escapeHtmlSimple(String(e instanceof Error ? e.stack || e.message : e))}</pre>${hmrClientScript}</body></html>`;
    }
  }

  async function render404(): Promise<string | null> {
    for (const ext of [".tsx", ".jsx", ".astro"]) {
      const fullPath = path.join(pagesDir, `404${ext}`);
      if (fs.existsSync(fullPath)) {
        try {
          const mod = await import(fullPath + `?v=${moduleVersion}`);
          if (typeof mod.default === "function") {
            resetIslandRegistry();
            let result = mod.default({});
            if (result instanceof Promise) result = await result;
            let html: string;
            if (typeof result === "string") html = result;
            else if (result && typeof result === "object" && "__html" in result) html = (result as { __html: string }).__html;
            else return null;

            const scopedCss404 = getScopedCss();
            const styleTag404 = scopedCss404 ? `<style>${scopedCss404}</style>` : "";
            const headInjection404 = `<link rel="stylesheet" href="/__styles.css">\n${styleTag404}\n${hmrClientScript}`;
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

  const server = Bun.serve({
    port: config.port,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for HMR — must bypass middleware chain
      if (url.pathname === "/__hmr") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Route the request through the Astro integration middleware chain.
      // If a middleware ends the response itself (e.g. CMS API handler),
      // that Response is returned. Otherwise the chain exhausts and
      // `pavoukHandler` runs — integration middlewares that wrapped
      // res.write/res.end (e.g. CMS HTML marker) then see the page HTML
      // on its way out.
      if (astroHost) {
        const response = await dispatchMiddlewares(
          req,
          astroHost.server.__middlewares,
          () => pavoukHandler(req, url),
        );
        if (response) return response;
      }

      return (await pavoukHandler(req, url)) ?? new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });

  async function pavoukHandler(req: Request, url: URL): Promise<Response | null> {
    {
      // Serve the morphdom ESM bundle for the HMR client's lazy import
      if (url.pathname === "/__pavouk/morphdom.js") {
        try {
          const morphdomPath = require.resolve("morphdom/dist/morphdom-esm.js");
          return new Response(Bun.file(morphdomPath), {
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
          });
        } catch {
          return new Response("morphdom not installed", { status: 500 });
        }
      }

      // Serve bundled CSS from src/ on-the-fly, including scoped styles
      // from <style> blocks in .astro components collected during import.
      if (url.pathname === "/__styles.css") {
        let css = await devCss(projectRoot, config.srcDir);
        const scoped = getScopedCss();
        if (scoped) {
          css += "\n/* astro scoped styles */\n" + scoped;
        }
        return new Response(css, {
          headers: { "Content-Type": "text/css; charset=utf-8" },
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
            const tmpDir = path.join(projectRoot, "node_modules/.pavouk");
            const fsP = await import("fs/promises");
            await fsP.mkdir(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `${name}.ts`);
            await fsP.writeFile(tmpFile, wrapper);
            try {
              const preactJsx = require.resolve("preact/jsx-runtime");
              const preactHooks = require.resolve("preact/hooks");
              const islandPlugin = {
                name: "pavouk-island",
                setup(build: any) {
                  build.onResolve({ filter: /^pavouk\/jsx-runtime$/ }, () => ({ path: preactJsx }));
                  build.onResolve({ filter: /^pavouk\/jsx-dev-runtime$/ }, () => ({ path: preactJsx }));
                  build.onResolve({ filter: /^pavouk\/hooks$/ }, () => ({ path: preactHooks }));
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

      // Route matching
      const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
      const match = findRoute(routes, pathname);
      if (match) {
        const html = await renderPage(match.route, match.params, pathname);
        if (html !== null) {
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
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
    console.log(`  Changed: ${config.srcDir}/${filename}`);
    moduleVersion++;

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
      const viteEvent = event === "rename" ? "change" : "change";
      astroHost.server.watcher.emit(viteEvent, absPath);
    }

    // Classify the change so the HMR client can do the cheapest update:
    //  - .css → hot-swap the stylesheet (no reload, no morph)
    //  - anything else → fetch new HTML + morphdom patch
    //  - hard reload is the fallback if the client decides morph isn't safe
    const ext = path.extname(filename).toLowerCase();
    const isCss = ext === ".css";
    const payload = JSON.stringify({ type: isCss ? "css" : "html" });
    for (const ws of sockets) {
      ws.send(payload);
    }
  });

  try {
    watch(publicDir, { recursive: true }, () => {
      const payload = JSON.stringify({ type: "reload" });
      for (const ws of sockets) {
        ws.send(payload);
      }
    });
  } catch {
    // no public dir
  }

  console.log(`\n  pavouk dev server running at http://localhost:${config.port}\n`);

  if (astroHost) {
    await astroHost.runServerStart({
      address: "127.0.0.1",
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
