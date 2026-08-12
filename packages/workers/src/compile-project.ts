/**
 * Turns a virtual file map into the module bundle a Worker Loader executes.
 *
 * This is the whole of the "no filesystem" problem in one place. The Bun host lets
 * Bun's loader compile `.astro` on import and resolve the rest off disk; here every
 * module the isolate will ever see has to be named up front, so the project is
 * compiled as a unit: `.astro` through `@astrojs/compiler`, `.js` verbatim, and the
 * import specifiers rewritten to point at each other by bundle name.
 *
 * The Loader takes JavaScript, and the compiler copies `.astro` frontmatter into its
 * output verbatim — `export interface Props` included. So every module goes through
 * `stripTypes` on the way out, which also compiles the JSX in a `.tsx` page. That
 * runs *here*, in the host worker, which is the only place it can: workerd has no
 * `eval`, so nothing in the isolate could do it.
 */

import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import type { PreparedSite } from "@pletivo/core/artifact";
import { imageOutputPath } from "@pletivo/core/image";
import { compileAstro, parseAstro, type AstroCompiler } from "./astro-compiler.ts";
import { artifactBinder } from "./artifact.ts";
import {
  ASSETS_DIR,
  ASSETS_SOURCES,
  ASSETS_SPECIFIER,
  IMAGE_RUNTIME_SPECIFIER,
} from "./astro-assets.ts";
import { assetInfo, type ImageInfo, type ProjectAssets, type ProjectAsset } from "./content-files.ts";
import {
  ENV_CLIENT_SPECIFIER,
  ENV_MODULES,
  ENV_SERVER_SPECIFIER,
  IMPORT_META_ENV_GLOBAL,
  type ProjectEnvUse,
} from "./env.ts";
import {
  collectImportedNames,
  collectSpecifiers,
  resolveSpecifier,
  rewriteImports,
} from "./rewrite-imports.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  IMAGE_MODULE_NAME,
  JSX_RUNTIME_MODULE_NAME,
  RUNTIME_MODULES,
  RUNTIME_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import { md5Hex } from "./md5.ts";
import { isCollectableCss } from "./project-css.ts";
import { JSX_IMPORT_SPECIFIER, stripTypes, TranspileError } from "./transpile.ts";

/** One `<style>` block from a `.astro` file, in the order it was written. */
export interface StyleBlock {
  /** `<style is:global>`. Gated on the component rendering, not on its scope class. */
  global: boolean;
  css: string;
}

export interface AstroStyles {
  /** The compiler's scope hash — the page carries it as `class="astro-{scope}"`. */
  scope: string;
  blocks: StyleBlock[];
}

export interface CompiledProject {
  /** Module name -> JavaScript, ready for `env.LOADER`. Includes `@pletivo/runtime`. */
  modules: Record<string, string>;
  /**
   * The file map this was compiled from: the caller's, plus whatever the artifact
   * contributed. Everything downstream that walks the graph — the CSS pipeline above
   * all — has to see the same map, or a `node_modules` component's edges lead nowhere.
   */
  sources: ReadonlyMap<string, string>;
  /** Project path -> its module name, for the files that produced one. */
  moduleNames: ReadonlyMap<string, string>;
  /** Project path -> the `<style>` blocks it declares. */
  styles: ReadonlyMap<string, AstroStyles>;
  /** Project path -> the project paths it imports, in execution order. */
  imports: ReadonlyMap<string, string[]>;
  /**
   * Project path -> the stylesheets it imports for their side effect.
   *
   * Kept apart from `imports` because they are not edges the isolate walks — a `.css`
   * module is empty in the bundle. They are what the project stylesheet is built from;
   * see `project-css.ts`.
   */
  cssImports: ReadonlyMap<string, string[]>;
  /**
   * Set when something in the project imports the content API, which is what puts
   * `pletivo-content.js` in the bundle. `null` otherwise, and then the bundle carries
   * none of it — the collection runtime is roughly a megabyte, and most projects have
   * no collections.
   */
  content: ProjectContent | null;
  /**
   * Whether the bundle carries the image runtime — because a page imports
   * `astro:assets`, or because a collection may resolve an `image()` schema through
   * the content binding. `render.ts` reads it to decide what its prelude installs.
   */
  images: boolean;
  /**
   * Whether any module read `import.meta.env`, and therefore whether the entry has to
   * install the global it was rewritten to. See `substituteImportMetaEnv`.
   */
  importMetaEnv: boolean;
  /**
   * Set when something in the project imports `astro:env`, with the names it takes
   * from each half. `null` otherwise, and then the bundle carries neither module.
   *
   * The values themselves are not here and never enter the module map: they ride in
   * the isolate's `env`, so rotating a secret does not recompile the project. See
   * `env.ts`.
   */
  env: ProjectEnvUse | null;
  /**
   * Files a `?url` import named, keyed by the URL path the HTML will spell.
   *
   * `import href from "./form.js?url"` resolves to a *string*, and the file it names
   * has to be served from that string or the `<script src={href}>` written with it
   * 404s. The Bun host content-hashes it under `_astro/` (`url-asset.ts`) and copies
   * it into `dist`; here it comes back with the render, the same way the project
   * stylesheet does, because a Worker has nowhere to put a file.
   */
  urlAssets: ReadonlyMap<string, string>;
}

