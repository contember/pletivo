import path from "path";
import fs from "fs/promises";
import { Glob } from "bun";

/**
 * Collect and bundle CSS from src/.
 *
 * Two modes:
 *  1. Tailwind v4 — if a CSS file contains `@import "tailwindcss"` AND
 *     `@tailwindcss/node` is available in the project, route everything
 *     through the Tailwind compile pipeline (imports, @source scanning,
 *     candidate extraction via @tailwindcss/oxide, build()).
 *  2. Fallback — concatenate all `.css` files from src/, no processing.
 */
export async function bundleCss(
  projectRoot: string,
  srcDir: string,
  distDir: string,
): Promise<string | null> {
  const combined = await buildCss(projectRoot, srcDir);
  if (combined === null) return null;

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
 * Dev-mode CSS: same pipeline as build, served on every /__styles.css
 * request. For large projects Tailwind compile is fast enough to not cache;
 * add caching tied to the file watcher if it becomes a bottleneck.
 */
export async function devCss(projectRoot: string, srcDir: string): Promise<string> {
  const out = await buildCss(projectRoot, srcDir);
  return out ?? "";
}

async function buildCss(projectRoot: string, srcDir: string): Promise<string | null> {
  const srcPath = path.join(projectRoot, srcDir);
  const cssFiles: string[] = [];
  const glob = new Glob("**/*.css");
  for await (const file of glob.scan(srcPath)) {
    cssFiles.push(file);
  }
  if (cssFiles.length === 0) return null;

  // Look for a Tailwind entry — a CSS file that imports tailwindcss
  const entry = await findTailwindEntry(srcPath, cssFiles);
  if (entry) {
    try {
      return await compileTailwind(projectRoot, entry);
    } catch (e) {
      console.error(`  Tailwind compile failed: ${(e as Error).message}`);
      console.error(`  Falling back to raw CSS concat.`);
    }
  }

  // Fallback: concat everything
  const parts: string[] = [];
  for (const file of cssFiles.sort()) {
    const content = await Bun.file(path.join(srcPath, file)).text();
    parts.push(`/* ${file} */\n${content}`);
  }
  return parts.join("\n\n");
}

async function findTailwindEntry(
  srcPath: string,
  cssFiles: string[],
): Promise<{ path: string; source: string } | null> {
  // Prefer files named global.css / app.css / main.css; otherwise scan all
  const preferred = ["global.css", "app.css", "main.css", "styles.css"];
  const sorted = [...cssFiles].sort((a, b) => {
    const ai = preferred.indexOf(path.basename(a));
    const bi = preferred.indexOf(path.basename(b));
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const file of sorted) {
    const full = path.join(srcPath, file);
    const content = await Bun.file(full).text();
    if (/@import\s+["']tailwindcss["']/.test(content)) {
      return { path: full, source: content };
    }
  }
  return null;
}

async function compileTailwind(
  projectRoot: string,
  entry: { path: string; source: string },
): Promise<string> {
  // Resolve Tailwind packages from the project's node_modules, not pletivo's.
  // The user's site owns the Tailwind version; pletivo stays version-agnostic.
  const tailwindNodePath = require.resolve("@tailwindcss/node", {
    paths: [projectRoot],
  });
  const oxidePath = require.resolve("@tailwindcss/oxide", {
    paths: [projectRoot],
  });

  const { compile } = (await import(tailwindNodePath)) as typeof import("@tailwindcss/node");
  const { Scanner } = (await import(oxidePath)) as typeof import("@tailwindcss/oxide");

  const base = path.dirname(entry.path);
  const result = await compile(entry.source, {
    base,
    from: entry.path,
    onDependency: () => {},
  });

  // Combine `root` (auto-detected content root) with explicit @source
  // globs, matching the pattern used by @tailwindcss/postcss and @tailwindcss/vite:
  //
  //   - root === "none"  → explicit @source directives only
  //   - root === null    → default: scan projectRoot for all files
  //   - root is object   → scan the given root + explicit sources
  const rootSources =
    result.root === "none"
      ? []
      : result.root === null
        ? [{ base: projectRoot, pattern: "**/*", negated: false }]
        : [{ base: result.root.base, pattern: result.root.pattern, negated: false }];

  const scannerSources = [
    ...rootSources,
    ...result.sources.map((s) => ({ base: s.base, pattern: s.pattern, negated: s.negated })),
  ];

  const scanner = new Scanner({ sources: scannerSources });
  const candidates = scanner.scan();

  return result.build(candidates);
}
