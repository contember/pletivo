import path from "path";
import fs from "fs";
import { watch } from "fs";
import { scanRoutes, findRoute, routeToOutputPath, type Route, type StaticPath } from "./router";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { hydrationScript } from "./runtime/hydration";
import { hmrClientScript } from "./runtime/hmr-client";
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

export async function dev(projectRoot: string, port = 3000) {
  const pagesDir = path.join(projectRoot, "src/pages");
  const publicDir = path.join(projectRoot, "public");
  const islandsDir = path.join(projectRoot, "src/islands");

  const sockets = new Set<ServerWebSocket<unknown>>();
  let moduleVersion = 0;

  // Init collections
  await initCollections(projectRoot);

  // Scan routes initially
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

      // For dynamic routes, find matching props from getStaticPaths
      if (route.isDynamic && typeof mod.getStaticPaths === "function") {
        const staticPaths: StaticPath[] = await mod.getStaticPaths();
        const match = staticPaths.find((sp) => {
          return Object.entries(params).every(([k, v]) => sp.params[k] === v);
        });
        if (match?.props) {
          props = match.props;
        }
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

      // Add doctype
      if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
        html = "<!DOCTYPE html>\n" + html;
      }

      return html;
    } catch (e) {
      console.error(`Error rendering ${route.file}:`, e);
      return `<html><body><pre style="color:red;white-space:pre-wrap;font-family:monospace;padding:2rem">${escapeHtmlSimple(String(e instanceof Error ? e.stack || e.message : e))}</pre>${hmrClientScript}</body></html>`;
    }
  }

  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for HMR
      if (url.pathname === "/__hmr") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
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
            // Build a wrapper that only exports mount() to exclude server code
            const wrapper = `export { mount } from "${candidate}";`;
            const tmpDir = path.join(projectRoot, "node_modules/.pavouk");
            const fsP = await import("fs/promises");
            await fsP.mkdir(tmpDir, { recursive: true });
            const tmpFile = path.join(tmpDir, `${name}.ts`);
            await fsP.writeFile(tmpFile, wrapper);
            try {
              const result = await Bun.build({
                entrypoints: [tmpFile],
                format: "esm",
                minify: false,
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
      const urlParts = pathname.split("/").filter(Boolean);

      // Try to find matching route
      const match = findRoute(routes, pathname);
      if (match) {
        const html = await renderPage(match.route, match.params);
        if (html !== null) {
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });

  // Watch for file changes
  const srcDir = path.join(projectRoot, "src");
  const watcher = watch(srcDir, { recursive: true }, async (_event, filename) => {
    if (!filename) return;
    console.log(`  Changed: src/${filename}`);
    moduleVersion++;

    // Re-init collections if content changed
    if (filename.startsWith("content/") || filename === "content.config.ts") {
      await initCollections(projectRoot);
    }

    // Re-scan routes if pages changed
    if (filename.startsWith("pages/")) {
      routes = await scanRoutes(pagesDir);
    }

    for (const ws of sockets) {
      ws.send("reload");
    }
  });

  // Also watch public/
  try {
    watch(publicDir, { recursive: true }, () => {
      for (const ws of sockets) {
        ws.send("reload");
      }
    });
  } catch {
    // no public dir
  }

  console.log(`\n  pavouk dev server running at http://localhost:${port}\n`);

  process.on("SIGINT", () => {
    watcher.close();
    server.stop();
    process.exit(0);
  });
}