export interface ProjectContent {
  /**
   * Bundle name of the project's `content.config.*`, or `null` when it has none.
   * The isolate imports it to get the collection definitions — there is no other way
   * to obtain them, since `defineCollection` is a function call, not data.
   */
  configModule: string | null;
}

/**
 * The compiler bound to the `astro.wasm` the host worker's bundler embedded.
 *
 * Injectable because that binding only exists inside a real Worker — on Bun the
 * `.wasm` import resolves to a path, so tests hand in a compiler of their own.
 */
const bundled: AstroCompiler = { transform: compileAstro, parse: parseAstro };

/** Compiled to JavaScript by `@astrojs/compiler`. */
const COMPILED = ".astro";
/** Already JavaScript: carried into the bundle untouched. */
const VERBATIM = [".js", ".mjs"];
/**
 * Resolvable, but empty in the bundle.
 *
 * A frontmatter `import "./styles.css"` is a Vite side effect: the file is collected
 * into the project stylesheet (`cssImports` below, then `project-css.ts`) and the
 * module itself contributes nothing at run time. `.scss`/`.sass` resolve too, but
 * nothing compiles them yet — see `docs/todos/016`.
 */
const EMPTY = [".css", ".scss", ".sass"];
/** Compiled by sucrase rather than by `@astrojs/compiler`. */
const TRANSPILED = [".ts", ".tsx", ".jsx", ".mts", ".cts"];
/** Of those, the ones whose `<` is an element and not a type assertion. */
const WITH_JSX = [".tsx", ".jsx"];

/** Every extension that becomes a module in the bundle. */
const MODULE_EXTENSIONS = [COMPILED, ...VERBATIM, ...TRANSPILED, ...EMPTY];

/** Extensions that carry executable code, as opposed to a resolvable stub. */
const EXECUTABLE = [COMPILED, ...VERBATIM, ...TRANSPILED];

/** Whether a project path becomes a module the isolate can run. */
export function isExecutableModule(file: string): boolean {
  return EXECUTABLE.includes(extensionOf(file));
}

/**
 * Specifiers that name pletivo's content API rather than a project file.
 *
 * The bare ones are what a project writes. `astro:content` and `astro/loaders` are
 * Astro's own and the Bun host already answers to both — `astro-plugin.ts` registers
 * them as Bun virtual modules, for `.tsx` as much as for `.astro` — and
 * `pletivo/content` is the package's own `exports` entry. A project written against
 * either renders on both hosts with nothing changed.
 */
const CONTENT_API_MODULES = new Set(["astro:content", "astro/loaders", "pletivo/content"]);

/**
 * …and this is the shape *this repo* writes.
 *
 * Its fixtures predate the published package, so they reach into
 * `packages/pletivo/src/content/collection` by relative path — which
 * `resolveSpecifier` lands on the same project-root-relative key from every one of
 * them, however deep the importer sits. A path is not a package, so it can never be
 * in a virtual file map; matching it is what lets a fixture written for the Bun host
 * be previewed without being rewritten first.
 */
const PLETIVO_CONTENT_PATH = /(?:^|\/)pletivo\/src\/content\/(?:collection|index)(?:\.ts)?$/;

/** Whether a resolved specifier is the content API. */
export function isContentApi(resolved: string): boolean {
  return CONTENT_API_MODULES.has(resolved) || PLETIVO_CONTENT_PATH.test(resolved);
}

