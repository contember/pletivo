import path from "path";
import { existsSync } from "fs";
import fs from "fs/promises";
import type { BunPlugin } from "bun";

type BuildCssOutput = {
  path: string;
  type?: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

interface CssImportEntry {
  sourceFile: string;
  specifiers: string[];
}

interface CssImportGroups {
  source: string[];
  external: string[];
}

interface CollectCssOptions {
  bundleExternalCss?: boolean;
}

const bundledCssMap = new Map<string, string>();
const moduleCssMap = new Map<string, string>();
const moduleSourceCssMap = new Map<string, string[]>();
const cssImportEntries = new Map<string, CssImportEntry>();
const staticImportCache = new Map<string, Promise<string[]>>();

const CSS_IMPORT_PREFIX = "pletivo:css-import:";
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const jsTranspiler = new Bun.Transpiler({ loader: "js" });
const jsxTranspiler = new Bun.Transpiler({ loader: "jsx" });

let projectRoot: string | null = null;
let sourceCssRoot: string | null = null;

export function configureJsImportedCss(rootDir: string, srcDir: string): void {
  projectRoot = path.resolve(rootDir);
  sourceCssRoot = path.resolve(rootDir, srcDir);
}

export async function getJsImportedCssOutput(options: { includeSourceCss?: boolean } = {}): Promise<string> {
  // Sort by map key so the concatenation order is stable across builds.
  // Both maps are populated during parallel page imports / hoisted bundling,
  // so insertion order is non-deterministic and would otherwise churn the
  // stylesheet hash between otherwise-identical builds.
  const parts = [...sortedByKey(moduleCssMap), ...sortedByKey(bundledCssMap)].filter(Boolean);
  if (options.includeSourceCss) {
    const sourceCss = await readSourceCssOutput();
    if (sourceCss) parts.push(sourceCss);
  }
  return parts.join("\n\n");
}

function sortedByKey(map: Map<string, string>): string[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}

export function clearJsImportedCss(): void {
  moduleCssMap.clear();
  moduleSourceCssMap.clear();
  bundledCssMap.clear();
  cssImportEntries.clear();
  staticImportCache.clear();
}

export function clearJsImportedCssImportCache(): void {
  staticImportCache.clear();
}

export function clearCollectedCss(prefix: string): void {
  for (const key of moduleCssMap.keys()) {
    if (key.startsWith(prefix)) moduleCssMap.delete(key);
  }
  for (const key of moduleSourceCssMap.keys()) {
    if (key.startsWith(prefix)) moduleSourceCssMap.delete(key);
  }
  clearBundledCss(prefix);
}

export function clearBundledCss(prefix: string): void {
  for (const key of bundledCssMap.keys()) {
    if (key.startsWith(prefix)) bundledCssMap.delete(key);
  }
}

export async function recordBuildCssOutputs(
  outputs: BuildCssOutput[],
  key: string,
): Promise<void> {
  const css: string[] = [];
  for (const output of outputs) {
    if (!isCssOutput(output)) continue;
    css.push(await output.text());
  }

  if (css.length > 0) {
    bundledCssMap.set(key, css.join("\n\n"));
  } else {
    bundledCssMap.delete(key);
  }
}

export function jsOutputFromBuild(outputs: BuildCssOutput[]): BuildCssOutput | undefined {
  return outputs.find(isJsOutput);
}

// Page modules that are NOT `.astro` (`.tsx`/`.ts`/`.mdx`/…) don't pass
// through the astro plugin's onLoad, so their CSS side-effect imports aren't
// collected there. Read the source and collect from it directly. `.astro`
// (handled by the plugin) and `.md` (no JS imports) are intentionally skipped.
const PAGE_MODULE_CSS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mdx",
]);

