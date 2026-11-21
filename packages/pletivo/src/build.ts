import path from "path";
import fs from "fs/promises";
import { scanRoutes } from "./router";
import { compareRoutes, matchRoute, pageOutputPath, resolveScriptRoute, routeToOutputPath, type Route, type RouteParams, type StaticPath } from "@pletivo/core/router";
import { createPaginate } from "@pletivo/core/paginate";
import { escapeStyleEnd } from "@pletivo/core/inline-style";
import {
  CONTENT_CONFIG_CANDIDATES,
  initCollections,
  getValidationFailures,
  runWithBunContentRuntime,
} from "./content/collection";
import { resetIslandRegistry } from "@pletivo/runtime/island";
import { runInPage, runWithRenderTracking, redirectPageHtml, redirectTemplate, AstroCookies, MAX_REWRITE_DEPTH, type AstroResponse, type PageContext } from "@pletivo/runtime/astro-shim";
import { hydrationScript } from "@pletivo/runtime/hydration";
import { finalizeIslandScripts } from "@pletivo/runtime/astro-islands/index";
import { bundleCss, stylesheetsForPage, type CssBundle, type Stylesheet } from "./css";
import { shouldInlineAsset, type AssetsInlineLimit } from "@pletivo/core/assets-inline";
import { readAssetsInlineLimit, readInlineStylesheets, stylesheetInliner } from "./assets-inline";
import { hashPublicAssets, copyPublicAssets, rewriteRefs } from "./assets";
import { islandPlugin, islandWrapperSource } from "./islands-bundle";
import { generateSitemap } from "./sitemap";
import { extractAstroScopes, resolveScopedStyleStrategy } from "@pletivo/core/astro-host/scoped-style";
import { registerProjectSourcePlugin } from "./project-source-plugin";
import { bundleRenderedIslands, setupAstroRenderers } from "./astro-renderers";
import { installImportMetaEnv } from "./import-meta-env";
import { configureScopedStyleStrategy, registerAstroPlugin, getAstroCssForPage, clearAstroCss, getAllHoistedScripts, clearHoistedScripts, hoistedScriptBunPlugin, hoistedEntrypoint, inlineHoistedScripts, HOISTED_URL_RE } from "./astro-plugin";
import { configureMarkdown, resolveMarkdownOptions } from "@pletivo/core/content/markdown";
import { assertPageLayoutSupported } from "./markdown-page";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { configureMdModules, registerMdPlugin } from "./md-plugin";
import { initAstroHost, buildAstroRoutes, type PletivoRouteWithPaths } from "./astro-host";
import { ProjectConfigError, srcDirMismatch } from "./astro-host/config-loader";
import { bundlePageScripts } from "./astro-host/page-scripts";
import { resolveI18nConfig } from "@pletivo/core/i18n/config";
import { detectRouteLocale } from "@pletivo/core/i18n/route-expansion";
import { setI18nRuntimeState } from "@pletivo/core/i18n/virtual-module";
import { generateFallbackEmissions, type FallbackEmission } from "@pletivo/core/i18n/fallback";
import { setImageMode, setImageService, setSharpResolveBase, clearTransforms, getTransforms, getImportedImages, processImages } from "./image";
import { setUrlAssetMode, getUrlAssets, clearUrlAssets } from "./url-asset";
import { setBase } from "@pletivo/runtime/base";
import { registerCssModulesPlugin, getCssModulesOutput, clearCssModules } from "./css-modules";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import { clearJsImportedCss, collectCssSideEffectImports, collectPageModuleCss, configureJsImportedCss, cssSideEffectBunPlugin, dynamicGraphOf, recordBuildCssOutputs, restoreDynamicGraph } from "./js-imported-css";
import { configureCssAssets, cssAssetBunPlugin, emittedCssAssets } from "./css-assets";
import { resolveImageServiceConfig, type PletivoConfig } from "./config";
import { SVELTE_CONFIG_NAMES } from "./framework-compile/svelte";
import { CacheStore, canReuseFingerprint, computeConfigHash, fingerprintFile, hashFileContent, paramsToKey, type CachedAstroIsland, type CachedCssHead } from "./incremental/cache";
import { configureImportGraph, configureImportGraphCompilers, collectStaticDeps, isWalkableSourceFile } from "./incremental/import-graph";
import { configureDepTracker, runWithRuntimeDepCapture, recordRuntimeDep } from "./incremental/dep-tracker";
import { recordDynamicGraph, recordWrittenOutput, resolveFragmentsHelper, runIncrementalRender, type FragmentsHelper, type RenderProducts, type RenderSource } from "./incremental/orchestrator";
import { extractEntryFilePaths } from "@pletivo/core/incremental/extract-deps";
import { escapeRegex } from "@pletivo/core/escape-regex";
import { pageDoctype } from "@pletivo/core/page-doctype";
import { resolveCompressHTML } from "@pletivo/core/astro-host/compile-options";
import { phase, timeSync, timeAsync, flushProfile } from "@pletivo/core/profile";
import { withAstroMarkdownDefaults } from "./astro-markdown";

/** Shape a dynamic page module is used through: its default export + getStaticPaths. */
interface DynamicMod {
  default?: unknown;
  getStaticPaths?: (ctx: unknown) => Promise<StaticPath[]>;
}

interface PageResult {
  file: string;
  label: string;
  outPath: string;
  /**
   * Absolute path of the page module this output was rendered from, when
   * one exists. Used to look up the page's CSS groups; leaving it unset
   * makes the page link every group (the pre-grouping behaviour).
   */
  pageEntry?: string;
  /**
   * Absolute path of the page's own module — the root of the import graph
   * that orders this page's hoisted `.astro` CSS. Left unset by results with
   * no module behind them (an i18n redirect stub), which have no CSS either.
   */
  entryFile?: string;
  /**
   * Rendered HTML when this page was freshly rendered this build.
   * Empty string for `source === "cached"` pages — they didn't go
   * through writeHtml (their HTML is already on disk from the
   * previous build) and downstream passes use `islands` /
   * `hoistedHashes` directly instead of re-scanning the HTML.
   */
  html: string;
  /**
   * Stable cache key for this rendered output. Populated only for
   * routes that flow through `runIncrementalRender` (i.e. static and
   * dynamic page routes). i18n fallback / 404 / injected paths leave
   * this undefined and are not subject to incremental caching.
   */
  routeKey?: string;
  /**
   * Component module ids (as passed to `$$createComponent`) whose
   * render function executed during this page's render pass. Used to
   * emit `<style is:global>` CSS for components present on the page —
   * the class-presence heuristic doesn't catch components that only
   * declare global styles and render no scoped DOM.
   */
  renderedModules?: Set<string>;
  /**
   * CSS collected from literal `<style>` JSX elements in TSX pages
   * and components during this render pass. Hoisted into <head>
   * alongside Astro scoped/global CSS.
   */
  tsxStyles?: string[];
  /**
   * Whether this page's HTML came from cache (already on disk from
   * the previous build) or was freshly rendered this build. Cached
   * pages skip writeHtml() — their HTML on disk already contains the
   * fully-injected `<head>` tags, public-asset rewrites, etc.
   */
  source?: RenderSource;
  /**
   * Island component names referenced from this page. For cached
   * pages: pulled from the cache (no HTML read needed). For freshly
   * rendered pages: scanned from the produced HTML during the render
   * pipeline.
   */
  islands?: string[];
  /** Hoisted-script hashes referenced from this page. Same lifecycle as `islands`. */
  hoistedHashes?: string[];
  /** Framework components the page's `<astro-island>`s hydrate. Same lifecycle as `islands`. */
  astroIslands?: CachedAstroIsland[];
  /**
   * Persisted byte size, populated only for cached pages (where the
   * orchestrator pulls it from the cache entry — no stat needed).
   * Fresh renders learn their size during writeHtml and record it
   * back via `recordWrittenOutput`.
   */
  cachedSize?: number;
  /** The stylesheet markup a cached page's HTML carries, from the cache entry; null for a page with no `</head>`. */
  cachedCssHead?: CachedCssHead | null;
  /** A dynamic route's params, so the late pass can render the slug again. */
  params?: RouteParams;
  /**
   * Emit `html` byte-for-byte, skipping writeHtml's HTML pipeline.
   * Endpoint routes and injected endpoints produce JSON/XML/text, which
   * asset-ref rewriting and CSS/hydration injection would corrupt — a page
   * with no `</head>` gets the `<style>` block prepended to its body.
   */
  raw?: boolean;
  /** The page module exports a truthy `partial`: an Astro project gives it no doctype. */
  partial?: boolean;
}

export interface BuildOptions {
  /**
   * Enable the incremental cache for this run — load prior dep
   * fingerprints + the dist snapshot, reuse unchanged routes, and save
   * the cache afterwards. Off by default: a plain build is a full
   * rebuild from scratch. Implied by `clean`.
   */
  incremental?: boolean;
  /**
   * Wipe `node_modules/.pletivo/cache/` and `dist/`, then build
   * incrementally from a clean slate. Implies `incremental`.
   * Equivalent to deleting `node_modules/.pletivo/cache/` before running.
   */
  clean?: boolean;
}

export function build(projectRoot: string, config: PletivoConfig, options: BuildOptions = {}) {
  return runWithBunContentRuntime(() => buildWithContentRuntime(projectRoot, config, options));
}