/**
 * Where a project's collection definitions live, in the order the Bun host looks —
 * `initCollections` takes the first that exists, so a project with both gets the same
 * one on either host.
 *
 * Matched as a suffix rather than resolved against a root, because `compileProject`
 * is handed the file map alone and the root only arrives with the request.
 */
const CONTENT_CONFIG_CANDIDATES = [
  "src/content.config.ts",
  "src/content.config.mts",
  "src/content.config.mjs",
  "src/content.config.js",
  "src/content/config.ts",
  "src/content/config.mts",
  "src/content/config.mjs",
  "src/content/config.js",
];

function findContentConfig(files: ReadonlyMap<string, string>): string | null {
  for (const candidate of CONTENT_CONFIG_CANDIDATES) {
    for (const file of files.keys()) {
      if (file === candidate || file.endsWith(`/${candidate}`)) return file;
    }
  }
  return null;
}

function extensionOf(file: string): string {
  const at = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  return at === -1 || at < slash ? "" : file.slice(at).toLowerCase();
}

/**
 * Extensions tried when a specifier names no file map key on its own, in the order
 * Bun's resolver tries them — so a project that runs on the Bun host resolves the same
 * way here.
 */
const IMPLIED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", ".mts", ".cts"];

/**
 * What a resolved specifier actually names in the file map.
 *
 * `import Layout from "../components/Layout"` is ordinary in a TypeScript project and
 * names no key; so is `import { x } from "./util.js"` when the file on disk is
 * `util.ts`, which is what `moduleResolution: nodenext` asks authors to write. Both
 * resolve off the filesystem on the Bun host, and both used to reach the isolate as an
 * unresolved specifier — `docs/todos/016 §7` listed them as the two smaller edges.
 *
 * Every caller that walks the graph goes through here, so the module rewriting, the
 * import edges and the CSS cascade order all agree on which file was meant.
 */
/**
 * Vite's import suffixes, of which pletivo answers two.
 *
 * `?raw` and `?inline` both mean the file's text here, because that is what the Bun
 * host's loader makes of them (`astro-plugin.ts:571`) and the two hosts have to agree.
 * (Vite's `?inline` is a data: URI — a divergence pletivo already carries.) `?url`
 * means the URL of the emitted file, which is a different thing entirely: a string
 * the HTML spells, and a file somebody then has to serve.
 */
export function importQuery(resolved: string): { file: string; kind: "text" | "url" } | null {
  const mark = resolved.indexOf("?");
  if (mark === -1) return null;
  const query = resolved.slice(mark + 1);
  const file = resolved.slice(0, mark);
  if (/(^|&)(raw|inline)(&|=|$)/.test(query)) return { file, kind: "text" };
  if (/(^|&)url(&|=|$)/.test(query)) return { file, kind: "url" };
  return null;
}

/**
 * The URL a `?url` import resolves to, and the file registered under it.
 *
 * `_astro/<base>.<md5-8><ext>`, which is what the Bun host emits (`url-asset.ts`), so
 * a project's markup spells the same href on either host. Content-hashed, so a host
 * can cache it forever and two renders of the same project agree on the name.
 */
function urlAssetHref(
  file: string,
  source: string,
  urlAssets: Map<string, string>,
): string {
  const slash = file.lastIndexOf("/");
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot);
  const href = `/_astro/${base}.${md5Hex(source).slice(0, 8)}${extension}`;
  urlAssets.set(href, source);
  return href;
}

export function resolveInFiles(
  resolved: string,
  files: ReadonlyMap<string, string>,
): string | null {
  if (files.has(resolved)) return resolved;
  const extension = extensionOf(resolved);
  // `./util.js` naming a `util.ts`: TypeScript's own convention, and it has to be
  // tried before the implied-extension pass or `util.js.ts` would be looked for first.
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = resolved.slice(0, -extension.length);
    for (const candidate of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(stem + candidate)) return stem + candidate;
    }
  }
  if (extension === "") {
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(resolved + candidate)) return resolved + candidate;
    }
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(`${resolved}/index${candidate}`)) return `${resolved}/index${candidate}`;
    }
  }
  return null;
}

