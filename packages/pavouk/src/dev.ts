import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes, findRoute, type Route, type StaticPath } from "./router";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { hydrationScript } from "./runtime/hydration";
import { hmrClientScript } from "./runtime/hmr-client";
import { devCss } from "./css";
import { registerAstroPlugin } from "./astro-plugin";
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
  await initCollections(projectRoot);
  let routes = await scanRoutes(pagesDir);

  function escapeHtmlSimple(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function renderPage(route: Route, params: Record<string, string>): Promise<string | null> {
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

      resetIslandRegistry();
      let result = component(props);
      if (result instanceof Promise) result = await result;

      let html: string;
      if (typeof result === "string") {
        html = result;
      } else if (result && typeof result === "object" && "__html" in result) {
        html = (result as { __html: string }).__html;
      } else {
        return null;
      }

      // Inject scripts
      const scripts = hmrClientScript + (getUsedIslands().size > 0 ? "\n" + hydrationScript : "");
      if (html.includes("</head>")) {
        html = html.replace("</head>", scripts + "\n</head>");
      } else if (html.includes("</body>")) {
        html = html.replace("</body>", scripts + "\n</body>");
      } else {
        html += scripts;
      }

      if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
        html = "<!DOCTYPE html>\n" + html;
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

            html = html + hmrClientScript;
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

      // WebSocket upgrade for HMR
      if (url.pathname === "/__hmr") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Serve bundled CSS from src/ on-the-fly
      if (url.pathname === "/__styles.css") {
        const css = await devCss(projectRoot, config.srcDir);
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
        const html = await renderPage(match.route, match.params);
        if (html !== null) {
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
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
    },

    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });

  // Watch for file changes
  const srcDir = path.join(projectRoot, config.srcDir);
  const watcher = watch(srcDir, { recursive: true }, async (_event, filename) => {
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

    for (const ws of sockets) {
      ws.send("reload");
    }
  });

  try {
    watch(publicDir, { recursive: true }, () => {
      for (const ws of sockets) {
        ws.send("reload");
      }
    });
  } catch {
    // no public dir
  }

  console.log(`\n  pavouk dev server running at http://localhost:${config.port}\n`);

  process.on("SIGINT", () => {
    watcher.close();
    server.stop();
    process.exit(0);
  });
}