async function buildWithContentRuntime(projectRoot: string, config: PletivoConfig, options: BuildOptions) {
  const tStart = performance.now();
  const pagesDir = path.join(projectRoot, config.srcDir, "pages");
  const distDir = path.join(projectRoot, config.outDir);
  const publicDir = path.join(projectRoot, config.publicDir);
  const islandsDir = path.join(projectRoot, config.srcDir, "islands");
  const base = config.base.replace(/\/$/, "");

  // ── Incremental setup ──
  // Configure both layers of the dep tracker to scope resolution to
  // project sources only. (Static import graph + runtime file reads.)
  configureImportGraph(projectRoot);
  configureDepTracker(projectRoot);
  configureJsImportedCss(projectRoot, config.srcDir);

  const tPlugins = performance.now();
  await registerAstroPlugin();
  await registerMdxPlugin();
  await registerMdPlugin();
  await registerCssModulesPlugin();
  await registerScssPlugin(projectRoot);
  await registerProjectSourcePlugin(projectRoot, config.srcDir);
  const astroHost = await initAstroHost(projectRoot, "build");
  const srcDirError = srcDirMismatch(projectRoot, config.srcDir, astroHost?.configuredSrcDir);
  if (srcDirError) throw new ProjectConfigError(srcDirError);
  configureScopedStyleStrategy(resolveScopedStyleStrategy(astroHost?.config));
  configureMdModules(projectRoot, config.base, astroHost?.config.trailingSlash, astroHost !== null);
  // Before initCollections: content.config.ts is the first project module imported.
  installImportMetaEnv({ mode: "build", base: config.base, astroConfig: astroHost?.config });
  configureMdx(resolveMdxOptions(config, astroHost?.config));
  const markdownOptions = resolveMarkdownOptions(astroHost?.config);
  configureMarkdown(astroHost ? await withAstroMarkdownDefaults(astroHost.config, markdownOptions) : markdownOptions);
  configureScss(readScssOptions(astroHost?.config.vite));
  clearJsImportedCss();
  // Before any project module loads: the renderers decide how its framework components compile.
  const astroRenderers = await setupAstroRenderers({
    projectRoot,
    renderers: astroHost?.renderers ?? [],
    base: typeof astroHost?.config.base === "string" ? astroHost.config.base : config.base,
    beforeHydrationScripts: astroHost?.injectedBeforeHydrationScripts ?? [],
  });
  const scanAstroIslands = astroRenderers === null ? undefined : (html: string) => astroRenderers.componentsIn(html);
  configureImportGraphCompilers(astroRenderers?.compilers ?? []);
  phase("plugins+astroHost", tPlugins);
  const tColl = performance.now();
  await initCollections(projectRoot, config.srcDir);
  phase("initCollections", tColl);

  // Before the cache load: neither hook reads the cache, and `astro:build:setup` may
  // add the Vite plugin that serves a page script.
  const tAstroStart = performance.now();
  if (astroHost) {
    await astroHost.runBuildStart();
    await astroHost.runBuildSetup();
    // Execute page-ssr scripts — these run during SSR/build to set up
    // global state, polyfills, or registration before page rendering.
    for (const code of astroHost.injectedPageSsrScripts) {
      try {
        const fn = new Function(code);
        fn();
      } catch (e) {
        console.error(`  page-ssr script failed:`, (e as Error).message);
      }
    }
  }
  phase("astroHost runBuildStart+Setup", tAstroStart);

  // One inline module on every page, the same one `pletivo prepare` freezes for Workers.
  // It is part of every cached page, so it is part of the config hash.
  const pageScript = astroHost ? await bundlePageScripts(astroHost.injectedPageScripts, projectRoot) : null;

  // Cache + snapshot restore. `configHash` includes the pletivo config
  // and (if present) the user's astro config file content + lockfile —
  // any of those changing busts the entire route cache.
  const tCacheLoad = performance.now();
  const configHash = await computeProjectConfigHash(projectRoot, config, pageScript);
  // Incremental is opt-in: a plain build is a full rebuild. `clean`
  // implies incremental — you only wipe the cache to rebuild it fresh.
  const incremental = options.incremental || options.clean;
  if (!incremental) await CacheStore.discard(projectRoot);
  const outDir = path.relative(projectRoot, distDir);
  const cache: CacheStore | null = !incremental
    ? null
    : options.clean
      ? await CacheStore.forceClean(projectRoot, configHash, outDir)
      : await CacheStore.load(projectRoot, configHash, outDir);
  const fragments: FragmentsHelper | null = await resolveFragmentsHelper(projectRoot);
  phase("cache load + fragments resolve", tCacheLoad);

  // Persistent dist when incremental is on: we leave whatever the
  // previous build produced in place, and each route's writeHtml call
  // (for routes that actually re-render) overwrites the corresponding
  // file. Cached routes' HTML is already on disk and untouched.
  // Outputs of routes that no longer exist are pruned after the page
  // writes, from the previous build's route output record.
  //
  // With caching off we still wipe — that path matches the historical
  // pletivo behavior exactly so tooling that diffs dist/ across runs
  // keeps working. An incremental build without a record wipes too:
  // nothing would tell its stale route outputs from the rest of dist/.
  const tDistWipe = performance.now();
  if (!cache || cache.routeOutputs() === null) {
    await fs.rm(distDir, { recursive: true, force: true });
  }
  await fs.mkdir(distDir, { recursive: true });
  const assetsInlineLimit = readAssetsInlineLimit(astroHost?.config.vite);
  // Only Astro projects inline stylesheets; a pletivo project links every sheet.
  const inlineStylesheets = astroHost
    ? stylesheetInliner(readInlineStylesheets(astroHost.config.build), assetsInlineLimit)
    : null;
  // Extract `url()` targets from CSS into files rather than letting Bun
  // inline them as base64. Configured after the wipe and before the
  // first CSS-producing build (hoisted scripts), which runs well ahead
  // of bundleCss().
  configureCssAssets({
    outDir: path.join(distDir, "assets"),
    publicPath: `${base}/assets/`,
    inlineLimit: assetsInlineLimit,
  });
  // Snapshot the current dist filesystem once — runIncrementalRender
  // queries this Set instead of doing per-slug fs.access calls when
  // deciding whether a cached entry's output file is still on disk.
  // O(1) set lookups vs O(n) sequential stats.
  const distFiles = cache ? await collectDistFiles(distDir) : new Set<string>();
  phase("dist prep", tDistWipe);

  // Copy public/ into dist/, hashing assets on the way unless this is an
  // Astro project: Astro copies public/ verbatim, and user code builds
  // absolute URLs to those files that no rewrite can reach.
  // Returns a manifest of original → hashed paths, used below to rewrite
  // references inside rendered HTML.
  const tPublic = performance.now();
  const hashAssets = config.hashAssets ?? astroHost === null;
  const { manifest: publicManifest, written: publicWritten } = hashAssets
    ? await hashPublicAssets(publicDir, distDir)
    : await copyPublicAssets(publicDir, distDir);
  phase("public assets", tPublic);

  // Scan routes
  const tScan = performance.now();
  const routes = await scanRoutes(pagesDir);
  phase("scanRoutes", tScan);
  console.log(`Found ${routes.length} routes`);

  // Render all pages — static pages in parallel, dynamic sequentially
  const staticRoutes = routes.filter(
    (r) => !r.isDynamic && r.file !== "404.tsx" && r.file !== "404.jsx" && r.file !== "404.astro",
  );
  const dynamicRoutes = routes.filter((r) => r.isDynamic);

  const siteUrl = astroHost?.config.site ? new URL(astroHost.config.site) : undefined;
  // Astro builds each page from a request at `site`, or at its dev server's origin.
  const requestOrigin = siteUrl?.origin ?? (astroHost ? `http://localhost:${astroHost.config.server.port}` : "http://localhost/");
  // An Astro project names its output files by `build.format`; a native one writes `<path>/index.html`.
  const outputFormat = astroHost?.config.build.format;
  const i18n = resolveI18nConfig(astroHost?.config.i18n);
  // Install runtime state for the `astro:i18n` virtual module. Must
  // run before any .astro page module is imported, so that helpers
  // invoked at module evaluation time see the resolved config.
  setI18nRuntimeState(
    i18n,
    (astroHost?.config.base as string | undefined) ?? "/",
    astroHost?.config.site as string | undefined,
  );
  setBase((astroHost?.config.base as string | undefined) ?? config.base ?? "/");
  setImageMode("build");
  setImageService(resolveImageServiceConfig(config));
  setUrlAssetMode("build");
  // Resolve the optional `sharp` dep from the consumer project, not from
  // pletivo's own (possibly symlinked) location.
  setSharpResolveBase(projectRoot);
  // Mark the pletivo runtime so libraries can detect they run under pletivo
  // (e.g. @nuasite Image keeps emitting /cdn-cgi/image URLs because pletivo
  // serves the transform endpoint, instead of falling back to a raw <img>).
  (globalThis as Record<string, unknown>).__PLETIVO__ = true;
  clearTransforms();
  clearUrlAssets();

  /**
   * Which page module produced a render's HTML when the page rewrote, keyed
   * by the render's page context. The output takes that module's CSS: its
   * HTML is the target's, and a page links only the CSS groups its own
   * entry reaches, so linking the rewriting page's groups would drop the
   * target's stylesheets.
   */
  const rewriteEntries = new WeakMap<object, string>();
  /** The module whose CSS a render's output should link. */
  function cssEntryOf(ctx: ReturnType<typeof makePageContext>, ownEntry: string): string {
    return rewriteEntries.get(ctx.__pageContext) ?? ownEntry;
  }
  /** Whether the rewrite target's module is a partial, keyed like `rewriteEntries`: Astro reads the target's. */
  const rewritePartials = new WeakMap<object, boolean>();
  function partialOf(ctx: ReturnType<typeof makePageContext>, ownPartial: boolean): boolean {
    return rewritePartials.get(ctx.__pageContext) ?? ownPartial;
  }

  /**
   * Backs `Astro.rewrite` during a build: re-runs routing for `target` and
   * renders that route's component, so its HTML gets written at the
   * rewriting route's path. `depth` guards against rewrite cycles.
   */
  async function resolveRewrite(
    target: string,
    depth: number,
    from: object,
  ): Promise<Response | null> {
    if (depth > MAX_REWRITE_DEPTH) {
      throw new Error(
        `Astro.rewrite("${target}") exceeded ${MAX_REWRITE_DEPTH} hops (a cycle?)`,
      );
    }
    const rawPath = (target.split("?")[0] || "/").replace(/^\/+/, "/");
    const routePath = rawPath === "/" ? "/" : rawPath.replace(/\/$/, "");
    for (const route of routes) {
      const params = matchRoute(route, routePath);
      if (params === null) continue;
      const fullPath = path.join(pagesDir, route.file);
      // The target is resolved by runtime string, so neither the static
      // import graph nor any wrapped API sees it. Without this the
      // incremental cache would serve stale HTML for the rewriting page
      // after the target's source changed.
      recordRuntimeDep(fullPath);
      await assertPageLayoutSupported(fullPath, projectRoot);
      const mod = await import(fullPath);
      if (typeof mod.default !== "function") continue;
      // A dynamic target still needs its getStaticPaths props, or the
      // rewritten page renders with params but no data. Goes through the
      // build's memo, so the target's getStaticPaths runs once per build.
      let props: Record<string, unknown> = {};
      if (route.isDynamic) {
        const key = paramsToKey(params);
        const match = (await getDynamicStaticPaths(route.file, route)).find(
          (sp) => paramsToKey(sp.params) === key,
        );
        if (!match) continue;
        props = match.props || {};
      }
      const ctx = makePageContext(routePath, params, route, undefined, depth + 1);
      const html = await renderComponent(mod.default, props, ctx);
      if (html === null) continue;
      // A chain of rewrites ends at the innermost page.
      rewriteEntries.set(from, cssEntryOf(ctx, fullPath));
      rewritePartials.set(from, partialOf(ctx, Boolean(mod.partial)));
      return htmlResponse(html);
    }
    return null;
  }

  function makePageContext(
    pathname: string,
    params: RouteParams,
    route: Route,
    localeOverride?: string,
    rewriteDepth = 0,
  ) {
    const urlPath = "/" + pathname.replace(/^\//, "");
    // `preferredLocale` is always undefined in static output — there's
    // no request to read Accept-Language from. `currentLocale` comes
    // from the route's source directory (or the default locale for
    // unprefixed root pages), or from an explicit override when this
    // render is a localized fallback (rewrite of another locale's
    // content at the target locale's URL).
    const currentLocale =
      localeOverride ??
      (i18n ? detectRouteLocale(route, i18n).locale?.code : undefined);
    const pageContext = {
      url: new URL(urlPath, requestOrigin),
      site: siteUrl,
      params,
      currentLocale,
      preferredLocale: undefined as string | undefined,
      preferredLocaleList: [] as string[],
      // Owned here rather than left to the shim's default so the caller can
      // read back what the page wrote and warn that it goes nowhere.
      response: {
        status: 200,
        statusText: "OK",
        headers: new Headers(),
      } as AstroResponse,
      cookies: new AstroCookies(),
      rewrite: (target: string): Promise<Response | null> =>
        resolveRewrite(target, rewriteDepth, pageContext),
      // No request during a build, so `Astro.clientAddress` throws if read.
    };
    return { __pageContext: pageContext };
  }

  /**
   * Pletivo prerenders every page, so anything a render writes to
   * `Astro.response` / `Astro.cookies` is discarded — a file on disk carries
   * no headers. That's the correct static output, but silently correct is how
   * a site ships with cache headers that never reach the CDN. Warn instead.
   *
   * Only fires for pages that actually rendered; a warm incremental build
   * reuses cached HTML and has nothing to inspect.
   */
  const ssrWarned = new Set<string>();
  function warnDroppedSsrWrites(
    label: string,
    ctx: ReturnType<typeof makePageContext>,
    mod?: Record<string, unknown>,
  ): void {
    if (ssrWarned.has(label)) return;
    const { response, cookies } = ctx.__pageContext;
    const dropped: string[] = [];
    const headerNames = [...response.headers.keys()];
    if (headerNames.length > 0) {
      dropped.push(`Astro.response.headers (${headerNames.join(", ")})`);
    }
    if (response.status !== 200) {
      dropped.push(`Astro.response.status (${response.status})`);
    }
    const cookieCount = [...cookies.headers()].length;
    if (cookieCount > 0) {
      dropped.push(`Astro.cookies (${cookieCount} written)`);
    }
    // `prerender = false` is worth saying out loud even when the page wrote
    // nothing — it means the author expected a server, and there isn't one.
    const optedOut = mod?.prerender === false;
    if (dropped.length === 0 && !optedOut) return;
    ssrWarned.add(label);
    const detail = dropped.length > 0 ? ` — dropped: ${dropped.join("; ")}` : "";
    const why = optedOut
      ? "sets `prerender = false`, but pletivo prerenders every page"
      : "wrote SSR-only response state while being prerendered";
    console.warn(`  ${label} ${why}${detail}`);
  }

  // Pre-resolve each dynamic route's getStaticPaths once — the result is
  // reused by both `astro:routes:resolved` (for sitemap et al.) and the
  // render loop below, avoiding a double-fetch.
  //
  // Strategy:
  //   1. Use the dynamic-route cache to obtain the param sets (slug
  //      lists). Always JSON-safe, so this works for every dynamic
  //      route — including collection-backed ones whose props carry
  //      non-serializable values like `render()` methods.
  //   2. Iterate slugs and build the per-slug cache decision (skip
  //      vs render) WITHOUT props — props aren't needed for the
  //      skip decision, only for an actual render.
  //   3. Only call `getStaticPaths()` for routes whose deps drifted
  //      OR whose slugs include at least one that needs to re-render.
  //      On a fully-cached warm build no getStaticPaths runs at all.
  //
  // `dynamicPathsResolver` is the lazy bridge: render call sites
  // invoke it to get `props` for a slug, triggering at most one
  // `getStaticPaths` call per route per build.
  const tDynPaths = performance.now();
  const dynamicParamSets = new Map<string, Array<{ params: Record<string, string | undefined> }>>();
  const dynamicMods = new Map<string, DynamicMod>();
  const dynamicStaticPathsCache = new Map<string, Promise<StaticPath[]>>();
  const dynamicRouteCacheable = new Map<string, () => Promise<void>>();
  // Extensionless dynamic endpoints (`[id].ts` with GET()), known only once imported.
  const dynamicScriptEndpoints = new Set<string>();
  async function importDynamicRouteModule(fullPath: string): Promise<{ default?: unknown; getStaticPaths?: (ctx: unknown) => Promise<StaticPath[]> }> {
    await assertPageLayoutSupported(fullPath, projectRoot);
    const mod = await import(fullPath);
    await collectPageModuleCss(fullPath, `page:${fullPath}`);
    return mod;
  }

  for (const route of dynamicRoutes) {
    const fullPath = path.join(pagesDir, route.file);

    const cachedDyn = cache?.getDynamicRoute(route.file);
    if (cachedDyn && (await canReuseDeps(cachedDyn.depFingerprints))) {
      // Fast path: deps unchanged → reuse the cached param sets and
      // defer getStaticPaths until a slug actually needs to render.
      dynamicParamSets.set(route.file, cachedDyn.paramSets);
      continue;
    }

    // Slow path: deps drifted (or no cache) — run getStaticPaths
    // now, capture its file reads as deps for next time, and stash
    // the fresh path list so per-slug renders can read props from
    // it without re-importing.
    const { value: sp, runtimeDeps } = await runWithRuntimeDepCapture(async () => {
      const mod = await importDynamicRouteModule(fullPath);
      dynamicMods.set(route.file, mod);
      if (resolveScriptRoute(route, mod).isEndpoint) {
        dynamicScriptEndpoints.add(route.file);
        return null;
      }
      if (typeof mod.default !== "function") return null;
      if (typeof mod.getStaticPaths !== "function") return null;
      const paginate = createPaginate(route, base || "/", astroHost?.config.trailingSlash);
      return (await mod.getStaticPaths({ paginate })) as StaticPath[];
    });
    if (!sp) continue;
    dynamicParamSets.set(route.file, sp.map((p) => ({ params: p.params })));
    dynamicStaticPathsCache.set(route.file, Promise.resolve(sp));

    if (cache) {
      const staticDeps = await collectStaticDeps(fullPath);
      const allDeps = new Set<string>([...staticDeps, ...runtimeDeps]);
      // Walk transitive imports of any runtime dep that's a source
      // file (typical case: an .mdx/.astro entry surfaced by
      // getCollection — its body can `import` arbitrary modules that
      // contribute to slug HTML). Without this walk, the helper
      // wouldn't appear in this route's depFingerprints, the
      // `assumeDepsValid` shortcut would skip the per-slug check,
      // and an edit to the helper would silently leave slugs stale.
      const walks = await Promise.all(
        [...runtimeDeps].map((d) => (isWalkableSourceFile(d) ? collectStaticDeps(d) : null)),
      );
      for (const w of walks) {
        if (w) for (const d of w) allDeps.add(d);
      }
      // Persist the cache update lazily — we want the depFingerprints
      // computed only when we're sure this route succeeds, and the
      // fingerprint work itself is parallelizable across all routes.
      dynamicRouteCacheable.set(route.file, async () => {
        const depFingerprints: Record<string, import("./incremental/cache").DepFingerprint> = {};
        await Promise.all([...allDeps].map(async (d) => {
          depFingerprints[d] = await fingerprintFile(d);
        }));
        cache.setDynamicRoute(route.file, {
          paramSets: sp.map((p) => ({ params: p.params })),
          depFingerprints,
        });
      });
    }
  }

  // Flush the deferred dynamic-route cache writes in parallel.
  await Promise.all([...dynamicRouteCacheable.values()].map((fn) => fn()));
  phase("getStaticPaths (all dynamic routes)", tDynPaths);

  /**
   * Returns the full StaticPath list for a dynamic route — with
   * props. If we already ran getStaticPaths this build (cache miss
   * path), the result was stashed. Otherwise this is the first slug
   * that needs to actually render → import the module + run
   * getStaticPaths once and memoize for any later siblings.
   */
  function getDynamicStaticPaths(routeFile: string, route: Route): Promise<StaticPath[]> {
    const cached = dynamicStaticPathsCache.get(routeFile);
    if (cached) return cached;
    const fullPath = path.join(pagesDir, routeFile);
    const fetch = (async () => {
      let mod = dynamicMods.get(routeFile);
      if (!mod) {
        // Cast to the map's value type, not `typeof mod` — the latter is
        // `DynamicMod | undefined`, which infects the set() and every use below.
        await assertPageLayoutSupported(fullPath, projectRoot);
        mod = (await import(fullPath)) as DynamicMod;
        dynamicMods.set(routeFile, mod);
      }
      if (typeof mod.getStaticPaths !== "function") return [] as StaticPath[];
      const paginate = createPaginate(route, base || "/", astroHost?.config.trailingSlash);
      return await mod.getStaticPaths({ paginate });
    })();
    dynamicStaticPathsCache.set(routeFile, fetch);
    return fetch;
  }

  // astro:routes:resolved — fire before rendering so integrations like
  // @astrojs/sitemap and @nuasite/agent-summary can capture the full
  // route tree. Redirects declared in astro.config are included as
  // type: "redirect" entries.
  const tRoutesResolved = performance.now();
  if (astroHost) {
    const pletivoRoutes: PletivoRouteWithPaths[] = routes.map((r) => {
      const paramSet = dynamicParamSets.get(r.file);
      // Synthesize StaticPath[] for routes:resolved — integrations
      // (sitemap, agent-summary) only need the params, not props, so
      // we can hand them the cached param sets straight through.
      const staticPaths = paramSet ? paramSet.map((p) => ({ params: p.params }) as StaticPath) : undefined;
      return { route: r, staticPaths };
    });
    const astroRoutes = buildAstroRoutes(pletivoRoutes, astroHost.config, config.srcDir, astroHost.injectedRoutes);
    await astroHost.runRoutesResolved(astroRoutes);
    // Stash for build:done below so we don't rebuild the array
    (astroHost as unknown as { __cachedRoutes?: unknown }).__cachedRoutes = astroRoutes;
  }
  phase("astro:routes:resolved", tRoutesResolved);

  const results: PageResult[] = [];

  // Static pages — parallel
  const tStatic = performance.now();
  /** `forceRender` skips the route's cache entry: the late pass after `bundleCss` uses it. */
  async function renderStaticRoute(route: Route, forceRender: boolean): Promise<PageResult | null> {
    const fullPath = path.join(pagesDir, route.file);
    const outFile = routeToOutputPath(route, {}, outputFormat);
    const outPath = path.join(distDir, outFile);
    const routeKey = `${route.file}::__static__`;

    await assertPageLayoutSupported(fullPath, projectRoot);
    const mod = await import(fullPath);
    // Collect CSS side-effect imports from non-.astro page modules. Runs
    // unconditionally (even for cached pages) so the global stylesheet
    // stays complete — mirrors the astro plugin's onLoad collection.
    await collectPageModuleCss(fullPath, `page:${route.file}`);

    // Endpoint routes (robots.txt.ts, rss.xml.ts, api.ts) emit their GET()
    // body verbatim. Not incrementally cached: the cache layer is HTML-shaped,
    // and endpoints are a handful of cheap routes per project.
    const servedRoute = resolveScriptRoute(route, mod);
    if (servedRoute.isEndpoint) {
      const endpointFile = routeToOutputPath(servedRoute, {});
      const body = await renderEndpoint(mod, makeEndpointContext("/" + endpointFile, siteUrl, requestOrigin));
      if (body === null) {
        console.warn(`  Skipping ${route.file}: endpoint route without an exported GET()`);
        return null;
      }
      return { file: route.file, label: route.file, pageEntry: fullPath, outPath: path.join(distDir, endpointFile), html: body, raw: true };
    }

    if (typeof mod.default !== "function") {
      console.warn(`  Skipping ${route.file}: no default export function`);
      return null;
    }
    const pathname = toPathname(outPath, distDir);
    let partial = Boolean(mod.partial);
    const outcome = await runIncrementalRender({
      routeKey,
      outFile,
      pageEntryAbsPath: fullPath,
      distDir,
      cache,
      fragments,
      distFiles,
      scanAstroIslands,
      forceRender,
      doRender: async () => {
        resetIslandRegistry();
        const ctx = makePageContext(pathname, {}, route);
        const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
          renderComponent(mod.default, {}, ctx),
        );
        partial = partialOf(ctx, partial);
        warnDroppedSsrWrites(route.file, ctx, mod);
        return { html: html ?? "", renderedModules, tsxStyles, cssEntry: rewriteEntries.get(ctx.__pageContext) };
      },
    });
    if (outcome.source === "rendered" && outcome.html === "") {
      console.warn(`  Skipping ${route.file}: default export didn't return HTML`);
      return null;
    }
    const cssEntry = outcome.cssEntry ?? fullPath;
    return { file: route.file, entryFile: cssEntry, label: route.file, pageEntry: cssEntry, outPath, html: outcome.html, renderedModules: outcome.renderedModules, tsxStyles: outcome.tsxStyles, source: outcome.source, routeKey, islands: outcome.islands, hoistedHashes: outcome.hoistedHashes, astroIslands: outcome.astroIslands, cachedSize: outcome.size, cachedCssHead: outcome.cssHead, partial };
  }
  const staticResults = await Promise.all(staticRoutes.map((route) => renderStaticRoute(route, false)));
  results.push(...staticResults.filter((r): r is PageResult => r !== null));
  phase("static routes", tStatic);

  // Dynamic pages — sequential (per-route getStaticPaths may share
  // state). Lazy bridges keep the warm-noop path almost free:
  //   • `getDynamicStaticPaths` only runs getStaticPaths if we end up
  //     needing props (i.e. at least one slug actually re-renders).
  //   • `getPropsFor` resolves a slug's props on first request and
  //     reuses the resolved StaticPath[] across siblings.
  //   • When the parent dynamic-route cache entry is still valid we
  //     skip per-slug fingerprint checks — they'd just re-stat files
  //     already covered by the route's deps. Cuts ~80% of warm-build
  //     stat calls for content-collection-backed routes.
  const tDynamic = performance.now();
  // One per dynamic route, not per page: the late pass after `bundleCss` renders a slug again from its params.
  const dynamicSlugRenderers = new Map<string, (params: RouteParams, forceRender: boolean) => Promise<PageResult | null>>();
  for (const route of dynamicRoutes) {
    // Dynamic endpoints (`[slug].json.ts`) are not supported. Say so loudly —
    // silently emitting nothing is how a broken deploy ships green.
    if (route.isEndpoint || dynamicScriptEndpoints.has(route.file)) {
      console.warn(`  Skipping ${route.file}: dynamic endpoint routes are not supported (only static ones like rss.xml.ts)`);
      continue;
    }
    const paramSets = dynamicParamSets.get(route.file);
    if (!paramSets) {
      console.warn(`  Skipping ${route.file}: dynamic route without getStaticPaths()`);
      continue;
    }
    const fullPath = path.join(pagesDir, route.file);
    // If the dynamic-route cache entry survived this build's
    // canReuseDeps check, every input the slug's render could read is
    // already known-unchanged. Per-slug canReuse would just re-stat
    // the same files.
    const assumeDepsValid =
      cache !== null && dynamicMods.get(route.file) === undefined && cache.getDynamicRoute(route.file) !== undefined;
    let modPromise: Promise<{ default?: unknown; partial?: unknown }> | null = null;
    const getMod = (): Promise<{ default?: unknown; partial?: unknown }> => {
      if (!modPromise) {
        const prefetched = dynamicMods.get(route.file);
        modPromise = prefetched
          ? Promise.resolve(prefetched)
          : importDynamicRouteModule(fullPath);
      }
      return modPromise;
    };
    const hasCachedSlug = cache !== null && paramSets.some(({ params }) => {
      const routeKey = `${route.file}::${paramsToKey(params)}`;
      return cache.getRoute(routeKey) !== undefined;
    });
    if (hasCachedSlug && !dynamicMods.has(route.file)) {
      dynamicMods.set(route.file, await importDynamicRouteModule(fullPath));
    }
    // Index resolved paths by `paramsToKey(params)` so we can look up
    // a slug's props on demand without a linear scan each time.
    let propsIndexPromise: Promise<Map<string, Record<string, unknown> | undefined>> | null = null;
    const getPropsFor = async (paramsKey: string): Promise<Record<string, unknown> | undefined> => {
      if (!propsIndexPromise) {
        propsIndexPromise = getDynamicStaticPaths(route.file, route).then((paths) => {
          const idx = new Map<string, Record<string, unknown> | undefined>();
          for (const p of paths) idx.set(paramsToKey(p.params), p.props);
          return idx;
        });
      }
      return (await propsIndexPromise).get(paramsKey);
    };
    const renderSlug = async (params: RouteParams, forceRender: boolean): Promise<PageResult | null> => {
      const outFile = routeToOutputPath(route, params, outputFormat);
      const outPath = path.join(distDir, outFile);
      const pathname = toPathname(outPath, distDir);
      const ctx = makePageContext(pathname, params, route);
      const paramsKey = paramsToKey(params);
      const routeKey = `${route.file}::${paramsKey}`;
      const outcome = await runIncrementalRender({
        routeKey,
        outFile,
        pageEntryAbsPath: fullPath,
        distDir,
        cache,
        fragments,
        distFiles,
        assumeDepsValid,
        forceRender,
        scanAstroIslands,
        // Lazy thunk — only invoked on the fresh-render path. Forces
        // getStaticPaths to resolve (just once, memoized across all
        // slugs of this route) so we can read the slug's pathProps
        // and extract the content-collection backing files as deps.
        extraDeps: async () => extractEntryFilePaths(await getPropsFor(paramsKey)),
        doRender: async () => {
          resetIslandRegistry();
          const mod = await getMod();
          const pathProps = await getPropsFor(paramsKey);
          const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
            renderComponent(mod.default as (props: Record<string, unknown>) => unknown, pathProps || {}, ctx),
          );
          // Keyed by route file, not by slug — one warning per route is the
          // signal; repeating it per slug is noise.
          warnDroppedSsrWrites(route.file, ctx, mod as Record<string, unknown>);
          return { html: html ?? "", renderedModules, tsxStyles, cssEntry: rewriteEntries.get(ctx.__pageContext) };
        },
      });
      if (outcome.source === "rendered" && outcome.html === "") return null;

      const label = `${route.file} [${Object.values(params).join("/")}]`;
      const cssEntry = outcome.cssEntry ?? fullPath;
      // A cached slug is not written again, and its module may not be loaded.
      const partial = outcome.source === "rendered" && partialOf(ctx, Boolean((await getMod()).partial));
      return { file: route.file, params, entryFile: cssEntry, label, pageEntry: cssEntry, outPath, html: outcome.html, renderedModules: outcome.renderedModules, tsxStyles: outcome.tsxStyles, source: outcome.source, routeKey, islands: outcome.islands, hoistedHashes: outcome.hoistedHashes, astroIslands: outcome.astroIslands, cachedSize: outcome.size, cachedCssHead: outcome.cssHead, partial };
    };
    dynamicSlugRenderers.set(route.file, renderSlug);
    for (const { params } of paramSets) {
      const result = await renderSlug(params, false);
      if (result) results.push(result);
    }
  }
  phase("dynamic routes", tDynamic);

  // As in Astro, a path two routes build is the page of the higher-priority route
  // (`compareRoutes`): a static route's over a dynamic one's, `[a]`'s over `[b]`'s.
  const routeByFile = new Map(routes.map((route) => [route.file, route]));
  const outranks = (result: PageResult, owner: PageResult): boolean => {
    const route = routeByFile.get(result.file);
    const ownerRoute = routeByFile.get(owner.file);
    return route !== undefined && ownerRoute !== undefined && compareRoutes(route, ownerRoute) < 0;
  };
  const pathOwners = new Map<string, PageResult>();
  for (const result of results) {
    const owner = pathOwners.get(result.outPath);
    if (owner === undefined || outranks(result, owner)) pathOwners.set(result.outPath, result);
  }
  for (const result of results) {
    const owner = pathOwners.get(result.outPath);
    if (owner === undefined || owner === result) continue;
    console.warn(
      `  Skipping ${result.label}: ${path.relative(distDir, result.outPath)} is built by the higher-priority route ${owner.file}`,
    );
  }
  const routeResults = results.filter((result) => pathOwners.get(result.outPath) === result);
  results.splice(0, results.length, ...routeResults);

  // Render i18n fallback emissions + default-locale redirects. Each
  // emission produces either a rewrite (render source component with
  // target locale override) or a redirect HTML document. Fallback
  // emissions are additive to the page set — they never replace an
  // existing rendered route, so we emit them after the main loops.
  if (i18n) {
    // i18n fallback emissions need the full StaticPath[] (params + props)
    // because rewrite-mode renders the source component with the
    // fallback target locale, which requires re-supplying the original
    // props. Materialize props for every dynamic route now — this is
    // the one case where the lazy bridge isn't enough.
    const dynamicPaths = new Map<string, StaticPath[]>();
    for (const route of dynamicRoutes) {
      if (!dynamicParamSets.has(route.file)) continue;
      dynamicPaths.set(route.file, await getDynamicStaticPaths(route.file, route));
    }
    // Redirects and fallback URLs need to account for Astro's `base`
    // config (e.g. `/new-site`). Prefer the astro host's base, falling
    // back to pletivo's own config for non-astro-host projects.
    const astroBase =
      (astroHost?.config.base as string | undefined) ?? base ?? "/";
    const emissions = generateFallbackEmissions({
      routes,
      i18n,
      dynamicPaths,
      base: astroBase,
    });
    for (const emission of emissions) {
      const outFile = pageOutputPath(
        emission.targetPathname.split("/").filter(Boolean),
        outputFormat ?? "directory",
        /(^|\/)index\.[^/]+$/.test(emission.sourceRoute.file),
      );
      const outPath = path.join(distDir, outFile);
      const label = `[i18n ${emission.mode}] ${emission.targetPathname}`;

      if (emission.mode === "redirect") {
        // Astro serves these through its i18n middleware, which redirects with a 302.
        const html = redirectTemplate({
          status: 302,
          location: emission.redirectTo ?? "/",
          from: astroRequestPath(emission.targetPathname, astroBase, astroHost?.config.trailingSlash, astroHost?.config.build.format),
          site: siteUrl,
          compressHTML: resolveCompressHTML(astroHost?.config) ?? true,
        });
        results.push({
          file: emission.sourceRoute.file,
          label,
          outPath,
          html,
        });
        continue;
      }

      // Rewrite mode — render the source component with the target
      // locale override so `Astro.currentLocale` reports the fallback
      // target, not the source.
      const srcFullPath = path.join(pagesDir, emission.sourceRoute.file);
      const mod = await import(srcFullPath);
      if (typeof mod.default !== "function") continue;
      resetIslandRegistry();
      const ctx = makePageContext(
        emission.targetPathname,
        emission.sourceParams,
        emission.sourceRoute,
        emission.targetLocale,
      );
      const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
        renderComponent(mod.default, emission.sourceProps || {}, ctx),
      );
      if (html === null) continue;
      results.push({
        file: emission.sourceRoute.file,
        entryFile: cssEntryOf(ctx, srcFullPath),
        label,
        pageEntry: cssEntryOf(ctx, srcFullPath),
        outPath,
        html,
        renderedModules,
        tsxStyles,
        partial: partialOf(ctx, Boolean(mod.partial)),
      });
    }
  }

  // Render injected routes from integrations (injectRoute during config:setup).
  // Endpoints export GET() returning a Response; pages export a default component.
  if (astroHost && astroHost.injectedRoutes.length > 0) {
    for (const injected of astroHost.injectedRoutes) {
      try {
        const entrypoint = await resolveEntrypoint(injected.entrypoint, projectRoot);
        await assertPageLayoutSupported(entrypoint, projectRoot);
        const mod = await import(entrypoint);
        await collectPageModuleCss(entrypoint, `page:${entrypoint}`);
        const pattern = injected.pattern.replace(/^\//, "");
        const outPath = path.join(distDir, pattern);

        if (typeof mod.GET === "function") {
          // Endpoint — emit the GET() body verbatim via the raw write path.
          const body = await renderEndpoint(mod, makeEndpointContext("/" + pattern, siteUrl, requestOrigin));
          if (body !== null) {
            results.push({
              file: injected.entrypoint,
              label: `[injected] ${injected.pattern}`,
              outPath,
              html: body,
              raw: true,
            });
          }
        } else if (typeof mod.default === "function") {
          // Page component — render as HTML
          resetIslandRegistry();
          const ctx = makePageContext("/" + pattern, {}, { file: injected.entrypoint, segments: [], isDynamic: false, priority: 0, isEndpoint: false });
          const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
            renderComponent(mod.default, {}, ctx),
          );
          if (html !== null) {
            results.push({
              file: injected.entrypoint,
              entryFile: cssEntryOf(ctx, entrypoint),
              label: `[injected] ${injected.pattern}`,
              pageEntry: cssEntryOf(ctx, entrypoint),
              outPath,
              html,
              renderedModules,
              tsxStyles,
              partial: partialOf(ctx, Boolean(mod.partial)),
            });
          }
        }
      } catch (e) {
        console.error(`  Failed to render injected route "${injected.pattern}":`, (e as Error).message);
      }
    }
  }

  // Render custom 404 page — pass a synthetic page context so .astro
  // 404 templates that dereference Astro.url (e.g. to highlight the
  // active nav item in a shared layout) don't blow up.
  const ctx404 = makePageContext("/404", {}, {
    file: "404.astro",
    segments: [],
    isDynamic: false,
    priority: 0,
    isEndpoint: false,
  });
  const result404 = await render404Page(pagesDir, ctx404);
  if (result404) {
    const cssEntry404 = cssEntryOf(ctx404, result404.entry);
    results.push({ file: result404.file, entryFile: cssEntry404, label: result404.file, pageEntry: cssEntry404, outPath: path.join(distDir, "404.html"), html: result404.html, renderedModules: result404.renderedModules, tsxStyles: result404.tsxStyles, partial: partialOf(ctx404, result404.partial) });
  }

  // Deduplicate by output path — later entries win. The main use case
  // is i18n: when `prefixDefaultLocale: true` + `redirectToDefaultLocale: true`,
  // a non-localized root file (e.g. `src/pages/index.astro`) collides
  // with the default-locale redirect that targets the same URL. Astro
  // serves the redirect in that scenario, so we preserve the latest
  // write to match — fallback/redirect emissions are pushed last.
  const dedupedResults = Array.from(
    results
      .reduce<Map<string, PageResult>>((map, r) => map.set(r.outPath, r), new Map())
      .values(),
  );

  phase("renders + dedupe", tStatic);

  // Aggregate island + hoisted references across all routes before writing
  // CSS. Hoisted script bundling can emit CSS artifacts for JS side-effect
  // imports, and those need to be present before bundleCss() hashes the
  // final stylesheet.
  const islandNames = new Set<string>();
  const referencedHashes = new Set<string>();
  // Endpoint output is written verbatim, never inlined, so its scripts keep their file.
  const rawHashes = new Set<string>();
  for (const result of dedupedResults) {
    if (result.islands || result.hoistedHashes) {
      for (const name of result.islands ?? []) islandNames.add(name);
      for (const hash of result.hoistedHashes ?? []) referencedHashes.add(hash);
      continue;
    }
    for (const name of extractAll(result.html, ISLAND_NAME_RE)) islandNames.add(name);
    for (const hash of extractAll(result.html, HOISTED_URL_RE)) {
      referencedHashes.add(hash);
      if (result.raw) rawHashes.add(hash);
    }
  }

  let inlinedScripts = new Map<string, string>();
  if (referencedHashes.size > 0) {
    const tHoisted = performance.now();
    inlinedScripts = await bundleHoistedScripts(referencedHashes, rawHashes, assetsInlineLimit, distDir);
    phase("hoisted bundling", tHoisted);
  }

  // Bundle CSS from src/ AFTER rendering — side-effect imports of
  // `.scss` / `.sass` from components populate the scss output map
  // during page rendering, and hoisted-script CSS imports are collected
  // above, so the bundle needs to be computed here to include them.
  const tCss = performance.now();
  // Before the plan: a cached page's dynamically imported modules did not load this build.
  if (cache) {
    for (const result of dedupedResults) {
      if (result.source !== "cached" || !result.routeKey) continue;
      const entry = cache.getRoute(result.routeKey);
      if (!entry) continue;
      const nodes = entry.dynamicModules.flatMap((file) => {
        const items = cache.dynamicNode(file);
        return items ? [{ file, items }] : [];
      });
      restoreDynamicGraph(nodes, (file) => cache.virtualCss(file));
    }
  }
  const cssBundle = await bundleCss(projectRoot, config.srcDir, distDir, inlineStylesheets);
  const cssSheets = [cssBundle.shared, ...cssBundle.groups.map((group) => group.sheet)];
  const cssSheetCount = cssSheets.filter((sheet) => sheet?.type === "external").length;
  const cssInlinedCount = cssSheets.filter((sheet) => sheet?.type === "inline").length;
  phase("bundleCss", tCss);

  // Write all pages (including 404) — parallel.
  // Scoped CSS from <style> blocks is injected per-page (not into the
  // global bundle) to avoid cross-page leaks from unscoped rules like
  // `:global()` selectors or `body` styles.
  //
  // Cached pages skip writeHtml() — their HTML is already in dist, and running
  // it again would inject CSS / hydration scripts twice. Only their stylesheet
  // markup is refreshed; one that can't be swapped in place is rendered again below.
  const routeOutputs = new Set(dedupedResults.map((r) => path.relative(distDir, r.outPath)));
  if (cache) await cache.markWriting(routeOutputs);
  let totalSize = 0;
  let cachedCount = 0;
  let renderedCount = 0;
  const tWrite = performance.now();
  const writePage = async (result: PageResult): Promise<void> => {
    if (cache) await removeOtherKindOutput(result.outPath, result.raw === true);
    if (result.raw) {
      // Endpoint output — bytes as produced. writeHtml would rewrite asset
      // refs and, lacking a </head>, prepend the page <style> block.
      const size = Buffer.byteLength(result.html, "utf-8");
      await fs.mkdir(path.dirname(result.outPath), { recursive: true });
      await fs.writeFile(result.outPath, result.html);
      totalSize += size;
      renderedCount++;
      console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(size)})`);
      return;
    }
    const { size, cssHead } = await writeHtml(result.outPath, inlineHoistedScripts(result.html, inlinedScripts), base, stylesheetsForPage(cssBundle, result.pageEntry), publicManifest, pageScript, result.renderedModules, result.tsxStyles, result.entryFile, result.partial);
    totalSize += size;
    renderedCount++;
    // Now that we know the final byte count and CSS markup, patch them onto
    // the route's cache entry: the next warm build skips the stat and can
    // swap the markup.
    if (cache && result.routeKey) {
      recordWrittenOutput(cache, result.routeKey, size, cssHead);
      // After every render, so the module graph holds whatever this page imported dynamically.
      const deps = Object.keys(cache.getRoute(result.routeKey)?.depFingerprints ?? {});
      recordDynamicGraph(cache, result.routeKey, dynamicGraphOf(path.join(pagesDir, result.file), deps));
    }
    console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(size)})`);
  };
  // Cached pages whose stylesheet markup can't be swapped in place.
  const renderLate: PageResult[] = [];
  await Promise.all(
    dedupedResults.map(async (result) => {
      if (result.source !== "cached") return await writePage(result);
      if (result.cachedCssHead === undefined) throw new Error(`${result.label}: cached page has no stylesheet markup in the cache`);
      const refreshed = await refreshCachedCssHead(result.outPath, result.cachedCssHead, result.cachedSize ?? 0, base, stylesheetsForPage(cssBundle, result.pageEntry));
      if (!refreshed) {
        renderLate.push(result);
        return;
      }
      totalSize += refreshed.size;
      cachedCount++;
      if (cache && result.routeKey) {
        recordWrittenOutput(cache, result.routeKey, refreshed.size, refreshed.cssHead);
      }
      console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(refreshed.size)}) [cached]`);
    }),
  );
  // Render them again from their route now that the bundle exists, so writeHtml places the markup as a full build does.
  for (const cached of renderLate) {
    let fresh: PageResult | null;
    if (cached.params) {
      const renderSlug = dynamicSlugRenderers.get(cached.file);
      if (!renderSlug) throw new Error(`${cached.label}: no dynamic route to render it again from`);
      fresh = await renderSlug(cached.params, true);
    } else {
      const route = staticRoutes.find((r) => r.file === cached.file);
      if (!route) throw new Error(`${cached.label}: no static route to render it again from`);
      fresh = await renderStaticRoute(route, true);
    }
    if (fresh) await writePage(fresh);
  }
  phase("writeHtml all pages", tWrite);
  flushProfile("writeHtml");

  // Before integrations write: a path a removed route wrote may be theirs now.
  if (cache) {
    const tPrune = performance.now();
    await pruneStaleRouteOutputs(distDir, cache.routeOutputs() ?? [], routeOutputs, publicWritten);
    cache.setRouteOutputs(routeOutputs);
    phase("prune stale route outputs", tPrune);
  }
  clearAstroCss();
  clearCssModules();
  clearScss();
  clearJsImportedCss();

  // Process optimized images registered by <Image> / <Picture> components
  // and passthrough copies of ESM-imported images.
  const imageTransforms = getTransforms();
  let imageCount = 0;
  if (imageTransforms.size > 0 || getImportedImages().size > 0) {
    const tImg = performance.now();
    imageCount = await processImages(imageTransforms, distDir);
    clearTransforms();
    phase("processImages", tImg);
  }

  // Emit `?url`-imported assets, copied as-is under _astro/.
  const urlAssets = getUrlAssets();
  if (urlAssets.size > 0) {
    const tUrl = performance.now();
    for (const [outputPath, sourcePath] of urlAssets) {
      const outFile = path.join(distDir, outputPath);
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.copyFile(sourcePath, outFile);
    }
    clearUrlAssets();
    phase("processUrlAssets", tUrl);
  }

  const tBundle = performance.now();
  if (islandNames.size > 0) {
    await bundleIslands(islandNames, islandsDir, distDir, projectRoot);
  }
  if (astroRenderers) {
    // A page restored from the cache rendered nothing this build; its islands still need their bundles.
    for (const result of dedupedResults) {
      if (result.source === "cached" && result.astroIslands) astroRenderers.addHydratedComponents(result.astroIslands);
    }
    await bundleRenderedIslands(astroRenderers, distDir, astroRenderers.hydratedComponents());
  }
  phase("islands bundling", tBundle);
  clearHoistedScripts();

  // pletivo's own sitemap is for pletivo-native projects. An Astro project
  // gets one only from an integration (@astrojs/sitemap), as under Astro.
  if (!astroHost) {
    // Pages this build wrote, not a dist/ scan: public/ copies, asset directories
    // and an incremental build's not-yet-pruned orphans are not pages.
    const pageFiles = dedupedResults.filter((r) => !r.raw).map((r) => path.relative(distDir, r.outPath));
    await generateSitemap(distDir, base, pageFiles);
  }

  // Run Astro integration `astro:build:done` hooks. Integrations like
  // Nua CMS's build processor walk dist/ HTML files here to add markers;
  // @astrojs/sitemap writes its sitemap XMLs now that it has both the
  // captured routes and the final pages list.
  if (astroHost) {
    const tDone = performance.now();
    await astroHost.runBuildGenerated(distDir);
    const pageEntries = dedupedResults.map((r) => ({
      pathname: toPathname(r.outPath, distDir),
    }));
    const cachedRoutes =
      (astroHost as unknown as { __cachedRoutes?: import("./astro-host").AstroRoute[] }).__cachedRoutes ?? [];
    await astroHost.runBuildDone(cachedRoutes, pageEntries, distDir);
    phase("astro:build:done", tDone);
  }

  const incrementalSummary = cache
    ? `, ${renderedCount} rendered + ${cachedCount} cached`
    : "";
  const cssAssets = emittedCssAssets();
  const cssAssetSummary = cssAssets.length > 0
    ? `, ${cssAssets.length} CSS asset${cssAssets.length === 1 ? "" : "s"} (${formatSize(cssAssets.reduce((sum, a) => sum + a.bytes, 0))})`
    : "";
  console.log(`\nBuilt ${results.length} pages${incrementalSummary}${imageCount > 0 ? `, ${imageCount} images` : ""}${islandNames.size > 0 ? `, ${islandNames.size} islands` : ""}${cssSheetCount > 0 ? `, ${cssSheetCount} CSS bundle${cssSheetCount === 1 ? "" : "s"}` : ""}${cssInlinedCount > 0 ? `, ${cssInlinedCount} inlined stylesheet${cssInlinedCount === 1 ? "" : "s"}` : ""}${cssAssetSummary} (${formatSize(totalSize)} total)`);

  // Refuse to ship a build that silently dropped entries.
  // Individual errors were already logged at validation time.
  const failures = getValidationFailures();
  if (failures.length > 0) {
    const summary = failures
      .map((f) => `  - ${f.collection}/${f.id}`)
      .join("\n");
    throw new Error(
      `Build aborted: ${failures.length} content entr${failures.length === 1 ? "y" : "ies"} failed validation:\n${summary}`,
    );
  }

  // Persist the cache + snapshot the just-built dist. Only happens on
  // successful builds (we're past every throw), so the snapshot always
  // mirrors a known-good output set.
  if (cache) {
    // Prune cache entries for routes that no longer exist. Only the
    // routes that went through `runIncrementalRender` carry a routeKey;
    // i18n / 404 / injected ones don't and never had cache entries.
    const keepKeys = new Set<string>();
    for (const r of dedupedResults) {
      if (r.routeKey) keepKeys.add(r.routeKey);
    }
    cache.pruneRoutes(keepKeys);

    const tPersist = performance.now();
    await cache.persist();
    phase("cache.json persist", tPersist);
  }
  phase("TOTAL build()", tStart);
}

/**
 * Walk dist once and collect every file's path relative to `distDir`.
 * `runIncrementalRender` consults the set to verify a cached route's
 * output is still on disk — O(1) lookup instead of an `fs.access` per slug.
 */
async function collectDistFiles(distDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  await walkDist(distDir, distDir, async (rel) => {
    out.add(rel);
  });
  return out;
}

/**
 * An incremental build keeps dist/, so a route switched between page and endpoint
 * finds `api/index.html` where the file `api` goes, or the reverse. A directory
 * holding more than that `index.html` is a real route conflict, and rmdir fails.
 */
async function removeOtherKindOutput(outPath: string, raw: boolean): Promise<void> {
  if (raw) {
    const stat = await fs.stat(outPath).catch(() => null);
    if (!stat?.isDirectory()) return;
    await fs.rm(path.join(outPath, "index.html"), { force: true });
    await fs.rmdir(outPath);
    return;
  }
  const dir = path.dirname(outPath);
  const stat = await fs.stat(dir).catch(() => null);
  if (stat?.isFile()) await fs.unlink(dir);
}

/**
 * Delete what the previous build wrote for a route (page or endpoint) and this one
 * did not, then the directories that leaves empty. Everything else in dist/ is not
 * a route's: public/ copies, bundles, integration output.
 */
async function pruneStaleRouteOutputs(
  distDir: string,
  previous: string[],
  current: Set<string>,
  publicWritten: Set<string>,
): Promise<void> {
  const realDist = await fs.realpath(distDir);
  // No symlinked directory on the path: one could lead outside dist/, or onto a live output inside it.
  const parentIsReal = async (rel: string): Promise<boolean> => {
    const parent = await fs.realpath(path.join(distDir, path.dirname(rel))).catch(() => null);
    return parent === path.join(realDist, path.dirname(rel));
  };
  const removed = await Promise.all(previous.filter((rel) => !current.has(rel)).map(async (rel) => {
    // public/ copied a file to this path this build.
    if (publicWritten.has(rel.split(path.sep).join("/"))) return null;
    const abs = path.join(distDir, rel);
    if (!(await isFile(abs)) || !(await parentIsReal(rel))) return null;
    await fs.unlink(abs);
    return rel;
  }));
  const dirs = new Set<string>();
  for (const rel of removed) {
    if (rel === null) continue;
    for (let dir = path.dirname(rel); dir !== "."; dir = path.dirname(dir)) dirs.add(dir);
  }
  // Deepest first, so a parent is tried after its children; rmdir refuses a non-empty one.
  const depth = (dir: string) => dir.split(path.sep).length;
  for (const dir of [...dirs].sort((a, b) => depth(b) - depth(a))) {
    if (!(await parentIsReal(dir))) continue;
    await fs.rmdir(path.join(distDir, dir)).catch(() => {});
  }
}

async function isFile(abs: string): Promise<boolean> {
  const stat = await fs.lstat(abs).catch(() => null);
  return stat?.isFile() ?? false;
}

async function walkDist(root: string, current: string, visit: (rel: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDist(root, full, visit);
    } else if (entry.isFile()) {
      await visit(path.relative(root, full));
    }
  }));
}

async function canReuseDeps(deps: Record<string, import("./incremental/cache").DepFingerprint>): Promise<boolean> {
  const entries = Object.entries(deps);
  const checks = await Promise.all(entries.map(([f, p]) => canReuseFingerprint(f, p)));
  return checks.every(Boolean);
}

/**
 * Compute a single hash that captures every input which, if changed,
 * should invalidate ALL cached routes (vs. per-route deps). Includes:
 *   - pletivo config (selected fields)
 *   - astro/pletivo/svelte config file contents (if present)
 *   - bun.lock
 *   - tsconfig.json (path aliases, module resolution → can change which
 *     file a bare specifier resolves to without any source edit)
 *   - relevant package.json fields (dependencies / peerDependencies /
 *     optionalDependencies / type / exports / imports). We exclude
 *     scripts/devDependencies/version — those don't affect rendered
 *     output, and including them would bust the cache on every npm-i.
 *   - every .css/.scss/.sass file under srcDir (bundled into the global
 *     CSS asset whose hashed filename is baked into rendered HTML —
 *     when the bundle's filename changes, cached pages would otherwise
 *     ship a <link> to a file that no longer exists).
 */
async function computeProjectConfigHash(
  projectRoot: string,
  config: PletivoConfig,
  pageScript: string | null,
): Promise<string> {
  const parts: Array<string | Buffer> = [];
  parts.push(JSON.stringify({
    base: config.base,
    outDir: config.outDir,
    srcDir: config.srcDir,
    publicDir: config.publicDir,
    imageService: imageServiceHashValue(config),
  }));
  for (const file of [
    "astro.config.mjs",
    "astro.config.js",
    "astro.config.ts",
    "pletivo.config.ts",
    "pletivo.config.js",
    ...SVELTE_CONFIG_NAMES,
    ...CONTENT_CONFIG_CANDIDATES.map((candidate) => path.join(config.srcDir, candidate)),
    "tsconfig.json",
  ]) {
    const p = path.join(projectRoot, file);
    const h = await hashFileContent(p);
    if (h !== "__missing__") parts.push(`${file}=${h}`);
  }
  const pkgFields = await hashRelevantPackageFields(path.join(projectRoot, "package.json"));
  if (pkgFields) parts.push(`package.json=${pkgFields}`);
  const lock = await hashFileContent(path.join(projectRoot, "bun.lock"));
  if (lock !== "__missing__") parts.push(`bun.lock=${lock}`);
  const cssParts = await hashSrcCssFiles(path.join(projectRoot, config.srcDir));
  for (const p of cssParts) parts.push(p);
  if (pageScript !== null) parts.push(`pageScript=${pageScript}`);
  return await computeConfigHash(parts);
}

function imageServiceHashValue(config: PletivoConfig): string {
  const service = resolveImageServiceConfig(config);
  if (!service) return "sharp";
  if (typeof service === "string") return service;
  return service.cacheKey ?? [
    service.name,
    service.processing,
    service.supportsResponsive === true ? "responsive" : "fixed",
  ].join(":");
}

/**
 * Pick fields from package.json that can change build output, hash them
 * together, return null on parse failure. Excluding `scripts`,
 * `devDependencies`, `version`, etc. avoids busting the cache on every
 * `npm version` bump or test-script tweak.
 */
async function hashRelevantPackageFields(pkgPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const subset = {
      dependencies: pkg.dependencies ?? null,
      peerDependencies: pkg.peerDependencies ?? null,
      optionalDependencies: pkg.optionalDependencies ?? null,
      type: pkg.type ?? null,
      exports: pkg.exports ?? null,
      imports: pkg.imports ?? null,
    };
    return Bun.hash(JSON.stringify(subset)).toString(16);
  } catch {
    return null;
  }
}

/**
 * Hash every CSS-family source file under `srcDir`. Returns a sorted
 * array of `path=hash` parts so the produced configHash is stable
 * across runs regardless of FS walk order.
 */
async function hashSrcCssFiles(srcDir: string): Promise<string[]> {
  const { Glob } = await import("bun");
  const glob = new Glob("**/*.{css,scss,sass}");
  const files: string[] = [];
  try {
    for await (const f of glob.scan(srcDir)) files.push(f);
  } catch {
    return [];
  }
  files.sort();
  const parts = await Promise.all(files.map(async (f) => {
    const h = await hashFileContent(path.join(srcDir, f));
    return `css:${f}=${h}`;
  }));
  return parts;
}

/**
 * Extract scss compiler options from the Astro config's
 * `vite.css.preprocessorOptions.scss` block (the same path Astro/Vite
 * users set `silenceDeprecations`, `loadPaths`, etc.).
 */
function readScssOptions(vite: unknown): Record<string, unknown> | undefined {
  const css = (vite as { css?: { preprocessorOptions?: { scss?: unknown } } })?.css;
  const opts = css?.preprocessorOptions?.scss;
  if (opts && typeof opts === "object") return opts as Record<string, unknown>;
  return undefined;
}

/**
 * Convert a dist/ HTML path into an Astro-style `pathname` for the
 * `astro:build:done` `pages` array. Astro uses no leading slash:
 *   dist/index.html            → ""
 *   dist/about/index.html      → "about/"
 *   dist/blog/post-1/index.html → "blog/post-1/"
 */
function toPathname(outPath: string, distDir: string): string {
  const rel = path.relative(distDir, outPath);
  if (rel === "index.html") return "";
  if (rel.endsWith("/index.html")) return rel.slice(0, -"index.html".length);
  return rel;
}


/**
 * The path of the request Astro's static build renders `pathname` with (`getUrlForPath`):
 * the base for the root, else the base, the path and the format's ending.
 */
function astroRequestPath(pathname: string, base: string, trailingSlash: string | undefined, format: string | undefined): string {
  const basePath = `/${base.replace(/^\/+|\/+$/g, "")}`;
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  if (!clean) return basePath;
  const ending = format === "file" ? ".html" : trailingSlash === "never" ? "" : "/";
  return `${basePath === "/" ? "" : basePath}/${clean}${ending}`;
}

/** Collect capture group 1 of `regex` across `html`. Caller must reset lastIndex. */
function extractAll(html: string, regex: RegExp): string[] {
  const out: string[] = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(html)) !== null) {
    out.push(match[1]);
  }
  return out;
}

const ISLAND_NAME_RE = /data-component="([^"]+)"/g;

/** Shape an endpoint's `GET()` receives — mirrors Astro's APIContext for SSG. */
export interface EndpointContext {
  site: URL | undefined;
  url: URL;
  params: RouteParams;
  props: Record<string, unknown>;
  request: Request;
  redirect: (dest: string, status?: number) => Response;
}

export function makeEndpointContext(
  pathname: string,
  siteUrl: URL | undefined,
  origin: string,
  params: RouteParams = {},
  props: Record<string, unknown> = {},
): EndpointContext {
  const url = new URL(pathname.startsWith("/") ? pathname : "/" + pathname, origin);
  return {
    site: siteUrl,
    url,
    params,
    props,
    request: new Request(url),
    redirect: (dest: string, status = 302) => new Response(null, { status, headers: { Location: dest } }),
  };
}

/**
 * Call an endpoint module's `GET()` and return its body.
 * Returns null when the module exports no GET — the caller warns and skips.
 */
export async function renderEndpoint(
  mod: Record<string, unknown>,
  ctx: EndpointContext,
): Promise<string | null> {
  const handler = mod.GET;
  if (typeof handler !== "function") return null;
  const response: unknown = await handler(ctx);
  if (!(response instanceof Response)) {
    throw new Error("endpoint GET() must return a Response");
  }
  return await response.text();
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function renderComponent(
  component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  ctx: { __pageContext: PageContext },
): Promise<string | null> {
  let result = runInPage(ctx.__pageContext, () => component({ ...props, ...ctx }));
  if (result instanceof Promise) result = await result;

  if (typeof result === "string") return result;
  if (result instanceof Response) {
    // `return Astro.redirect(...)` — a static file can't send a 3xx, so emit
    // the meta-refresh page Astro's static output produces.
    if (result.headers.get("location")) return redirectPageHtml(result, ctx.__pageContext);
    // `return Astro.rewrite(...)`: the rewritten route's HTML, written at
    // this route's path.
    if ((result.headers.get("content-type") ?? "").includes("html")) {
      return await result.text();
    }
    console.warn(
      `  Page returned a ${result.status} Response that is neither a redirect nor HTML, skipping`,
    );
    return null;
  }
  if (result && typeof result === "object" && "__html" in result) {
    return (result as { __html: string }).__html;
  }
  return null;
}

async function writeHtml(
  outPath: string,
  html: string,
  base: string,
  stylesheets: Stylesheet[],
  publicManifest: Map<string, string>,
  pageScript: string | null,
  renderedModules?: Set<string>,
  tsxStyles?: string[],
  entryFile?: string,
  partial = false,
): Promise<{ size: number; cssHead: CachedCssHead | null }> {
  // Each Astro island carries its scripts; the page keeps the first of each, in document order.
  html = finalizeIslandScripts(html);
  const { getHost } = await import("./astro-host");
  const host = getHost();
  // Decided on the rendered page, prepended last: the CSS below may be prepended to a page without `<head>`.
  const doctype = pageDoctype(html, { compressHTML: resolveCompressHTML(host?.config), partial });

  // Rewrite references to hashed public assets (e.g. /style.css → /style.abc123.css).
  // Done before CSS/island injection so the injected tags (which use already-hashed
  // paths from bundleCss) are not double-rewritten.
  html = timeSync("rewriteRefs", () => rewriteRefs(html, publicManifest));

  // The page's own `.astro` <style> CSS in import-graph cascade order: scoped blocks matched by scope id
  // in the HTML, `is:global` ones by whether the component rendered. Read before any sheet is inlined,
  // since inlined CSS carries scope ids of components this page may not render.
  const pageCss = await timeAsync("pageCss", async () => {
    const pageAstroCss = await getAstroCssForPage({
      entryFile,
      astroScopes: extractAstroScopes(html),
      renderedModules: renderedModules ?? new Set(),
    });
    const pageTsxCss = tsxStyles && tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
    return [pageAstroCss, pageTsxCss].filter(Boolean).join("\n");
  });
  let cssHead: CachedCssHead | null = null;
  if (html.includes("</head>")) {
    const fragment = renderCssHead(base, stylesheets, pageCss);
    cssHead = { fragment, pageCss };
    html = html.replace("</head>", () => fragment + "</head>");
  } else if (pageCss) {
    const styleTag = `<style>${escapeStyleEnd(pageCss)}</style>`;
    if (html.includes("</body>")) {
      html = html.replace("</body>", () => styleTag + "\n</body>");
    } else {
      html = styleTag + "\n" + html;
    }
  }

  // CSS Modules — inject generated scoped CSS from .module.css imports
  const cssModulesOutput = getCssModulesOutput();
  if (cssModulesOutput) {
    const moduleStyleTag = `<style>${escapeStyleEnd(cssModulesOutput)}</style>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", () => moduleStyleTag + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", () => moduleStyleTag + "\n</body>");
    } else {
      html = moduleStyleTag + "\n" + html;
    }
  }

  // Integration-injected scripts (from `injectScript('page', code)` etc.)
  // If any integration injected head scripts, emit them into every page.
  if (host) {
    const injected = [
      ...host.injectedHeadScripts.map((s) => `<script>${s}</script>`),
      ...(pageScript === null ? [] : [`<script type="module">${pageScript}</script>`]),
    ].join("\n");
    if (injected && html.includes("</head>")) {
      html = html.replace("</head>", () => injected + "\n</head>");
    }
  }

  if (html.includes("<pletivo-island")) {
    // before-hydration scripts run before the hydration runtime
    const beforeHydration = host?.injectedBeforeHydrationScripts
      ?.map((s) => `<script type="module">${s}</script>`)
      .join("\n") ?? "";
    const hydrationBlock = (beforeHydration ? beforeHydration + "\n" : "") + hydrationScript();
    if (html.includes("</head>")) {
      html = html.replace("</head>", () => hydrationBlock + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", () => hydrationBlock + "\n</body>");
    } else {
      html += hydrationBlock;
    }
  }
  html = doctype + html;

  const bytes = Buffer.byteLength(html, "utf-8");
  await timeAsync("fsWrite", async () => {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html);
  });
  return { size: bytes, cssHead };
}