export async function collectPageModuleCss(file: string, key: string): Promise<void> {
  if (!PAGE_MODULE_CSS_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
  const code = await readTextFile(file);
  if (code === null) return;
  await collectCssSideEffectImports(file, code, key);
}

export async function collectCssSideEffectImports(
  sourceFile: string,
  code: string,
  key: string,
  options: CollectCssOptions = {},
): Promise<void> {
  const imports = await collectCssImports(sourceFile, code);
  if (imports.source.length > 0) {
    moduleSourceCssMap.set(key, imports.source);
  } else {
    moduleSourceCssMap.delete(key);
  }

  if (imports.external.length === 0 || options.bundleExternalCss === false) {
    moduleCssMap.delete(key);
    return;
  }

  const token = Bun.hash(`${sourceFile}\0${key}`).toString(16).padStart(16, "0");
  cssImportEntries.set(token, { sourceFile, specifiers: imports.external });

  try {
    const result = await Bun.build({
      entrypoints: [CSS_IMPORT_PREFIX + token],
      format: "esm",
      target: "browser",
      minify: false,
      plugins: [cssSideEffectBunPlugin(), cssImportBunPlugin()],
    });

    if (!result.success) {
      const logs = result.logs.map((log) => String(log)).join("\n");
      console.error(`[pletivo] CSS side-effect import collection failed for ${sourceFile}:\n${logs}`);
      moduleCssMap.delete(key);
      return;
    }

    const css: string[] = [];
    for (const output of result.outputs) {
      if (!isCssOutput(output)) continue;
      css.push(await output.text());
    }
    if (css.length > 0) {
      moduleCssMap.set(key, css.join("\n\n"));
    } else {
      moduleCssMap.delete(key);
    }
  } finally {
    cssImportEntries.delete(token);
  }
}

export function cssSideEffectBunPlugin(): BunPlugin {
  return {
    name: "pletivo-css-side-effects",
    setup(build) {
      build.onLoad({ filter: /\.css(\?.*)?$/ }, async (args) => {
        const cleanPath = stripQuery(args.path);
        if (/\.module\.css$/i.test(cleanPath)) return undefined;
        if (!isSourceCss(cleanPath)) return undefined;
        return { contents: "", loader: "css" };
      });
    },
  };
}

function cssImportBunPlugin(): BunPlugin {
  const resolveFilter = new RegExp(`^${CSS_IMPORT_PREFIX}[a-f0-9]+$`);
  const loadFilter = /\/[a-f0-9]{16}\.js$/;

  return {
    name: "pletivo-css-imports",
    setup(build) {
      build.onResolve({ filter: resolveFilter }, (args) => {
        const token = args.path.slice(CSS_IMPORT_PREFIX.length);
        const entry = cssImportEntries.get(token);
        if (!entry) return undefined;
        return {
          path: path.join(path.dirname(entry.sourceFile), `${token}.js`),
        };
      });

      build.onLoad({ filter: loadFilter }, (args) => {
        const match = args.path.match(/\/([a-f0-9]{16})\.js$/);
        if (!match) return undefined;
        const entry = cssImportEntries.get(match[1]);
        if (!entry) return undefined;
        return {
          contents: entry.specifiers
            .map((specifier) => `import ${JSON.stringify(specifier)};`)
            .join("\n"),
          loader: "js",
        };
      });
    },
  };
}

async function readSourceCssOutput(): Promise<string> {
  const files = new Set<string>();
  for (const paths of moduleSourceCssMap.values()) {
    for (const file of paths) files.add(file);
  }
  const parts: string[] = [];
  for (const file of [...files].sort()) {
    const content = await readTextFile(file);
    if (content === null) continue;
    const label = projectRoot ? path.relative(projectRoot, file) : file;
    parts.push(`/* ${label} */\n${content}`);
  }
  return parts.join("\n\n");
}

function extractCssSideEffectImports(sourceFile: string, code: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|[;\n\r])\s*import\s+["']([^"']+)["']\s*;?/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const specifier = match[1];
    if (isCssSpecifier(sourceFile, specifier)) specifiers.push(specifier);
  }
  return specifiers;
}

async function collectCssImports(sourceFile: string, code: string): Promise<CssImportGroups> {
  const out = { source: new Set<string>(), external: new Set<string>() };
  await collectCssSpecifiersFromCode(sourceFile, code, out, new Set<string>());
  return {
    source: [...out.source].sort(),
    external: [...out.external].sort(),
  };
}

async function collectCssSpecifiersFromCode(
  sourceFile: string,
  code: string,
  out: { source: Set<string>; external: Set<string> },
  visited: Set<string>,
): Promise<void> {
  await collectCssSpecifiersFromImports(
    sourceFile,
    staticImportsFromCode(sourceFile, code),
    out,
    visited,
  );
}

async function collectCssSpecifiersFromFile(
  sourceFile: string,
  out: { source: Set<string>; external: Set<string> },
  visited: Set<string>,
): Promise<void> {
  await collectCssSpecifiersFromImports(
    sourceFile,
    await staticImportsForFile(sourceFile),
    out,
    visited,
  );
}