/**
 * The name a project file takes in the bundle.
 *
 * Every module sits at the bundle root, so a relative specifier is always
 * `./<name>` no matter how deep the importer was — the isolate never has to
 * resolve a path. `seen` keeps two project paths that flatten to the same name
 * apart.
 */
function bundleName(file: string, seen: Map<string, string>): string {
  const base = file.replace(/[^A-Za-z0-9._-]/g, "_") + ".js";
  let name = base;
  for (let n = 2; seen.has(name) && seen.get(name) !== file; n++) {
    name = `${base.slice(0, -3)}.${n}.js`;
  }
  seen.set(name, file);
  return name;
}

/**
 * The compiler emits one `import '<file>?astro&type=style&index=N&lang.css'` per
 * `<style>` block, and nothing in the bundle answers to that specifier. The Bun
 * host strips the same imports for the same reason — the CSS is already in
 * `result.css`.
 */
function stripStyleImports(code: string): string {
  return code.replace(/import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?/g, "");
}

/**
 * Pair each `result.css[]` entry with the `<style>` block that produced it, so the
 * `is:global` ones can be told apart.
 *
 * Reading `is:global` off the source rather than looking for a `:where(.astro-…)`
 * marker in the compiled CSS is the same choice `classifyCompilerCss` makes on the
 * Bun host, for the same reason: the compiler cannot scope `body`, `html` or
 * `:root`, so a scoped block holding only those rules looks global but is not.
 */
export async function classifyStyles(
  css: string[],
  source: string,
  compiler: AstroCompiler = bundled,
): Promise<StyleBlock[]> {
  const { ast } = await compiler.parse(source);
  const blocks: StyleBlock[] = [];
  let index = 0;

  const visit = (node: Node): void => {
    if (is.element(node) && node.name === "style") {
      // The compiler drops blocks that compile to nothing, so skip them here too or
      // the 1:1 pairing with `css[index]` slips by one.
      const text = node.children.filter(is.text).map((child) => child.value).join("");
      if (text.replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0) return;
      if (index >= css.length) {
        throw new Error(
          "[pletivo-workers] more non-empty <style> blocks than css entries " +
            `(${css.length}); the @astrojs/compiler output contract may have changed`,
        );
      }
      blocks.push({
        global: node.attributes.some((attribute) => attribute.name === "is:global"),
        css: css[index++],
      });
      return;
    }
    if (is.parent(node)) for (const child of node.children) visit(child);
  };
  visit(ast);

  if (index !== css.length) {
    throw new Error(
      `[pletivo-workers] ${index} non-empty <style> block(s) but ${css.length} css entries; ` +
        "the @astrojs/compiler output contract may have changed",
    );
  }
  return blocks;
}

/** A project file the isolate cannot be given, and why. */
export class UnsupportedFileError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot compile ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedFileError";
  }
}

/**
 * Compile every module-shaped file in the map.
 *
 * Files the bundle has no use for (`.md`, images, `astro.config.mjs` outside the
 * graph) are simply not modules and are skipped; a file that *is* reachable but
 * needs a transpiler throws, because silently omitting it turns into an
 * unresolved import inside the isolate, which is much harder to read.
 *
 * `prepared` is what `pletivo prepare` froze: it answers the bare specifiers the file
 * map cannot, and contributes the `node_modules` sources those specifiers land on.
 * Without one, a bare specifier is left alone and the Loader reports it — which is
 * where every project with an npm dependency stood before the artifact existed.
 */