/**
 * The stylesheet markup before `</head>`: the page's sheets in cascade order,
 * then its own `.astro`/TSX CSS. Adjacent inline sheets merge into one `<style>`,
 * as Astro's `mergeInlineCss` does; Astro dedupes a sheet by href or content.
 */
function renderCssHead(base: string, stylesheets: Stylesheet[], pageCss: string): string {
  const sheets: Stylesheet[] = [];
  for (const sheet of stylesheets) {
    const duplicate = sheets.some((s) =>
      s.type === "external" && sheet.type === "external" ? s.href === sheet.href
        : s.type === "inline" && sheet.type === "inline" ? s.content === sheet.content
          : false,
    );
    if (!duplicate) sheets.push(sheet);
  }
  if (pageCss) sheets.push({ type: "inline", content: pageCss });

  const merged: Stylesheet[] = [];
  for (const sheet of sheets) {
    const last = merged.at(-1);
    if (last?.type === "inline" && sheet.type === "inline") {
      merged[merged.length - 1] = { type: "inline", content: last.content + sheet.content };
    } else {
      merged.push(sheet);
    }
  }

  let out = "";
  for (const sheet of merged) {
    out += sheet.type === "external"
      ? `<link rel="stylesheet" href="${base}${sheet.href}">\n`
      : `<style>${escapeStyleEnd(sheet.content)}</style>\n`;
  }
  return out;
}

