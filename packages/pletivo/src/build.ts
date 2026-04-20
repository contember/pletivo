import path from "path";
import fs from "fs/promises";
import { scanRoutes, routeToOutputPath, type Route, type StaticPath } from "./router";
import { createPaginate } from "./paginate";
import { initCollections } from "./content/collection";
import { resetIslandRegistry } from "./runtime/island";
import { runWithRenderTracking } from "./runtime/astro-shim";
import { hydrationScript } from "./runtime/hydration";
import { bundleCss } from "./css";
import { hashPublicAssets, rewriteRefs } from "./assets";
import { generateSitemap } from "./sitemap";
import { registerAstroPlugin, getScopedCssForPage, extractAstroClasses, clearScopedCss, getGlobalCssForPage, clearGlobalCss } from "./astro-plugin";
import { parseMarkdown } from "./content/markdown";
import { registerMdxPlugin, configureMdx, resolveMdxOptions } from "./mdx-plugin";
import { initAstroHost, buildAstroRoutes, type PletivoRouteWithPaths } from "./astro-host";
import { resolveI18nConfig } from "./i18n/config";
import { detectRouteLocale } from "./i18n/route-expansion";
import { setI18nRuntimeState } from "./i18n/virtual-module";
import { generateFallbackEmissions, type FallbackEmission } from "./i18n/fallback";
import { setImageMode, clearTransforms, getTransforms, getImportedImages, processImages } from "./image";
import { registerCssModulesPlugin, getCssModulesOutput, clearCssModules } from "./css-modules";
import { registerScssPlugin, configureScss, clearScss } from "./scss";
import type { PletivoConfig } from "./config";

interface PageResult {
  file: string;
  label: string;
  outPath: string;
  html: string;
  /**
   * Component module ids (as passed to `$$createComponent`) whose
   * render function executed during this page's render pass. Used to
   * emit `<style is:global>` CSS for components present on the page —
   * the class-presence heuristic doesn't catch components that only
   * declare global styles and render no scoped DOM.
   */
  renderedModules?: Set<string>;
}