export async function compileProject(
  files: ReadonlyMap<string, string>,
  compiler: AstroCompiler = bundled,
  prepared: PreparedSite | null = null,
  /**
   * The project's binary files. An image *something imports* becomes a metadata
   * module, so `import hero from "./hero.png"` resolves to the same `{src, width,
   * height, format}` the Bun host's loader produces — built here, in the host worker,
   * because an ESM default export is a value and the isolate cannot go and fetch one.
   *
   * Only what is imported, not everything in the map: a photo site can hold thousands
   * of images and a page reaches a handful. The rest are named by the collections that
   * carry them, over the binding, one entry at a time.
   */
  assets: ProjectAssets = new Map(),
): Promise<CompiledProject> {
  const artifact = artifactBinder(prepared);
  files = withAssetSources(artifact.sources(files));
  /** Image path -> its metadata module, filled as `resolve` reaches each one. */
  const images = new Map<string, string>();
  /** `<file>?raw` / `<file>?url` -> the module that default-exports its value, same. */
  const queried = new Map<string, string>();
  /** URL path -> the file's text, for every `?url` import the project made. */
  const urlAssets = new Map<string, string>();
  const modules: Record<string, string> = { ...RUNTIME_MODULES };
  const moduleNames = new Map<string, string>();
  const styles = new Map<string, AstroStyles>();
  const imports = new Map<string, string[]>();
  const cssImports = new Map<string, string[]>();
  const takenNames = new Map<string, string>();
  /** Names taken from `astro:env/client` and `astro:env/server`, project-wide. */
  const envNames = new Map<string, Set<string>>(
    [...ENV_MODULES.keys()].map((specifier) => [specifier, new Set<string>()]),
  );

  /** Both edge sets a module contributes, read from the one specifier list. */
  const recordImports = (file: string, code: string): void => {
    const specifiers = collectSpecifiers(code);
    imports.set(file, resolveEdges(file, specifiers, files, isExecutableModule));
    cssImports.set(file, resolveEdges(file, specifiers, files, isCollectableCss));
    // The names, not just the specifier: a generated module's exports are static, so
    // `astro:env/server` has to be built knowing what this project asks of it.
    for (const [specifier, names] of envNames) {
      if (!specifiers.includes(specifier)) continue;
      for (const name of collectImportedNames(code, specifier)) names.add(name);
    }
  };

  // Names first: rewriting an import needs the target's name, whichever order the
  // files come in.
  for (const file of files.keys()) {
    if (MODULE_EXTENSIONS.includes(extensionOf(file))) {
      moduleNames.set(file, bundleName(file, takenNames));
    }
  }
  let usesContent = false;
  let usesImages = false;
  let usesImportMetaEnv = false;
  const usedEnv = new Set<string>();

  /** `import.meta.env` -> the global the entry installs, recorded so the entry knows to. */
  const withImportMetaEnv = (code: string): string => {
    const substituted = substituteImportMetaEnv(code);
    if (substituted.used) usesImportMetaEnv = true;
    return substituted.code;
  };

  const resolve = (resolved: string): string | null => {
    // The one bare specifier the bundle answers to on its own: sucrase writes it into
    // every module that holds JSX, and it names a package, not a project file.
    if (resolved === JSX_IMPORT_SPECIFIER) return `./${JSX_RUNTIME_MODULE_NAME}`;
    // The content API is the other. Everything that reaches for it — the config
    // module and every page that queries a collection — has to land on the *same*
    // module, or `initCollections` would fill a store the page never reads.
    if (isContentApi(resolved)) {
      usesContent = true;
      return `./${CONTENT_MODULE_NAME}`;
    }
    // `astro:assets` is Astro's own specifier and the Bun host answers it too. Here it
    // lands on generated sources the host worker compiles — `.astro` components cannot
    // be pre-built, since only the host worker has the compiler. See `astro-assets.ts`.
    if (resolved === ASSETS_SPECIFIER) {
      usesImages = true;
      const name = moduleNames.get(`${ASSETS_DIR}/index.ts`);
      return name === undefined ? null : `./${name}`;
    }
    if (resolved === IMAGE_RUNTIME_SPECIFIER) {
      usesImages = true;
      return `./${IMAGE_MODULE_NAME}`;
    }
    // An ESM-imported image: a module the host worker writes from what it knows about
    // the file. Built on demand, so nothing in `assets` is read until it is imported.
    const asset = assets.get(resolved);
    if (asset !== undefined) {
      let name = moduleNames.get(resolved);
      if (name === undefined) {
        const module = imageModule(resolved, asset);
        // Unreadable header: left out, so the import fails at the Loader by name
        // rather than resolving to a module with made-up dimensions in it.
        if (module === null) return null;
        name = bundleName(resolved, takenNames);
        moduleNames.set(resolved, name);
        images.set(resolved, module);
      }
      return `./${name}`;
    }
    // `astro:env` is Astro's own specifier and the Bun host answers to it too, so a
    // project that reads its configuration renders on either host unchanged. The
    // module it lands on is generated per render, because only the caller knows the
    // values — see `envModules` in env.ts.
    const envModule = ENV_MODULES.get(resolved);
    if (envModule !== undefined) {
      usedEnv.add(resolved);
      return `./${envModule}`;
    }
    const query = importQuery(resolved);
    if (query !== null) {
      let name = queried.get(resolved);
      if (name === undefined) {
        const target = resolveInFiles(query.file, files);
        const source = target === null ? undefined : files.get(target);
        if (source === undefined || target === null) return null;
        name = bundleName(resolved, takenNames);
        queried.set(resolved, name);
        moduleNames.set(resolved, name);
        const value = query.kind === "text" ? source : urlAssetHref(target, source, urlAssets);
        modules[name] = `export default ${JSON.stringify(value)};\n`;
      }
      return `./${name}`;
    }
    const file = resolveInFiles(resolved, files);
    const name = file === null ? undefined : moduleNames.get(file);
    if (name !== undefined) return `./${name}`;
    // Last, so a project file always outranks the artifact: everything above this is
    // a specifier no file map can hold, and everything below it is npm.
    return artifact.resolve(resolved, moduleNames);
  };

  for (const [file, source] of files) {
    const extension = extensionOf(file);
    const name = moduleNames.get(file);
    if (name === undefined) continue;

    if (EMPTY.includes(extension)) {
      modules[name] = "export {};\n";
      continue;
    }

    if (VERBATIM.includes(extension)) {
      modules[name] = rewriteImports(withImportMetaEnv(source), { importer: file, resolve });
      recordImports(file, source);
      continue;
    }

    if (TRANSPILED.includes(extension)) {
      const code = transpile(source, { file, jsx: WITH_JSX.includes(extension) });
      // The JSX import sucrase prepends is not a project edge, and `resolveEdges`
      // drops it for the same reason it drops any specifier outside the file map.
      recordImports(file, code);
      modules[name] = rewriteImports(withImportMetaEnv(code), { importer: file, resolve });
      continue;
    }

    const result = await compiler.transform(source, {
      filename: file,
      internalURL: `./${RUNTIME_MODULE_NAME}`,
      sourcemap: false,
      resolvePath: async (specifier) => specifier,
    });
    const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 1);
    if (errors.length > 0) {
      throw new UnsupportedFileError(
        file,
        `the Astro compiler reported\n${errors.map((error) => `  ${error.text}`).join("\n")}`,
      );
    }

    if (result.css.length > 0) {
      const blocks = await classifyStyles(result.css, source, compiler);
      if (blocks.length > 0) styles.set(file, { scope: result.scope, blocks });
    }

    // Types out before the graph is read: `import type` is not an edge, and with
    // `keepUnusedImports` nothing else in the prologue moves.
    const code = transpile(stripStyleImports(result.code), { file });
    recordImports(file, code);
    modules[name] = rewriteImports(withImportMetaEnv(code), { importer: file, resolve });
  }

  for (const [file, code] of images) {
    const name = moduleNames.get(file);
    if (name !== undefined) modules[name] = code;
  }

  let content: ProjectContent | null = null;
  if (usesContent) {
    modules[CONTENT_MODULE_NAME] = GENERATED_MODULES[CONTENT_MODULE_NAME];
    const configFile = findContentConfig(files);
    content = { configModule: configFile === null ? null : (moduleNames.get(configFile) ?? null) };
  }
  // The content runtime needs it too: an `image()` schema names the output file, and
  // `imageOutputPath` is what names it on both hosts.
  if (usesImages || usesContent) modules[IMAGE_MODULE_NAME] = GENERATED_MODULES[IMAGE_MODULE_NAME];

  // After the walk, so only the modules something actually imported are carried —
  // and transitively, since one artifact module may name another.
  Object.assign(modules, artifact.modules());

  const env = envUse(usedEnv, envNames);
  return {
    modules,
    sources: files,
    moduleNames,
    styles,
    imports,
    cssImports,
    content,
    images: usesImages || usesContent,
    importMetaEnv: usesImportMetaEnv,
    env,
    urlAssets,
  };
}