/**
 * Swap a cached page's stylesheet markup for this build's, reading the page only when it changed. Null when it
 * can't be done in place: the page had none, which goes before later head injections, or a hook rewrote it.
 */
async function refreshCachedCssHead(
  outPath: string,
  previous: CachedCssHead | null,
  size: number,
  base: string,
  stylesheets: Stylesheet[],
): Promise<{ size: number; cssHead: CachedCssHead | null } | null> {
  // writeHtml put no stylesheet markup into a page without `</head>`.
  if (previous === null) return { size, cssHead: null };
  const fragment = renderCssHead(base, stylesheets, previous.pageCss);
  if (fragment === previous.fragment) return { size, cssHead: previous };
  if (previous.fragment === "") return null;

  let html: string;
  try {
    html = await fs.readFile(outPath, "utf8");
  } catch {
    return null;
  }
  const at = findCssHead(html, previous.fragment);
  if (!at) return null;
  const next = html.slice(0, at.start) + fragment + html.slice(at.end);
  await fs.writeFile(outPath, next);
  return { size: Buffer.byteLength(next, "utf-8"), cssHead: { fragment, pageCss: previous.pageCss } };
}

/**
 * The last match of a page's recorded stylesheet markup before `</head>`, after which come only later injections.
 * An HTML minifier in `astro:build:done` may have collapsed the whitespace between its tags, so such a run
 * matches any whitespace; everything else matches exactly.
 */
