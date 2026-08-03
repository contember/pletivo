import path from "path";
import fs from "fs/promises";
import { scanRoutes, matchRoute, routeToOutputPath, type Route, type RouteParams, type StaticPath } from "./router";
import { createPaginate } from "./paginate";
import { initCollections, getValidationFailures } from "./content/collection";
import { resetIslandRegistry } from "./runtime/island";
import { runWithRenderTracking, redirectPageHtml, AstroCookies, MAX_REWRITE_DEPTH, type AstroResponse } from "./runtime/astro-shim";
import { hydrationScript } from "./runtime/hydration";
import { bundleCss } from "./css";
import { hashPublicAssets, copyPublicAssets, rewriteRefs } from "./assets";
import { islandPlugin, islandWrapperSource } from "./islands-bundle";
import { generateSitemap } from "./sitemap";
import { registerAstroPlugin, getScopedCssForPage, extractAstroClasses, clearScopedCss, getGlobalCssForPage, clearGlobalCss, getAllHoistedScripts, clearHoistedScripts, hoistedScriptBunPlugin, hoistedEntrypoint, HOISTED_URL_RE } from "./astro-plugin";
import { parseMarkdown, configureMarkdown, resolveMarkdownOptions } from "./content/markdown";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { initAstroHost, buildAstroRoutes, type PletivoRouteWithPaths } from "./astro-host";
import { resolveI18nConfig } from "./i18n/config";
import { detectRouteLocale } from "./i18n/route-expansion";
import { setI18nRuntimeState } from "./i18n/virtual-module";
import { generateFallbackEmissions, type FallbackEmission } from "./i18n/fallback";
import { setImageMode, setImageService, setSharpResolveBase, clearTransforms, getTransforms, getImportedImages, processImages } from "./image";
import { setUrlAssetMode, getUrlAssets, clearUrlAssets } from "./url-asset";
import { setBase } from "./base";
import { registerCssModulesPlugin, getCssModulesOutput, clearCssModules } from "./css-modules";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import { clearJsImportedCss, collectCssSideEffectImports, collectPageModuleCss, configureJsImportedCss, cssSideEffectBunPlugin, recordBuildCssOutputs } from "./js-imported-css";
import { resolveImageServiceConfig, type PletivoConfig } from "./config";
import { CacheStore, canReuseFingerprint, computeConfigHash, fingerprintFile, hashFileContent } from "./incremental/cache";
import { configureImportGraph, collectStaticDeps, isWalkableSourceFile } from "./incremental/import-graph";
import { configureDepTracker, runWithRuntimeDepCapture, recordRuntimeDep } from "./incremental/dep-tracker";
import { recordRenderedSize, resolveFragmentsHelper, runIncrementalRender, type FragmentsHelper, type RenderProducts, type RenderSource } from "./incremental/orchestrator";
import { extractEntryFilePaths } from "./incremental/extract-deps";
import { phase, timeSync, timeAsync, flushProfile } from "./profile";

interface PageResult {
  file: string;
  label: string;
  outPath: string;
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
  /**
   * Persisted byte size, populated only for cached pages (where the
   * orchestrator pulls it from the cache entry — no stat needed).
   * Fresh renders learn their size during writeHtml and record it
   * back via `recordRenderedSize`.
   */
  cachedSize?: number;
  /**
   * Emit `html` byte-for-byte, skipping writeHtml's HTML pipeline.
   * Endpoint routes and injected endpoints produce JSON/XML/text, which
   * asset-ref rewriting and CSS/hydration injection would corrupt — a page
   * with no `</head>` gets the `<style>` block prepended to its body.
   */
  raw?: boolean;
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
   * Wipe `node_modules/.pletivo/cache/` and the prior dist snapshot,
   * then build incrementally from a clean slate. Implies `incremental`.
   * Equivalent to deleting `node_modules/.pletivo/cache/` before running.
   */
  clean?: boolean;
}