/**
 * `import.meta.env`, which a Worker Loader module does not have.
 *
 * Vite gives every module one; V8 hands `import.meta` to the *host*, so nothing a
 * generated module could assign would be visible to another module's `import.meta`.
 * The only way to answer it is the way Vite does — substitution — and this is it, with
 * the values behind a global so a rotated secret does not recompile the project.
 *
 * A textual replacement, and it says so: the same three tokens inside a string literal
 * are rewritten too. That is Vite's own failure mode with `define`, and the shape of
 * the mistake is visible in the output rather than silent. It runs after sucrase, on
 * generated JavaScript, so `.astro` frontmatter and `.tsx` are covered by one pass.
 */
const IMPORT_META_ENV = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;

function substituteImportMetaEnv(code: string): { code: string; used: boolean } {
  if (!IMPORT_META_ENV.test(code)) return { code, used: false };
  IMPORT_META_ENV.lastIndex = 0;
  return { code: code.replace(IMPORT_META_ENV, `globalThis.${IMPORT_META_ENV_GLOBAL}`), used: true };
}

/**
 * One image's module, holding what the Bun host's loader puts in the same place.
 *
 * `fsPath` is the file-map key rather than a filesystem path — it is what `getImage()`
 * tests to tell an ESM-imported image from a bare string, and what a host resolves
 * back to bytes when the browser asks for the URL. Non-enumerable, exactly as on the
 * Bun host, so it cannot leak through `JSON.stringify`.
 *
 * `null` when the file's header cannot be read: better an import that fails by name
 * than a component rendering made-up dimensions.
 */