async function collectCssSpecifiersFromImports(
  sourceFile: string,
  imports: string[],
  out: { source: Set<string>; external: Set<string> },
  visited: Set<string>,
): Promise<void> {
  for (const specifier of imports) {
    const clean = stripQuery(specifier);
    if (!clean || isVirtualOrBuiltin(clean)) continue;

    const cssPath = resolveCssSpecifier(sourceFile, specifier);
    if (cssPath) {
      if (isSourceCss(cssPath)) {
        out.source.add(cssPath);
      } else {
        out.external.add(cssPath);
      }
      continue;
    }

    const modulePath = resolveLocalModule(specifier, sourceFile);
    if (!modulePath || visited.has(modulePath)) continue;
    visited.add(modulePath);
    await collectCssSpecifiersFromFile(modulePath, out, visited);
  }
}

async function staticImportsForFile(file: string): Promise<string[]> {
  let promise = staticImportCache.get(file);
  if (!promise) {
    promise = readStaticImportsForFile(file);
    staticImportCache.set(file, promise);
  }
  return await promise;
}

async function readStaticImportsForFile(file: string): Promise<string[]> {
  const code = await readTextFile(file);
  if (code === null) return [];
  return staticImportsFromCode(file, code);
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function staticImportsFromCode(sourceFile: string, code: string): string[] {
  try {
    return pickTranspiler(path.extname(sourceFile).toLowerCase())
      .scanImports(code)
      .filter((entry) => entry.kind === "import-statement")
      .map((entry) => entry.path);
  } catch {
    return extractCssSideEffectImports(sourceFile, code);
  }
}

function pickTranspiler(ext: string): Bun.Transpiler {
  if (ext === ".tsx" || ext === ".astro" || ext === ".mdx") return tsxTranspiler;
  if (ext === ".jsx") return jsxTranspiler;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return jsTranspiler;
  return tsTranspiler;
}

function resolveCssSpecifier(sourceFile: string, specifier: string): string | null {
  const clean = stripQuery(specifier);
  if (/\.module\.css$/i.test(clean)) return null;
  if (!isCssSpecifier(sourceFile, specifier)) return null;
  // The bare-specifier heuristic in isCssSpecifier() can match JS packages
  // whose name/subpath merely contains "css" (e.g. `@emotion/css`). Only
  // treat the import as CSS if it actually resolves to a .css file.
  const resolved = resolveSpecifier(clean, sourceFile, [".css"]);
  if (!resolved || !/\.css$/i.test(resolved)) return null;
  return resolved;
}

function resolveLocalModule(specifier: string, sourceFile: string): string | null {
  const clean = stripQuery(specifier);
  if (!clean.startsWith(".") && !clean.startsWith("/")) return null;
  const resolved = resolveSpecifier(clean, sourceFile, [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ]);
  if (!resolved) return null;
  if (!projectRoot) return resolved;
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function resolveSpecifier(
  specifier: string,
  sourceFile: string,
  extensions: string[],
): string | null {
  let candidate: string;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(path.dirname(sourceFile), specifier);
  } else {
    try {
      candidate = Bun.resolveSync(specifier, path.dirname(sourceFile));
    } catch {
      try {
        candidate = require.resolve(specifier, {
          paths: [path.dirname(sourceFile), process.cwd()],
        });
      } catch {
        return null;
      }
    }
  }

  if (path.extname(candidate) && fileExistsSync(candidate)) return candidate;
  for (const ext of extensions) {
    if (fileExistsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of extensions) {
    const indexPath = path.join(candidate, `index${ext}`);
    if (fileExistsSync(indexPath)) return indexPath;
  }
  return null;
}

function fileExistsSync(file: string): boolean {
  return existsSync(file);
}

function isCssSpecifier(sourceFile: string, specifier: string): boolean {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (/\.module\.css$/i.test(clean)) return false;
  if (/\.(scss|sass)$/i.test(clean)) return false;
  if (/\.css$/i.test(clean)) return true;

  try {
    const resolved = require.resolve(specifier, {
      paths: [path.dirname(sourceFile), process.cwd()],
    });
    if (/\.css$/i.test(resolved)) return true;
  } catch {
    // Fall back to common package export names such as `swiper/css`.
  }

  return /(^|\/)css(\/|$)/i.test(clean);
}

function isSourceCss(file: string): boolean {
  if (!sourceCssRoot) return false;
  const rel = path.relative(sourceCssRoot, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isVirtualOrBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  return /^[a-z][a-z0-9-]*:/.test(specifier) && !path.isAbsolute(specifier);
}

function stripQuery(p: string): string {
  const q = p.indexOf("?");
  return q === -1 ? p : p.slice(0, q);
}

function isCssOutput(output: BuildCssOutput): boolean {
  return output.type?.includes("text/css") === true || output.path.endsWith(".css");
}

function isJsOutput(output: BuildCssOutput): boolean {
  return output.type?.includes("javascript") === true || output.path.endsWith(".js");
}