export async function build(projectRoot: string, config: PletivoConfig) {
  const pagesDir = path.join(projectRoot, config.srcDir, "pages");
  const distDir = path.join(projectRoot, config.outDir);
  const publicDir = path.join(projectRoot, config.publicDir);
  const islandsDir = path.join(projectRoot, config.srcDir, "islands");
  const base = config.base.replace(/\/$/, "");

  await registerAstroPlugin();
  await registerMdxPlugin();
  await registerCssModulesPlugin();
  await registerScssPlugin(projectRoot);
  const astroHost = await initAstroHost(projectRoot, "build");
  configureMdx(resolveMdxOptions(config, astroHost?.config));
  configureScss(readScssOptions(astroHost?.config.vite));
  await initCollections(projectRoot);

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

  // Clean dist
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // Copy public/ into dist/, hashing assets on the way.
  // Returns a manifest of original → hashed paths, used below to rewrite
  // references inside rendered HTML.
  const publicManifest = await hashPublicAssets(publicDir, distDir);

  // Scan routes
  const routes = await scanRoutes(pagesDir);
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
  setImageMode("build", base);
  clearTransforms();

  function makePageContext(
    pathname: string,
    params: Record<string, string>,
    route: Route,
    localeOverride?: string,
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
      },
    };
  }

  // Pre-resolve each dynamic route's getStaticPaths once — the result is
  // reused by both `astro:routes:resolved` (for sitemap et al.) and the
  // render loop below, avoiding a double-fetch.
  const dynamicPaths = new Map<string, StaticPath[]>();
  for (const route of dynamicRoutes) {
    const fullPath = path.join(pagesDir, route.file);
    const mod = await import(fullPath);
    if (typeof mod.default !== "function") continue;
    if (typeof mod.getStaticPaths !== "function") continue;
    const paginate = createPaginate(route, base || "/");
    const sp: StaticPath[] = await mod.getStaticPaths({ paginate });
    dynamicPaths.set(route.file, sp);
  }

  // astro:routes:resolved — fire before rendering so integrations like
  // @astrojs/sitemap and @nuasite/agent-summary can capture the full
  // route tree. Redirects declared in astro.config are included as
  // type: "redirect" entries.
  if (astroHost) {
    const pletivoRoutes: PletivoRouteWithPaths[] = routes.map((r) => ({
      route: r,
      staticPaths: dynamicPaths.get(r.file),
    }));
    const astroRoutes = buildAstroRoutes(pletivoRoutes, astroHost.config, astroHost.injectedRoutes);
    await astroHost.runRoutesResolved(astroRoutes);
    // Stash for build:done below so we don't rebuild the array
    (astroHost as unknown as { __cachedRoutes?: unknown }).__cachedRoutes = astroRoutes;
  }

  const results: PageResult[] = [];

  // Static pages — parallel
  const staticResults = await Promise.all(
    staticRoutes.map(async (route): Promise<PageResult | null> => {
      const fullPath = path.join(pagesDir, route.file);

      // Markdown pages — render directly without module import
      if (route.file.endsWith(".md")) {
        const source = await Bun.file(fullPath).text();
        const { html: body, frontmatter } = parseMarkdown(source);
        const title = (frontmatter.title as string) || "";
        const outFile = routeToOutputPath(route, {});
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>`;
        return { file: route.file, label: route.file, outPath: path.join(distDir, outFile), html };
      }

      const mod = await import(fullPath);
      if (typeof mod.default !== "function") {
        console.warn(`  Skipping ${route.file}: no default export function`);
        return null;
      }
      resetIslandRegistry();
      const outFile = routeToOutputPath(route, {});
      const pathname = toPathname(path.join(distDir, outFile), distDir);
      const { value: html, renderedModules } = await runWithRenderTracking(() =>
        renderComponent(mod.default, makePageContext(pathname, {}, route)),
      );
      if (html === null) {
        console.warn(`  Skipping ${route.file}: default export didn't return HTML`);
        return null;
      }
      return { file: route.file, label: route.file, outPath: path.join(distDir, outFile), html, renderedModules };
    }),
  );
  results.push(...staticResults.filter((r): r is PageResult => r !== null));

  // Dynamic pages — sequential (getStaticPaths may share data)
  for (const route of dynamicRoutes) {
    const staticPaths = dynamicPaths.get(route.file);
    if (!staticPaths) {
      console.warn(`  Skipping ${route.file}: dynamic route without getStaticPaths()`);
      continue;
    }
    const fullPath = path.join(pagesDir, route.file);
    const mod = await import(fullPath);
    for (const { params, props: pathProps } of staticPaths) {
      resetIslandRegistry();
      const outFile = routeToOutputPath(route, params);
      const pathname = toPathname(path.join(distDir, outFile), distDir);
      const ctx = makePageContext(pathname, params, route);
      const { value: html, renderedModules } = await runWithRenderTracking(() =>
        renderComponent(mod.default, { ...(pathProps || {}), ...ctx }),
      );
      if (html === null) continue;

      const label = `${route.file} [${Object.values(params).join("/")}]`;
      results.push({ file: route.file, label, outPath: path.join(distDir, outFile), html, renderedModules });
    }
  }

  // Render i18n fallback emissions + default-locale redirects. Each
  // emission produces either a rewrite (render source component with
  // target locale override) or a redirect HTML document. Fallback
  // emissions are additive to the page set — they never replace an
  // existing rendered route, so we emit them after the main loops.
  if (i18n) {
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
      const { value: html, renderedModules } = await runWithRenderTracking(() =>
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
          // Endpoint — call GET() and write the response body
          const siteUrl = astroHost.config.site ? new URL(astroHost.config.site) : undefined;
          const origin = siteUrl ? siteUrl.origin : "http://localhost/";
          const url = new URL("/" + pattern, origin);
          const response: Response = await mod.GET({
            site: siteUrl,
            url,
            params: {},
            props: {},
            request: new Request(url),
            redirect: (dest: string, status = 302) => new Response(null, { status, headers: { Location: dest } }),
          });
          const body = await response.text();
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          await fs.writeFile(outPath, body);
          results.push({
            file: injected.entrypoint,
            label: `[injected] ${injected.pattern}`,
            outPath,
            html: body,
          });
        } else if (typeof mod.default === "function") {
          // Page component — render as HTML
          resetIslandRegistry();
          const { value: html, renderedModules } = await runWithRenderTracking(() =>
            renderComponent(mod.default, makePageContext("/" + pattern, {}, { file: injected.entrypoint, segments: [], isDynamic: false, priority: 0 })),
          );
          if (html !== null) {
            results.push({
              file: injected.entrypoint,
              label: `[injected] ${injected.pattern}`,
              outPath,
              html,
              renderedModules,
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
    }),
  );
  if (result404) {
    results.push({ file: result404.file, label: result404.file, outPath: path.join(distDir, "404.html"), html: result404.html, renderedModules: result404.renderedModules });
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

  // Bundle CSS from src/ AFTER rendering — side-effect imports of
  // `.scss` / `.sass` from components populate the scss output map
  // during page rendering, so the bundle needs to be computed here
  // to include them.
  const cssPath = await bundleCss(projectRoot, config.srcDir, distDir);

  // Write all pages (including 404) — parallel.
  // Scoped CSS from <style> blocks is injected per-page (not into the
  // global bundle) to avoid cross-page leaks from unscoped rules like
  // `:global()` selectors or `body` styles.
  let totalSize = 0;
  await Promise.all(
    dedupedResults.map(async (result) => {
      const size = await writeHtml(result.outPath, result.html, base, cssPath, publicManifest, result.renderedModules);
      totalSize += size;
      console.log(`  ${result.label} → ${path.relative(projectRoot, result.outPath)} (${formatSize(size)})`);
    }),
  );
  clearScopedCss();
  clearGlobalCss();
  clearCssModules();
  clearScss();

  // Process optimized images registered by <Image> / <Picture> components
  // and passthrough copies of ESM-imported images.
  const imageTransforms = getTransforms();
  let imageCount = 0;
  if (imageTransforms.size > 0 || getImportedImages().size > 0) {
    imageCount = await processImages(imageTransforms, distDir);
    clearTransforms();
  }

  // Detect islands from rendered HTML
  const islandNames = new Set<string>();
  for (const result of dedupedResults) {
    for (const name of extractIslandNames(result.html)) {
      islandNames.add(name);
    }
  }

  // Bundle islands
  if (islandNames.size > 0) {
    await bundleIslands(islandNames, islandsDir, distDir);
  }

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
    await astroHost.runBuildGenerated(distDir);
    const pageEntries = dedupedResults.map((r) => ({
      pathname: toPathname(r.outPath, distDir),
    }));
    const cachedRoutes =
      (astroHost as unknown as { __cachedRoutes?: import("./astro-host").AstroRoute[] }).__cachedRoutes ?? [];
    await astroHost.runBuildDone(cachedRoutes, pageEntries, distDir);
  }

  console.log(`\nBuilt ${results.length} pages${imageCount > 0 ? `, ${imageCount} images` : ""}${islandNames.size > 0 ? `, ${islandNames.size} islands` : ""}${cssPath ? ", 1 CSS bundle" : ""} (${formatSize(totalSize)} total)`);
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

/** Extract island component names from rendered HTML */
function extractIslandNames(html: string): string[] {
  const names: string[] = [];
  const regex = /data-component="([^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    names.push(match[1]);
  }
  return names;
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
  publicManifest: Map<string, string>,
  renderedModules?: Set<string>,
): Promise<number> {
  if (html.trimStart().startsWith("<html") && !html.trimStart().startsWith("<!")) {
    html = "<!DOCTYPE html>\n" + html;
  }

  // Rewrite references to hashed public assets (e.g. /style.css → /style.abc123.css).
  // Done before CSS/island injection so the injected tags (which use already-hashed
  // paths from bundleCss) are not double-rewritten.
  html = rewriteRefs(html, publicManifest);

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
  const astroClasses = extractAstroClasses(html);
  const pageScopedCss = getScopedCssForPage(astroClasses);
  const pageGlobalCss = renderedModules ? getGlobalCssForPage(renderedModules) : "";
  const combinedCss = [pageGlobalCss, pageScopedCss].filter(Boolean).join("\n");
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
    const hydrationBlock = (beforeHydration ? beforeHydration + "\n" : "") + hydrationScript;
    if (html.includes("</head>")) {
      html = html.replace("</head>", hydrationBlock + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", hydrationBlock + "\n</body>");
    } else {
      html += hydrationBlock;
    }
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const bytes = Buffer.byteLength(html, "utf-8");
  await fs.writeFile(outPath, html);
  return bytes;
}

async function render404Page(
  pagesDir: string,
  pageContext: Record<string, unknown>,
): Promise<{ file: string; html: string; renderedModules: Set<string> } | null> {
  for (const ext of [".tsx", ".jsx", ".astro"]) {
    const fullPath = path.join(pagesDir, `404${ext}`);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      const mod = await import(fullPath);
      if (typeof mod.default === "function") {
        resetIslandRegistry();
        const { value: html, renderedModules } = await runWithRenderTracking(() =>
          renderComponent(mod.default, pageContext),
        );
        if (html) {
          return { file: `404${ext}`, html, renderedModules };
        }
      }
      break;
    }
  }
  return null;
}

async function bundleIslands(
  islandNames: Set<string>,
  islandsDir: string,
  distDir: string,
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
    await fs.writeFile(
      wrapperPath,
      `import { hydrate, h } from "preact";\n` +
      `import Component from "${sourcePath}";\n` +
      `export function mount(el, props) { hydrate(h(Component, props), el); }\n`,
    );
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
    plugins: [islandPlugin()],
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
 * Bun plugin that redirects server-side imports to Preact for island bundles.
 * - pletivo/jsx-runtime → preact/jsx-runtime (DOM-based JSX)
 * - pletivo/hooks → preact/hooks (real reactive hooks)
 * - preact/hooks → preact/hooks (bypass tsconfig path override)
 */
function islandPlugin() {
  const preactJsx = require.resolve("preact/jsx-runtime");
  const preactHooks = require.resolve("preact/hooks");

  return {
    name: "pletivo-island",
    setup(build: any) {
      build.onResolve({ filter: /^pletivo\/jsx-runtime$/ }, () => ({
        path: preactJsx,
      }));
      build.onResolve({ filter: /^pletivo\/jsx-dev-runtime$/ }, () => ({
        path: preactJsx,
      }));
      build.onResolve({ filter: /^pletivo\/hooks$/ }, () => ({
        path: preactHooks,
      }));
    },
  };
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