function imageModule(file: string, asset: ProjectAsset): string | null {
  let info: ImageInfo;
  try {
    info = assetInfo(asset, file);
  } catch {
    return null;
  }
  const visible = {
    src: `/${imageOutputPath(file, info.hash)}`,
    width: info.width,
    height: info.height,
    format: info.format,
  };
  return (
    `const meta = ${JSON.stringify(visible)};\n` +
    `Object.defineProperty(meta, "fsPath", { value: ${JSON.stringify(file)}, enumerable: false });\n` +
    "export default meta;\n"
  );
}

/**
 * The `astro:assets` sources, added only for a project that names the specifier.
 *
 * A substring test rather than a parse, and deliberately generous: it runs before any
 * module has been read, and the cost of a false positive is three unreferenced modules
 * that nothing imports, while the cost of a false negative is a page that cannot
 * resolve `astro:assets` at all.
 */
function withAssetSources(files: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  for (const source of files.values()) {
    if (source.includes(ASSETS_SPECIFIER)) {
      return new Map([...Object.entries(ASSETS_SOURCES), ...files]);
    }
  }
  return files;
}

/**
 * Which `astro:env` modules the bundle needs, and the names each has to export.
 *
 * A specifier that was resolved but named nothing — a namespace import, a dynamic
 * `import()` — still yields an entry, with an empty list: the module has to exist, it
 * just takes its whole surface from what the host provided.
 */
function envUse(used: Set<string>, names: Map<string, Set<string>>): ProjectEnvUse | null {
  if (used.size === 0) return null;
  const of = (specifier: string): string[] | null =>
    used.has(specifier) ? [...(names.get(specifier) ?? [])].sort() : null;
  return { client: of(ENV_CLIENT_SPECIFIER), server: of(ENV_SERVER_SPECIFIER) };
}

/**
 * `stripTypes`, reported as an unsupported file.
 *
 * For `.astro` the position sucrase reports counts lines in the *compiled* module,
 * not in the source the author wrote — and the compiler puts the whole template on
 * one line — so an unqualified "(3:14)" points at a file nobody has. Say so.
 */
function transpile(code: string, options: { file: string; jsx?: boolean }): string {
  try {
    return stripTypes(code, options);
  } catch (error) {
    if (!(error instanceof TranspileError)) throw error;
    const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
    const where = options.file.endsWith(COMPILED)
      ? " (position is in the compiled output, not the .astro source)"
      : "";
    throw new UnsupportedFileError(options.file, detail + where);
  }
}

/**
 * Project paths an importer reaches that `keep` accepts, deduped, in order.
 *
 * The compiler emits both `import X from './X.astro'` and
 * `import * as $$module1 from './X.astro'` for the same component — one edge, not
 * two. Anything outside the file map is dropped: there is nothing to walk to.
 */
function resolveEdges(
  importer: string,
  specifiers: string[],
  files: ReadonlyMap<string, string>,
  keep: (file: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const edges: string[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveInFiles(resolveSpecifier(importer, specifier), files);
    if (resolved === null || seen.has(resolved)) continue;
    if (!keep(resolved)) continue;
    seen.add(resolved);
    edges.push(resolved);
  }
  return edges;
}
