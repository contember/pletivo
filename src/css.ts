import path from "path";
import fs from "fs/promises";
import { Glob } from "bun";

/**
 * Collect and bundle CSS files from src/ imports.
 * Scans for .css files in src/ (excluding public/), concatenates them,
 * and writes a hashed bundle to dist/assets/.
 */
export async function bundleCss(
  projectRoot: string,
  srcDir: string,
  distDir: string,
): Promise<string | null> {
  const srcPath = path.join(projectRoot, srcDir);
  const glob = new Glob("**/*.css");
  const cssFiles: string[] = [];

  for await (const file of glob.scan(srcPath)) {
    cssFiles.push(file);
  }

  if (cssFiles.length === 0) return null;

  // Read and concatenate all CSS
  const parts: string[] = [];
  for (const file of cssFiles.sort()) {
    const content = await Bun.file(path.join(srcPath, file)).text();
    parts.push(`/* ${file} */\n${content}`);
  }
  const combined = parts.join("\n\n");

  // Hash for cache busting
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(combined);
  const hash = hasher.digest("hex").slice(0, 8);

  const assetsDir = path.join(distDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const outFile = `styles.${hash}.css`;
  await fs.writeFile(path.join(assetsDir, outFile), combined);

  return `/assets/${outFile}`;
}

/**
 * In dev mode, serve concatenated CSS from src/ on-the-fly.
 */
export async function devCss(projectRoot: string, srcDir: string): Promise<string> {
  const srcPath = path.join(projectRoot, srcDir);
  const glob = new Glob("**/*.css");
  const parts: string[] = [];

  for await (const file of glob.scan(srcPath)) {
    const content = await Bun.file(path.join(srcPath, file)).text();
    parts.push(`/* ${file} */\n${content}`);
  }

  return parts.join("\n\n");
}