function findCssHead(html: string, fragment: string): { start: number; end: number } | null {
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) return null;
  const exact = html.lastIndexOf(fragment, headEnd - fragment.length);
  if (exact !== -1) return { start: exact, end: exact + fragment.length };

  const pattern = new RegExp(fragment.split(/(?<=>)\s+(?=<|$)/).map(escapeRegex).join("\\s*"), "g");
  let last: { start: number; end: number } | null = null;
  for (const match of html.slice(0, headEnd).matchAll(pattern)) {
    last = { start: match.index, end: match.index + match[0].length };
  }
  return last;
}

async function render404Page(
  pagesDir: string,
  pageContext: { __pageContext: PageContext },
): Promise<{ file: string; entry: string; html: string; renderedModules: Set<string>; tsxStyles: string[]; partial: boolean } | null> {
  for (const ext of [".tsx", ".jsx", ".astro"]) {
    const fullPath = path.join(pagesDir, `404${ext}`);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      const mod = await import(fullPath);
      await collectPageModuleCss(fullPath, `page:${fullPath}`);
      if (typeof mod.default === "function") {
        resetIslandRegistry();
        const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
          renderComponent(mod.default, {}, pageContext),
        );
        if (html) {
          return { file: `404${ext}`, entry: fullPath, html, renderedModules, tsxStyles, partial: Boolean(mod.partial) };
        }
      }
      break;
    }
  }
  return null;
}

