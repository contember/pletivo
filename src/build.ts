import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";

export async function build(projectRoot: string) {
  const pagesDir = path.join(projectRoot, "src/pages");
  const distDir = path.join(projectRoot, "dist");
  const publicDir = path.join(projectRoot, "public");

  // Clean dist
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // Copy public/ into dist/
  try {
    await copyDir(publicDir, distDir);
  } catch {
    // no public dir, that's fine
  }

  // Find all page files
  const glob = new Glob("**/*.{tsx,jsx,ts,js}");
  const pages: string[] = [];
  for await (const file of glob.scan(pagesDir)) {
    pages.push(file);
  }

  console.log(`Building ${pages.length} pages...`);

  for (const page of pages) {
    const fullPath = path.join(pagesDir, page);
    const mod = await import(fullPath);
    const component = mod.default;

    if (typeof component !== "function") {
      console.warn(`Skipping ${page}: no default export function`);
      continue;
    }

    const result = component();
    let html: string;
    if (typeof result === "string") {
      html = result;
    } else if (result && typeof result === "object" && "__html" in result) {
      html = result.__html;
    } else {
      console.warn(`Skipping ${page}: default export didn't return HTML`);
      continue;
    }

    // Add doctype if page has <html> tag
    if (html.trimStart().startsWith("<html") || html.trimStart().startsWith("<!")) {
      if (!html.trimStart().startsWith("<!DOCTYPE") && !html.trimStart().startsWith("<!doctype")) {
        html = "<!DOCTYPE html>\n" + html;
      }
    }

    // Determine output path
    const name = page.replace(/\.(tsx|jsx|ts|js)$/, "");
    let outPath: string;
    if (name === "index" || name.endsWith("/index")) {
      outPath = path.join(distDir, name + ".html");
    } else {
      outPath = path.join(distDir, name, "index.html");
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html);
    console.log(`  ${page} → ${path.relative(projectRoot, outPath)}`);
  }

  console.log("Build complete.");
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