export async function build(projectRoot: string, config: PletivoConfig, options: BuildOptions = {}) {
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
  await registerCssModulesPlugin();
  await registerScssPlugin(projectRoot);
  const astroHost = await initAstroHost(projectRoot, "build");
  configureMdx(resolveMdxOptions(config, astroHost?.config));
  configureMarkdown(resolveMarkdownOptions(astroHost?.config));
  configureScss(readScssOptions(astroHost?.config.vite));
  clearJsImportedCss();
  phase("plugins+astroHost", tPlugins);
  const tColl = performance.now();
  await initCollections(projectRoot);
  phase("initCollections", tColl);

  // Cache + snapshot restore. `configHash` includes the pletivo config
  // and (if present) the user's astro config file content + lockfile —
  // any of those changing busts the entire route cache.
  const tCacheLoad = performance.now();
  const configHash = await computeProjectConfigHash(projectRoot, config);
  // Incremental is opt-in: a plain build is a full rebuild. `clean`
  // implies incremental — you only wipe the cache to rebuild it fresh.
  const incremental = options.incremental || options.clean;
  const cache: CacheStore | null = !incremental
    ? null
    : options.clean
      ? await CacheStore.forceClean(projectRoot, configHash)
      : await CacheStore.load(projectRoot, configHash);
  const fragments: FragmentsHelper | null = await resolveFragmentsHelper();
  phase("cache load + fragments resolve", tCacheLoad);

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

  // Persistent dist when incremental is on: we leave whatever the
  // previous build produced in place, and each route's writeHtml call
  // (for routes that actually re-render) overwrites the corresponding
  // file. Cached routes' HTML is already on disk and untouched.
  // Orphans (outputs of routes that no longer exist) are pruned at
  // the end of the build.
  //
  // With caching off we still wipe — that path matches the historical
  // pletivo behavior exactly so tooling that diffs dist/ across runs
  // keeps working.
  phase("astroHost runBuildStart+Setup", tAstroStart);
  const tDistWipe = performance.now();
  if (!cache) {
    await fs.rm(distDir, { recursive: true, force: true });
  }
  await fs.mkdir(distDir, { recursive: true });
  // Snapshot the current dist filesystem once — runIncrementalRender
  // queries this Set instead of doing per-slug fs.access calls when
  // deciding whether a cached entry's output file is still on disk.
  // O(1) set lookups vs O(n) sequential stats.
  const distFiles = cache ? await collectDistFiles(distDir) : new Set<string>();
  phase("dist prep", tDistWipe);

  // Copy public/ into dist/, hashing assets on the way.
  // Returns a manifest of original → hashed paths, used below to rewrite
  // references inside rendered HTML.
  const tPublic = performance.now();
  const publicManifest = config.hashAssets === false
    ? await copyPublicAssets(publicDir, distDir)
    : await hashPublicAssets(publicDir, distDir);
  phase("hashPublicAssets", tPublic);

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
   * Backs `Astro.rewrite` during a build: re-runs routing for `target` and
   * renders that route's component, so its HTML gets written at the
   * rewriting route's path. `depth` guards against rewrite cycles.
   */
  async function resolveRewrite(
    target: string,
    depth: number,
  ): Promise<Response | null> {
    if (depth > MAX_REWRITE_DEPTH) {
      throw new Error(
        `Astro.rewrite("${target}") exceeded ${MAX_REWRITE_DEPTH} hops — cycle?`,
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
      // Markdown pages have no module to import — same special case the
      // main render loop makes.
      if (route.file.endsWith(".md")) {
        return htmlResponse(await renderMarkdownFile(fullPath));
      }
      const mod = await import(fullPath);
      if (typeof mod.default !== "function") continue;
      // A dynamic target still needs its getStaticPaths props, or the
      // rewritten page renders with params but no data.
      let props: Record<string, unknown> = {};
      if (route.isDynamic && typeof mod.getStaticPaths === "function") {
        const paginate = createPaginate(route, base || "/");
        const paths = (await mod.getStaticPaths({ paginate })) as StaticPath[];
        const match = paths.find((sp) =>
          Object.entries(params).every(([k, v]) => String(sp.params[k]) === v),
        );
        if (!match) continue;
        props = match.props || {};
      }
      const html = await renderComponent(mod.default, {
        ...props,
        ...makePageContext(
          routePath,
          params as Record<string, string>,
          route,
          undefined,
          depth + 1,
        ),
      });
      if (html === null) continue;
      return htmlResponse(html);
    }
    return null;
  }

  function makePageContext(
    pathname: string,
    params: Record<string, string>,
    route: Route,
    localeOverride?: string,
    rewriteDepth = 0,
  ) {
    // Astro expects `Astro.url` to be a real URL with pathname + origin.
    // Use the configured site origin if present, else a localhost stand-in.
    const origin = siteUrl ? siteUrl.origin : "http://localhost/";
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
    return {
      __pageContext: {
        url: new URL(urlPath, origin),
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
        rewrite: (target: string) => resolveRewrite(target, rewriteDepth),
        // No request during a build, so `Astro.clientAddress` throws if read.
      },
    };
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
  const dynamicMods = new Map<string, { default?: unknown; getStaticPaths?: (ctx: unknown) => Promise<StaticPath[]> }>();
  const dynamicStaticPathsCache = new Map<string, Promise<StaticPath[]>>();
  const dynamicRouteCacheable = new Map<string, () => Promise<void>>();
  async function importDynamicRouteModule(fullPath: string): Promise<{ default?: unknown; getStaticPaths?: (ctx: unknown) => Promise<StaticPath[]> }> {
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
      if (typeof mod.default !== "function") return null;
      if (typeof mod.getStaticPaths !== "function") return null;
      const paginate = createPaginate(route, base || "/");
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
        mod = (await import(fullPath)) as typeof mod;
        dynamicMods.set(routeFile, mod);
      }
      if (typeof mod.getStaticPaths !== "function") return [] as StaticPath[];
      const paginate = createPaginate(route, base || "/");
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
    const astroRoutes = buildAstroRoutes(pletivoRoutes, astroHost.config, astroHost.injectedRoutes);
    await astroHost.runRoutesResolved(astroRoutes);
    // Stash for build:done below so we don't rebuild the array
    (astroHost as unknown as { __cachedRoutes?: unknown }).__cachedRoutes = astroRoutes;
  }
  phase("astro:routes:resolved", tRoutesResolved);

  const results: PageResult[] = [];

  // Static pages — parallel
  const tStatic = performance.now();
  const staticResults = await Promise.all(
    staticRoutes.map(async (route): Promise<PageResult | null> => {
      const fullPath = path.join(pagesDir, route.file);
      const outFile = routeToOutputPath(route, {});
      const outPath = path.join(distDir, outFile);
      const routeKey = `${route.file}::__static__`;

      // Markdown pages — render directly without module import.
      // Single-file deps make them cheap; we still gate via the cache
      // so an unchanged .md doesn't re-emit its HTML file.
      if (route.file.endsWith(".md")) {
        const outcome = await runIncrementalRender({
          routeKey,
          outFile,
          pageEntryAbsPath: fullPath,
          distDir,
          cache,
          fragments,
          distFiles,
          doRender: async () => ({
            html: await renderMarkdownFile(fullPath),
            renderedModules: new Set<string>(),
            tsxStyles: [],
          }),
        });
        return { file: route.file, label: route.file, outPath, html: outcome.html, renderedModules: outcome.renderedModules, tsxStyles: outcome.tsxStyles, source: outcome.source, routeKey, islands: outcome.islands, hoistedHashes: outcome.hoistedHashes, cachedSize: outcome.size };
      }

      const mod = await import(fullPath);
      // Collect CSS side-effect imports from non-.astro page modules. Runs
      // unconditionally (even for cached pages) so the global stylesheet
      // stays complete — mirrors the astro plugin's onLoad collection.
      await collectPageModuleCss(fullPath, `page:${route.file}`);

      // Endpoint routes (robots.txt.ts, rss.xml.ts) emit their GET() body
      // verbatim. Not incrementally cached: the cache layer is HTML-shaped,
      // and endpoints are a handful of cheap routes per project.
      if (route.isEndpoint) {
        const siteUrl = astroHost?.config.site ? new URL(astroHost.config.site) : undefined;
        const body = await renderEndpoint(mod, makeEndpointContext("/" + outFile, siteUrl));
        if (body === null) {
          console.warn(`  Skipping ${route.file}: endpoint route without an exported GET()`);
          return null;
        }
        return { file: route.file, label: route.file, outPath, html: body, raw: true };
      }

      if (typeof mod.default !== "function") {
        console.warn(`  Skipping ${route.file}: no default export function`);
        return null;
      }
      const pathname = toPathname(outPath, distDir);
      const outcome = await runIncrementalRender({
        routeKey,
        outFile,
        pageEntryAbsPath: fullPath,
        distDir,
        cache,
        fragments,
        distFiles,
        doRender: async () => {
          resetIslandRegistry();
          const ctx = makePageContext(pathname, {}, route);
          const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
            renderComponent(mod.default, ctx),
          );
          warnDroppedSsrWrites(route.file, ctx, mod);
          return { html: html ?? "", renderedModules, tsxStyles };
        },
      });
      if (outcome.source === "rendered" && outcome.html === "") {
        console.warn(`  Skipping ${route.file}: default export didn't return HTML`);
        return null;
      }
      return { file: route.file, label: route.file, outPath, html: outcome.html, renderedModules: outcome.renderedModules, tsxStyles: outcome.tsxStyles, source: outcome.source, routeKey, islands: outcome.islands, hoistedHashes: outcome.hoistedHashes, cachedSize: outcome.size };
    }),
  );
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
  for (const route of dynamicRoutes) {
    // Dynamic endpoints (`[slug].json.ts`) are not supported. Say so loudly —
    // silently emitting nothing is how a broken deploy ships green.
    if (route.isEndpoint) {
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
    let modPromise: Promise<{ default?: unknown }> | null = null;
    const getMod = (): Promise<{ default?: unknown }> => {
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
    for (const { params } of paramSets) {
      const outFile = routeToOutputPath(route, params);
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
            renderComponent(mod.default as (props: Record<string, unknown>) => unknown, { ...(pathProps || {}), ...ctx }),
          );
          // Keyed by route file, not by slug — one warning per route is the
          // signal; repeating it per slug is noise.
          warnDroppedSsrWrites(route.file, ctx, mod as Record<string, unknown>);
          return { html: html ?? "", renderedModules, tsxStyles };
        },
      });
      if (outcome.source === "rendered" && outcome.html === "") continue;

      const label = `${route.file} [${Object.values(params).join("/")}]`;
      results.push({ file: route.file, label, outPath, html: outcome.html, renderedModules: outcome.renderedModules, tsxStyles: outcome.tsxStyles, source: outcome.source, routeKey, islands: outcome.islands, hoistedHashes: outcome.hoistedHashes, cachedSize: outcome.size });
    }
  }
  phase("dynamic routes", tDynamic);

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
      const outFile = pathnameToOutputPath(emission.targetPathname);
      const outPath = path.join(distDir, outFile);
      const label = `[i18n ${emission.mode}] ${emission.targetPathname}`;

      if (emission.mode === "redirect") {
        const html = redirectHtml(emission.redirectTo ?? "/");
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
        renderComponent(mod.default, {
          ...(emission.sourceProps || {}),
          ...ctx,
        }),
      );
      if (html === null) continue;
      results.push({
        file: emission.sourceRoute.file,
        label,
        outPath,
        html,
        renderedModules,
        tsxStyles,
      });
    }
  }

  // Render injected routes from integrations (injectRoute during config:setup).
  // Endpoints export GET() returning a Response; pages export a default component.
  if (astroHost && astroHost.injectedRoutes.length > 0) {
    for (const injected of astroHost.injectedRoutes) {
      try {
        const entrypoint = await resolveEntrypoint(injected.entrypoint, projectRoot);
        const mod = await import(entrypoint);
        const pattern = injected.pattern.replace(/^\//, "");
        const outPath = path.join(distDir, pattern);

        if (typeof mod.GET === "function") {
          // Endpoint — emit the GET() body verbatim via the raw write path.
          const siteUrl = astroHost.config.site ? new URL(astroHost.config.site) : undefined;
          const body = await renderEndpoint(mod, makeEndpointContext("/" + pattern, siteUrl));
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
          const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
            renderComponent(mod.default, makePageContext("/" + pattern, {}, { file: injected.entrypoint, segments: [], isDynamic: false, priority: 0, isEndpoint: false })),
          );
          if (html !== null) {
            results.push({
              file: injected.entrypoint,
              label: `[injected] ${injected.pattern}`,
              outPath,
              html,
              renderedModules,
              tsxStyles,
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
  const result404 = await render404Page(
    pagesDir,
    makePageContext("/404", {}, {
      file: "404.astro",
      segments: [],
      isDynamic: false,
      priority: 0,
      isEndpoint: false,
    }),
  );
  if (result404) {
    results.push({ file: result404.file, label: result404.file, outPath: path.join(distDir, "404.html"), html: result404.html, renderedModules: result404.renderedModules, tsxStyles: result404.tsxStyles });
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
  for (const result of dedupedResults) {
    if (result.islands || result.hoistedHashes) {
      for (const name of result.islands ?? []) islandNames.add(name);
      for (const hash of result.hoistedHashes ?? []) referencedHashes.add(hash);
      continue;
    }
    for (const name of extractAll(result.html, ISLAND_NAME_RE)) islandNames.add(name);
    for (const hash of extractAll(result.html, HOISTED_URL_RE)) referencedHashes.add(hash);
  }

  if (referencedHashes.size > 0) {
    const tHoisted = performance.now();
    await bundleHoistedScripts(referencedHashes, distDir);
    phase("hoisted bundling", tHoisted);
  }

  // Bundle CSS from src/ AFTER rendering — side-effect imports of
  // `.scss` / `.sass` from components populate the scss output map
  // during page rendering, and hoisted-script CSS imports are collected
  // above, so the bundle needs to be computed here to include them.
  const tCss = performance.now();
  const cssPath = await bundleCss(projectRoot, config.srcDir, distDir);
  phase("bundleCss", tCss);

  // Write all pages (including 404) — parallel.
  // Scoped CSS from <style> blocks is injected per-page (not into the
  // global bundle) to avoid cross-page leaks from unscoped rules like
  // `:global()` selectors or `body` styles.
  //
  // Cached pages skip writeHtml() entirely — their fully-processed HTML
  // is already on disk in dist (restored from the prior snapshot at
  // the top of build()). Re-running writeHtml on them would inject CSS
  // / hydration scripts a second time. We still account for their
  // file size in the summary and pass their HTML downstream to the
  // island/hoisted-script scanners.
  let totalSize = 0;
  let cachedCount = 0;
  let renderedCount = 0;
  const tWrite = performance.now();
  await Promise.all(
    dedupedResults.map(async (result) => {
      if (result.source === "cached") {
        const size = await refreshCachedHtmlCssLink(result.outPath, base, cssPath);
        totalSize += size;
        cachedCount++;
        if (cache && result.routeKey) {
          recordRenderedSize(cache, result.routeKey, size);
        }
        console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(size)}) [cached]`);
        return;
      }
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
      const size = await writeHtml(result.outPath, result.html, base, cssPath, publicManifest, result.renderedModules, result.tsxStyles);
      totalSize += size;
      renderedCount++;
      // Now that we know the final byte count, patch it onto the
      // route's cache entry so the next warm build can skip the stat.
      if (cache && result.routeKey) {
        recordRenderedSize(cache, result.routeKey, size);
      }
      console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(size)})`);
    }),
  );
  phase("writeHtml all pages", tWrite);
  flushProfile("writeHtml");
  clearScopedCss();
  clearGlobalCss();
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
  phase("islands bundling", tBundle);
  clearHoistedScripts();

  // Generate sitemap — skip if the user's Astro config includes a
  // sitemap integration. Both can technically coexist (different
  // filenames), but users who opted into the Astro one explicitly
  // probably don't also want pletivo's simpler fallback.
  const hasAstroSitemap = astroHost?.hasIntegration("@astrojs/sitemap") ?? false;
  if (!hasAstroSitemap) {
    await generateSitemap(distDir, base);
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
  console.log(`\nBuilt ${results.length} pages${incrementalSummary}${imageCount > 0 ? `, ${imageCount} images` : ""}${islandNames.size > 0 ? `, ${islandNames.size} islands` : ""}${cssPath ? ", 1 CSS bundle" : ""} (${formatSize(totalSize)} total)`);

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

    // Prune dist files that no longer belong to any current route.
    // Walk every cache entry's `outPath` to build the keep set, then
    // walk dist/<page-paths> and delete strays. We intentionally don't
    // touch `_astro/`, `_islands/`, `_fragments/` here — those have
    // their own ownership models (content-hashed bundles, integration-
    // owned fragments) and aren't 1:1 with routes.
    const tPrune = performance.now();
    const keepOutputs = new Set<string>();
    for (const r of dedupedResults) {
      keepOutputs.add(path.relative(distDir, r.outPath));
    }
    // For the prune we also need entries written during this build
    // (fresh renders) — combine the start-of-build inventory with the
    // freshly-emitted outputs.
    const seenFiles = new Set(distFiles);
    for (const r of dedupedResults) seenFiles.add(path.relative(distDir, r.outPath));
    await pruneOrphanPageFiles(distDir, seenFiles, keepOutputs);
    phase("prune dist orphans", tPrune);

    const tPersist = performance.now();
    await cache.persist();
    phase("cache.json persist", tPersist);
  }
  phase("TOTAL build()", tStart);
}

/**
 * Walk dist once and collect every file's path relative to `distDir`.
 * Used for two things:
 *   1. `runIncrementalRender` consults the set to verify a cached
 *      route's output is still on disk — O(1) lookup instead of an
 *      `fs.access` per slug.
 *   2. The end-of-build prune diffs the same set against the kept
 *      route outputs to find orphans, so we don't have to walk dist
 *      twice in one build.
 */
async function collectDistFiles(distDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  await walkDist(distDir, distDir, async (rel) => {
    out.add(rel);
  });
  return out;
}

async function pruneOrphanPageFiles(distDir: string, distFiles: Set<string>, keep: Set<string>): Promise<void> {
  // Scan the inventory we already collected at build start. Anything
  // not in `keep` is a leftover from a previous build (route deleted,
  // slug removed, i18n locale dropped) and should be cleaned up.
  // Skip the reserved astro/pletivo output directories — those have
  // their own ownership models.
  await Promise.all([...distFiles].map(async (rel) => {
    if (!rel.endsWith(".html")) return;
    if (rel.startsWith("_astro/") || rel.startsWith("_islands/") || rel.startsWith("_fragments/")) return;
    if (keep.has(rel)) return;
    try {
      await fs.unlink(path.join(distDir, rel));
    } catch {}
  }));
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

function paramsToKey(params: Record<string, string | undefined>): string {
  const sorted = Object.keys(params).sort();
  return sorted.map((k) => `${k}=${params[k] ?? ""}`).join("&");
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
 *   - astro/pletivo config file contents (if present)
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
async function computeProjectConfigHash(projectRoot: string, config: PletivoConfig): Promise<string> {
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
    "src/content.config.ts",
    "src/content.config.mts",
    "src/content.config.mjs",
    "src/content.config.js",
    "src/content/config.ts",
    "src/content/config.mts",
    "src/content/config.mjs",
    "src/content/config.js",
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
 * Convert an i18n-synthesized URL pathname (e.g. `"it/blog/hello"`)
 * into the `dist/`-relative file path under pletivo's directory
 * output format (always `<segments>/index.html`, or just `index.html`
 * for the empty string).
 */
function pathnameToOutputPath(pathname: string): string {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  if (!clean) return "index.html";
  return path.posix.join(clean, "index.html");
}

/**
 * Build the static HTML document for a meta-refresh redirect. Uses
 * both an HTTP-equiv refresh header (works without JS) and a
 * canonical link so crawlers see it as a redirect. Matches the
 * shape Astro emits for its own i18n redirect pages.
 */
function redirectHtml(destination: string): string {
  const safe = destination.replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><link rel="canonical" href="${safe}"></head><body></body></html>`;
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
  params: RouteParams = {},
  props: Record<string, unknown> = {},
): EndpointContext {
  const origin = siteUrl ? siteUrl.origin : "http://localhost/";
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

/** Render a `.md` page — no module to import, so the main render loop and
 * `Astro.rewrite` both go through here. */
async function renderMarkdownFile(fullPath: string): Promise<string> {
  const source = await Bun.file(fullPath).text();
  const { html: body, frontmatter } = await parseMarkdown(source);
  const title = (frontmatter.title as string) || "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>`;
}

async function renderComponent(
  component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
): Promise<string | null> {
  let result = component(props);
  if (result instanceof Promise) result = await result;

  if (typeof result === "string") return result;
  if (result instanceof Response) {
    // `return Astro.redirect(...)` — a static file can't send a 3xx, so emit
    // the meta-refresh page Astro's static output produces.
    if (result.headers.get("location")) return redirectPageHtml(result);
    // `return Astro.rewrite(...)` — the rewritten route's HTML, written at
    // this route's path.
    if ((result.headers.get("content-type") ?? "").includes("html")) {
      return await result.text();
    }
    console.warn(
      `  Page returned a ${result.status} Response that is neither a redirect nor HTML — skipping`,
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
  cssPath: string | null,
  publicManifest: Map<string, string>,
  renderedModules?: Set<string>,
  tsxStyles?: string[],
): Promise<number> {
  if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
    html = "<!DOCTYPE html>\n" + html;
  }

  // Rewrite references to hashed public assets (e.g. /style.css → /style.abc123.css).
  // Done before CSS/island injection so the injected tags (which use already-hashed
  // paths from bundleCss) are not double-rewritten.
  html = timeSync("rewriteRefs", () => rewriteRefs(html, publicManifest));

  if (cssPath && html.includes("</head>")) {
    html = html.replace("</head>", `<link rel="stylesheet" href="${base}${cssPath}">\n</head>`);
  }

  // Inject per-page CSS from <style> blocks in .astro components:
  //   - scoped blocks: matched by astro scope class in the HTML,
  //     avoiding cross-page leaks from unscoped rules inside a
  //     regular <style> (`:global()`, `body`, etc.).
  //   - `is:global` blocks: gated by whether the component was actually
  //     rendered on this page (the scope class may be absent from the
  //     DOM when a component emits only global styles).
  const combinedCss = timeSync("pageCss", () => {
    const astroClasses = extractAstroClasses(html);
    const pageScopedCss = getScopedCssForPage(astroClasses);
    const pageGlobalCss = renderedModules ? getGlobalCssForPage(renderedModules) : "";
    const pageTsxCss = tsxStyles && tsxStyles.length > 0 ? tsxStyles.join("\n") : "";
    return [pageGlobalCss, pageScopedCss, pageTsxCss].filter(Boolean).join("\n");
  });
  if (combinedCss) {
    const styleTag = `<style>${combinedCss}</style>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", styleTag + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", styleTag + "\n</body>");
    } else {
      html = styleTag + "\n" + html;
    }
  }

  // CSS Modules — inject generated scoped CSS from .module.css imports
  const cssModulesOutput = getCssModulesOutput();
  if (cssModulesOutput) {
    const moduleStyleTag = `<style>${cssModulesOutput}</style>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", moduleStyleTag + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", moduleStyleTag + "\n</body>");
    } else {
      html = moduleStyleTag + "\n" + html;
    }
  }

  // Integration-injected scripts (from `injectScript('page', code)` etc.)
  // If any integration injected head scripts, emit them into every page.
  const { getHost } = await import("./astro-host");
  const host = getHost();
  if (host) {
    const injected = [
      ...host.injectedHeadScripts.map((s) => `<script>${s}</script>`),
      ...host.injectedPageScripts.map((s) => `<script type="module">${s}</script>`),
    ].join("\n");
    if (injected && html.includes("</head>")) {
      html = html.replace("</head>", injected + "\n</head>");
    }
  }

  if (html.includes("<pletivo-island")) {
    // before-hydration scripts run before the hydration runtime
    const beforeHydration = host?.injectedBeforeHydrationScripts
      ?.map((s) => `<script type="module">${s}</script>`)
      .join("\n") ?? "";
    const hydrationBlock = (beforeHydration ? beforeHydration + "\n" : "") + hydrationScript();
    if (html.includes("</head>")) {
      html = html.replace("</head>", hydrationBlock + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", hydrationBlock + "\n</body>");
    } else {
      html += hydrationBlock;
    }
  }

  const bytes = Buffer.byteLength(html, "utf-8");
  await timeAsync("fsWrite", async () => {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html);
  });
  return bytes;
}

async function refreshCachedHtmlCssLink(
  outPath: string,
  base: string,
  cssPath: string | null,
): Promise<number> {
  let html: string;
  try {
    html = await fs.readFile(outPath, "utf8");
  } catch {
    return 0;
  }

  const stylesheetRe = /<link rel="stylesheet" href="[^"]*\/assets\/styles\.[a-f0-9]+\.css">\n?/g;
  const nextLink = cssPath ? `<link rel="stylesheet" href="${base}${cssPath}">\n` : "";
  let next = html.replace(stylesheetRe, nextLink);

  if (cssPath && next === html && html.includes("</head>")) {
    next = html.replace("</head>", nextLink + "</head>");
  }

  if (next !== html) {
    await fs.writeFile(outPath, next);
  }

  return Buffer.byteLength(next, "utf-8");
}

async function render404Page(
  pagesDir: string,
  pageContext: Record<string, unknown>,
): Promise<{ file: string; html: string; renderedModules: Set<string>; tsxStyles: string[] } | null> {
  for (const ext of [".tsx", ".jsx", ".astro"]) {
    const fullPath = path.join(pagesDir, `404${ext}`);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      const mod = await import(fullPath);
      if (typeof mod.default === "function") {
        resetIslandRegistry();
        const { value: html, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
          renderComponent(mod.default, pageContext),
        );
        if (html) {
          return { file: `404${ext}`, html, renderedModules, tsxStyles };
        }
      }
      break;
    }
  }
  return null;
}

async function bundleHoistedScripts(
  referencedHashes: Set<string>,
  distDir: string,
) {
  const entries = getAllHoistedScripts().filter((e) => referencedHashes.has(e.hash));
  if (entries.length === 0) return;

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
    plugins: [cssSideEffectBunPlugin(), hoistedScriptBunPlugin()],
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
    await fs.rename(output.path, finalPath);
    console.log(`  _astro/hoisted-${hash}.js (${formatSize(size)})`);
  }
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
