import path from "path";
import fs from "fs/promises";
import { scanRoutes, routeToOutputPath, type Route, type StaticPath } from "./router";
import { initCollections } from "./content/collection";
import { resetIslandRegistry, getUsedIslands } from "./runtime/island";
import { hydrationScript } from "./runtime/hydration";

export async function build(projectRoot: string) {
  const pagesDir = path.join(projectRoot, "src/pages");
  const distDir = path.join(projectRoot, "dist");
  const publicDir = path.join(projectRoot, "public");
  const islandsDir = path.join(projectRoot, "src/islands");

  // Init content collections
  await initCollections(projectRoot);

  // Clean dist
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // Copy public/ into dist/
  try {
    await copyDir(publicDir, distDir);
  } catch {
    // no public dir, that's fine
  }

  // Scan routes
  const routes = await scanRoutes(pagesDir);
  console.log(`Found ${routes.length} routes`);

  // Track all islands used across all pages
  const allIslands = new Map<string, string>();
  let pageCount = 0;

  for (const route of routes) {
    const fullPath = path.join(pagesDir, route.file);
    const mod = await import(fullPath);
    const component = mod.default;

    if (typeof component !== "function") {
      console.warn(`Skipping ${route.file}: no default export function`);
      continue;
    }

    if (route.isDynamic) {
      // Dynamic route - needs getStaticPaths
      if (typeof mod.getStaticPaths !== "function") {
        console.warn(`Skipping ${route.file}: dynamic route without getStaticPaths()`);
        continue;
      }

      const staticPaths: StaticPath[] = await mod.getStaticPaths();

      for (const { params, props: pathProps } of staticPaths) {
        resetIslandRegistry();
        const html = await renderComponent(component, pathProps || {});
        if (html === null) continue;

        const outFile = routeToOutputPath(route, params);
        const outPath = path.join(distDir, outFile);
        await writeHtml(outPath, html, projectRoot);
        pageCount++;
        console.log(`  ${route.file} [${Object.values(params).join("/")}] → ${path.relative(projectRoot, outPath)}`);

        // Collect islands
        for (const [name, filePath] of getUsedIslands()) {
          allIslands.set(name, filePath);
        }
      }
    } else {
      // Static route
      resetIslandRegistry();
      const html = await renderComponent(component, {});
      if (html === null) {
        console.warn(`Skipping ${route.file}: default export didn't return HTML`);
        continue;
      }

      const outFile = routeToOutputPath(route, {});
      const outPath = path.join(distDir, outFile);
      await writeHtml(outPath, html, projectRoot);
      pageCount++;
      console.log(`  ${route.file} → ${path.relative(projectRoot, outPath)}`);

      // Collect islands
      for (const [name, filePath] of getUsedIslands()) {
        allIslands.set(name, filePath);
      }
    }
  }

  // Bundle islands
  if (allIslands.size > 0) {
    await bundleIslands(allIslands, islandsDir, distDir);
  }

  console.log(`\nBuilt ${pageCount} pages${allIslands.size > 0 ? `, ${allIslands.size} islands` : ""}.`);
}

async function renderComponent(
  component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
): Promise<string | null> {
  let result = component(props);

  // Handle async components
  if (result instanceof Promise) {
    result = await result;
  }

  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "__html" in result) {
    return (result as { __html: string }).__html;
  }
  return null;
}

async function writeHtml(outPath: string, html: string, projectRoot: string) {
  // Add doctype if needed
  if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
    html = "<!DOCTYPE html>\n" + html;
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
  await fs.writeFile(outPath, html);
}

async function bundleIslands(
  islands: Map<string, string>,
  islandsDir: string,
  distDir: string,
) {
  const islandOutDir = path.join(distDir, "_islands");
  await fs.mkdir(islandOutDir, { recursive: true });

  // Create temp wrapper files that only export mount() to tree-shake server code
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

    // Create wrapper that only re-exports mount
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

  // Cleanup temp dir
  await fs.rm(tmpDir, { recursive: true, force: true });

  if (!result.success) {
    console.error("Island bundling failed:");
    for (const log of result.logs) {
      console.error(`  ${log}`);
    }
  }
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