const scriptScanner = new Bun.Transpiler({ loader: "js" });

/**
 * Astro inlines a processed script whose bundle imports nothing and passes the inline
 * limit (`plugin-scripts.ts`). Also kept external: code that resolves against its own
 * URL, which an inline module would resolve against the page, and code holding
 * `</script` or `<!--`, which could end the tag early or swallow its end.
 */
function inlinableScript(code: string, filePath: string, limit: AssetsInlineLimit): boolean {
  if (scriptScanner.scanImports(code).length > 0) return false;
  if (!shouldInlineAsset(code, filePath, limit)) return false;
  return !/<\/script|<!--/i.test(code) && !code.includes("import.meta");
}

/**
 * Bundles the referenced hoisted scripts; returns hash → code for those to inline.
 * An inlined script keeps its file only when an endpoint (`rawHashes`) links it.
 */
async function bundleHoistedScripts(
  referencedHashes: Set<string>,
  rawHashes: Set<string>,
  inlineLimit: AssetsInlineLimit,
  distDir: string,
): Promise<Map<string, string>> {
  const inlined = new Map<string, string>();
  const entries = getAllHoistedScripts().filter((e) => referencedHashes.has(e.hash));
  if (entries.length === 0) return inlined;

  const astroOutDir = path.join(distDir, "_astro");
  await fs.mkdir(astroOutDir, { recursive: true });

  console.log(
    `\nBundling ${entries.length} hoisted script${entries.length === 1 ? "" : "s"}...`,
  );

  await Promise.all(entries.map((entry) =>
    collectCssSideEffectImports(entry.sourceFile, entry.code, `hoisted:${entry.hash}`, {
      bundleExternalCss: false,
    })
  ));

  const result = await Bun.build({
    entrypoints: entries.map((e) => hoistedEntrypoint(e.hash)),
    outdir: astroOutDir,
    format: "esm",
    target: "browser",
    minify: true,
    plugins: [cssSideEffectBunPlugin(), hoistedScriptBunPlugin(), cssAssetBunPlugin()],
  });

  if (!result.success) {
    const logs = result.logs.map((l) => String(l)).join("\n");
    throw new Error(`Hoisted script bundling failed:\n${logs}`);
  }

  await recordBuildCssOutputs(result.outputs, "hoisted");

  // Bun derives output basenames from the entrypoint specifier
  // (`pletivo:hoisted:<hash>.js`), so rename to the public URL shape.
  // BuildArtifact.size is lazy under `outdir` — capture it before the rename.
  const outputHashRe = /pletivo:hoisted:([a-f0-9]+)\.js$/;
  for (const output of result.outputs) {
    if (output.type?.includes("text/css") || output.path.endsWith(".css")) {
      await fs.rm(output.path, { force: true });
      continue;
    }
    const m = path.basename(output.path).match(outputHashRe);
    if (!m) continue;
    const hash = m[1];
    const size = output.size;
    const finalPath = path.join(astroOutDir, `hoisted-${hash}.js`);
    const code = await output.text();
    if (inlinableScript(code, path.relative(distDir, finalPath), inlineLimit)) {
      inlined.set(hash, code.trim());
      console.log(`  hoisted-${hash} inlined (${formatSize(size)})`);
      if (!rawHashes.has(hash)) {
        await fs.rm(output.path, { force: true });
        continue;
      }
    }
    await fs.rename(output.path, finalPath);
    console.log(`  _astro/hoisted-${hash}.js (${formatSize(size)})`);
  }
  return inlined;
}

async function bundleIslands(
  islandNames: Set<string>,
  islandsDir: string,
  distDir: string,
  projectRoot?: string,
) {
  const islandOutDir = path.join(distDir, "_islands");
  await fs.mkdir(islandOutDir, { recursive: true });

  const tmpDir = path.join(distDir, "_islands_tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  const entrypoints: string[] = [];
  for (const name of islandNames) {
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
    await fs.writeFile(wrapperPath, islandWrapperSource(sourcePath));
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
    plugins: [islandPlugin(projectRoot)],
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

/**
 * Resolve an injected route entrypoint to an absolute file path.
 * Handles relative paths (./src/...) and bare specifiers (packages).
 */
async function resolveEntrypoint(entrypoint: string, projectRoot: string): Promise<string> {
  if (entrypoint.startsWith(".") || entrypoint.startsWith("/")) {
    const abs = path.resolve(projectRoot, entrypoint);
    // Try with common extensions if not already specified
    if (path.extname(abs)) return abs;
    for (const ext of [".ts", ".js", ".tsx", ".jsx", ".astro"]) {
      const candidate = abs + ext;
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
    return abs;
  }
  // Bare specifier — resolve via Node/Bun module resolution
  return require.resolve(entrypoint, { paths: [projectRoot] });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
