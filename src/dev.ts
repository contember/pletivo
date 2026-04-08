import path from "path";
import fs from "fs";
import { watch } from "fs";
import { Glob } from "bun";
import { hmrClientScript } from "./runtime/hmr-client";
import type { ServerWebSocket } from "bun";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
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

  const sockets = new Set<ServerWebSocket<unknown>>();
  let moduleVersion = 0;

  async function renderPage(pagePath: string): Promise<string | null> {
    const fullPath = path.join(pagesDir, pagePath);

    try {
      // Invalidate module cache by appending version query
      const importPath = fullPath + `?v=${moduleVersion}`;
      const mod = await import(importPath);
      const component = mod.default;

      if (typeof component !== "function") return null;

      const result = component();
      let html: string;
      if (typeof result === "string") {
        html = result;
      } else if (result && typeof result === "object" && "__html" in result) {
        html = result.__html;
      } else {
        return null;
      }

      // Inject HMR client before </head> or </body> or at the end
      if (html.includes("</head>")) {
        html = html.replace("</head>", hmrClientScript + "\n</head>");
      } else if (html.includes("</body>")) {
        html = html.replace("</body>", hmrClientScript + "\n</body>");
      } else {
        html = html + hmrClientScript;
      }

      // Add doctype
      if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
        html = "<!DOCTYPE html>\n" + html;
      }

      return html;
    } catch (e) {
      console.error(`Error rendering ${pagePath}:`, e);
      return `<html><body><pre style="color:red">${escapeHtmlSimple(String(e))}</pre>${hmrClientScript}</body></html>`;
    }
  }

  function escapeHtmlSimple(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function urlToPageFile(pathname: string): string | null {
    // Try exact match, then index
    const candidates = [
      pathname.slice(1) + ".tsx",
      pathname.slice(1) + ".jsx",
      path.join(pathname.slice(1), "index.tsx"),
      path.join(pathname.slice(1), "index.jsx"),
    ];

    if (pathname === "/") {
      candidates.unshift("index.tsx", "index.jsx");
    }

    for (const candidate of candidates) {
      const full = path.join(pagesDir, candidate);
      if (fs.existsSync(full)) {
        return candidate;
      }
    }
    return null;
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

      // Try static files from public/
      const publicPath = path.join(publicDir, url.pathname);
      const publicFile = Bun.file(publicPath);
      if (await publicFile.exists()) {
        const ext = path.extname(url.pathname);
        return new Response(publicFile, {
          headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
        });
      }

      // Try page routing
      const pageFile = urlToPageFile(url.pathname);
      if (pageFile) {
        const html = await renderPage(pageFile);
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
  const watcher = watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    console.log(`  Changed: src/${filename}`);
    moduleVersion++;
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
