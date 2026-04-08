import path from "path";
import fs from "fs/promises";
import { scanRoutes, routeToOutputPath, type Route, type StaticPath } from "./router";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { hydrationScript } from "./runtime/hydration";
import { bundleCss } from "./css";
import type { PavoukConfig } from "./config";

export async function build(projectRoot: string, config: PavoukConfig) {
  const pagesDir = path.join(projectRoot, config.srcDir, "pages");
  const distDir = path.join(projectRoot, config.outDir);
  const publicDir = path.join(projectRoot, config.publicDir);
  const islandsDir = path.join(projectRoot, config.srcDir, "islands");
  const base = config.base.replace(/\/$/, "");

  // Init content collections
  await initCollections(projectRoot);

  // Clean dist
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // Copy public/ into dist/
  try {
    await copyDir(publicDir, distDir);
  } catch {
    // no public dir
  }

  // Bundle CSS from src/
  const cssPath = await bundleCss(projectRoot, config.srcDir, distDir);

  // Scan routes
  const routes = await scanRoutes(pagesDir);
  console.log(`Found ${routes.length} routes`);

  // Track all islands used across all pages
  const allIslands = new Map<string, string>();
  let pageCount = 0;
  let totalSize = 0;

  for (const route of routes) {
    // Skip 404 page in normal route processing (handled separately)
    if (route.file === "404.tsx" || route.file === "404.jsx") continue;

    const fullPath = path.join(pagesDir, route.file);
    const mod = await import(fullPath);
    const component = mod.default;

    if (typeof component !== "function") {
      console.warn(`  Skipping ${route.file}: no default export function`);
      continue;
    }

    if (route.isDynamic) {
      if (typeof mod.getStaticPaths !== "function") {
        console.warn(`  Skipping ${route.file}: dynamic route without getStaticPaths()`);
        continue;
      }

      const staticPaths: StaticPath[] = await mod.getStaticPaths();

      for (const { params, props: pathProps } of staticPaths) {
        resetIslandRegistry();
        const html = await renderComponent(component, pathProps || {});
        if (html === null) continue;

        const outFile = routeToOutputPath(route, params);
        const outPath = path.join(distDir, outFile);
        const size = await writeHtml(outPath, html, base, cssPath);
        totalSize += size;
        pageCount++;
        console.log(`  ${route.file} [${Object.values(params).join("/")}] → ${path.relative(projectRoot, outPath)} (${formatSize(size)})`);

        for (const [name, filePath] of getUsedIslands()) {
          allIslands.set(name, filePath);
        }
      }
    } else {
      resetIslandRegistry();
      const html = await renderComponent(component, {});
      if (html === null) {
        console.warn(`  Skipping ${route.file}: default export didn't return HTML`);
        continue;
      }

      const outFile = routeToOutputPath(route, {});
      const outPath = path.join(distDir, outFile);
      const size = await writeHtml(outPath, html, base, cssPath);
      totalSize += size;
      pageCount++;
      console.log(`  ${route.file} → ${path.relative(projectRoot, outPath)} (${formatSize(size)})`);

      for (const [name, filePath] of getUsedIslands()) {
        allIslands.set(name, filePath);
      }
    }
  }

  // Build custom 404 page
  await build404(pagesDir, distDir, base, cssPath);

  // Bundle islands
  if (allIslands.size > 0) {
    await bundleIslands(allIslands, islandsDir, distDir);
  }

  // Summary
  console.log(`\nBuilt ${pageCount} pages${allIslands.size > 0 ? `, ${allIslands.size} islands` : ""}${cssPath ? ", 1 CSS bundle" : ""} (${formatSize(totalSize)} total)`);
}

async function renderComponent(
  component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
): Promise<string | null> {
  let result = component(props);
  if (result instanceof Promise) result = await result;

  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "__html" in result) {
    return (result as { __html: string }).__html;
  }
  return null;
}

async function writeHtml(
  outPath: string,
  html: string,
  base: string,
  cssPath: string | null,
): Promise<number> {
  // Add doctype
  if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
    html = "<!DOCTYPE html>\n" + html;
  }

  // Inject CSS bundle link
  if (cssPath && html.includes("</head>")) {
    html = html.replace("</head>", `<link rel="stylesheet" href="${base}${cssPath}">\n</head>`);
  }

  // Inject hydration script if page contains islands
  if (html.includes("<pavouk-island")) {
    if (html.includes("</head>")) {
      html = html.replace("</head>", hydrationScript + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", hydrationScript + "\n</body>");
    } else {
      html += hydrationScript;
    }
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const bytes = Buffer.byteLength(html, "utf-8");
  await fs.writeFile(outPath, html);
  return bytes;
}

async function build404(pagesDir: string, distDir: string, base: string, cssPath: string | null) {
  for (const ext of [".tsx", ".jsx"]) {
    const fullPath = path.join(pagesDir, `404${ext}`);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      const mod = await import(fullPath);
      if (typeof mod.default === "function") {
        resetIslandRegistry();
        const html = await renderComponent(mod.default, {});
        if (html) {
          const outPath = path.join(distDir, "404.html");
          await writeHtml(outPath, html, base, cssPath);
          console.log(`  404.tsx → 404.html`);
        }
      }
      break;
    }
  }
}

async function bundleIslands(
  islands: Map<string, string>,
  islandsDir: string,
  distDir: string,
) {
  const islandOutDir = path.join(distDir, "_islands");
  await fs.mkdir(islandOutDir, { recursive: true });

  const tmpDir = path.join(distDir, "_islands_tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  const entrypoints: string[] = [];
  for (const [name] of islands) {
    const candidates = [
      path.join(islandsDir, name + ".tsx"),
      path.join(islandsDir, name + ".ts"),
      path.join(islandsDir, name + ".jsx"),
      path.join(islandsDir, name + ".js"),
    ];
    let sourcePath: string | null = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        sourcePath = candidate;
        break;
      } catch {
        // try next
      }
    }
    if (!sourcePath) continue;

    const wrapperPath = path.join(tmpDir, name + ".ts");
    await fs.writeFile(wrapperPath, `export { mount } from "${sourcePath}";\n`);
    entrypoints.push(wrapperPath);
  }

  if (entrypoints.length === 0) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    return;
  }

  console.log(`\nBundling ${entrypoints.length} islands...`);

  const result = await Bun.build({
    entrypoints,
    outdir: islandOutDir,
    format: "esm",
    minify: true,
    naming: "[name].js",
  });

  await fs.rm(tmpDir, { recursive: true, force: true });

  if (!result.success) {
    console.error("Island bundling failed:");
    for (const log of result.logs) {
      console.error(`  ${log}`);
    }
  } else {
    for (const output of result.outputs) {
      console.log(`  _islands/${path.basename(output.path)} (${formatSize(output.size)})`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyDir(src: string, dest: string) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
