# 028 — Astro's own test fixtures, built by pletivo

**Priority:** S-tier
**Status:** open; 105 of 202 pass (41 at baseline); what is left is ranked below
**Area:** Astro compatibility, measured

`tests/astro-fixtures/run.ts` copies a fixed subset of the fixtures in
`packages/astro/test/fixtures` of an Astro checkout at `astro@5.16.11`, builds
each with `astro build` and with `pletivo build`, and compares the output with
the comparator of [024](024-astro-examples.md) (`tests/astro-examples/compare.ts`):
same route list, every page equal after the normaliser, other text routes equal as
written, `public/` copies equal byte for byte. On top of that it compares the
bundled assets that are not code (images, fonts) by name with the hash erased
(`tests/astro-fixtures/assets.ts`), so an asset no compared page references still
counts.

```bash
bun tests/astro-fixtures/run.ts --astro ~/path/to/astro-checkout           # the subset
bun tests/astro-fixtures/run.ts --astro … --only astro-attrs,markdown      # some of it
bun tests/astro-fixtures/run.ts --astro … --pletivo <other pletivo checkout>
bun tests/astro-fixtures/run.ts --astro … --all                            # every fixture not skipped
diff -r $TMPDIR/pletivo-astro-fixtures/fixtures/<name>/dist-normalized/{astro,pletivo}
```

A verdict per fixture: **pass** (same routes, equal pages and assets), **fail**
(both build, the output differs) or **error** (pletivo's build fails).

- Every fixture shares one install in the work dir (`INSTALL` in
  `manifest.ts`): the fixtures name their dependencies `workspace:*`. A local
  `@test/*` package a fixture names is copied from the checkout's own install, so
  the checkout needs `pnpm install`.
- Each fixture is built with its own `astro.config.*` only. Astro's tests often
  pass more inline (an adapter, `site`, `base`); the harness does not, so both
  builders see the same project.
- Astro's build is cached per fixture, keyed by its files and the install; a
  failure is cached too. A run of the subset takes about 90 s on 2 vCPU once
  Astro's builds are cached.

## The subset

308 fixtures have a `package.json`. 202 are built and judged (`SUBSET`); 106 are
skipped, each with its reason (`SKIPPED`):

| reason | fixtures |
|---|---|
| Astro's own build fails on the fixture's config alone (its test adds an adapter, or expects the error) | 74 |
| its tests only run the dev server, preview server or a CLI command | 10 |
| an integration pletivo does not target: the node adapter (4), `@astrojs/markdoc` (3), `@astrojs/check` (3), a renderer written for the test (3), `@astrojs/partytown`, Vitest | 13 |
| a unit-test input, not a site | 3 |
| imports Astro's test helpers, which import Astro's unpublished `dist/` | 2 |
| renders `Math.random()` or the time, so no two builds match | 2 |

The subset was chosen by one `--all` run: every fixture Astro builds, minus the
two above. The runner warns about a fixture in neither list, so one added
upstream is classified, not lost.

## Counts

| run | pass | fail | error | pages equal, in fixtures that build |
|---|---|---|---|---|
| baseline, main at ef4a76a | 41 | 110 | 51 | 300 of 519 |
| after the gaps below | **105** | 68 | 29 | 417 of 559 |

Between the two runs, 54 fixtures went from fail to pass, 10 from error to pass and 12
from error to fail. No fixture got worse.

## Gaps closed

One commit each, in order, and each with its own test. The harness ran after each
gap, or after a group of small ones. A fixture is counted under the gap whose run
first showed it passing; it may also have needed earlier gaps.

| # | gap | fixtures it made pass | other effect |
|---|---|---|---|
| 1 | A project that depends on `astro` is an Astro project without an `astro.config.*` | 26: asset-url-base, astro-class-list, astro-component-code, astro-doctype, astro-external-files, astro-head, astro-public, astro-response, build-readonly-file, code-component, content with spaces in folder name, dynamic-route-build-file, head-injection, lazy-layout, page-format, public-base-404, remote-css, scoped-style-strategy, ssr-assets, ssr-markdown, ssr-params, ssr-script, static-build-code-component, static-build-dir, type-imports, unused-slot | |
| 2 | A `.md` page without a layout renders as Astro's (no document wrapper) | 4: astro pages, astro-markdown-remarkRehype, astro-markdown-url, astro-page-directory-url | |
| 3 | Attributes rendered with Astro's rules | 2: astro-attrs, astro-object-style | |
| 4 | A static redirect page uses Astro's template | | 1 more page equal |
| 5 | An i18n fallback redirects by default (`fallbackType`) | | |
| 6 | Astro 5's deprecated `getEntryBySlug` and `getDataEntryById` | content-collections-same-contents | 4 error → fail |
| 7 | Output file names follow `build.format` | 3: custom-404-md, i18n-locale-index-format-file, static-build-page-url-format | |
| 8 | Undefined `src/content/` folders become collections, as in Astro 5 | | 5 error → fail |
| 9 | A project without `src/pages` builds no pages | 3: astro-components, astro-css-bundling-nested-layouts, integration-server-setup | |
| 10 | `paginate()` URLs as Astro builds them | astro-pagination-root-spread | |
| 11 | The higher-priority route keeps a path two routes build | 2: prerender-conflict-dynamic-dynamic, prerender-conflict-static-dynamic | |
| 12 | Pages built from Astro's request origin (`http://localhost:4321`) | 2: ssr-request, ssr-response | |
| 13 | A `Response`, bytes, iterables and streams in templates | set-html | |
| 14 | `.md` with Astro's smartypants and highlighter | astro-markdown-plugins | |
| 15 | `.html` components and pages | 6: custom-404-html, html-component, html-escape, html-escape-complex, html-page, html-slots | |
| 16 | `Astro.url` and `Astro.rewrite` under a `base` | 2: rewrite-trailing-slash-never, rewrite-with-base | |
| 17 | Vite's `?inline` CSS is a string | | astro-envs error → fail |
| 18 | Remark plugins see the frontmatter (`file.data.astro.frontmatter`) | | 2 more pages equal |
| 19–21 | `set:html={false}` renders nothing; `define:vars` keys become identifiers; config `redirects` are built and served | static-redirect | |
| 22–24 | `getCollection` returns a new array; Astro's heading ids for `.md`; `getHeadings()` and `render()` headings | content-collections-mutation | |
| 25–27 | i18n redirect targets and `astro:i18n` URLs end with `/` where Astro's config says; a fallback keeps the path of a route without a locale directory | 3: i18n-routing, i18n-routing-fallback, i18n-routing-fallback-index | |
| 28–30 | An `.astro` import in a page script is an empty module; `glob()` takes a `file:` URL base; `astro:env` validated and typed | | 2 error → fail: astro-env, content-layer-rendering |
| 31–32 | `Astro.currentLocale` read from the path; only the root redirects to the default locale | 4: i18n-routing-base, i18n-routing-dynamic, i18n-routing-prefix-always, redirects-i18n | |
| 33–34 | `{true}` renders as `true`; `astro:config/client` and `astro:config/server` | astro-manifest | |

## What is left

Ranked by how many fixtures have their first difference in each area. A fixture can
have more than one gap, so closing one does not always make it pass.

| area | fixtures | kind | what it needs |
|---|---|---|---|
| Framework renderers and island ids | 16: 0-css, alias, astro-slot-with-client, core-image-svg-in-island, entry-file-names, postcss, preact-component, slots-preact, slots-react, slots-solid, slots-svelte, slots-vue, special-chars-in-component-imports, svelte-component, vue-component, vue-jsx | feature, partly out of scope | Renderers pletivo does not target (Vue, Svelte, Solid, Preact through Astro's renderer), and island `uid`/`prefix` numbering, which depends on render order |
| The image pipeline | 13: astro-assets, astro-assets-dir, core-image-base, core-image-data-url, core-image-fs-config, core-image-infersize, core-image-layout, core-image-remark-imgattr, core-image-svg, core-image-svg-optimized, core-image-unconventional-settings, markdown, passthrough-image-service | feature, [002](002-image-optimization.md) | Astro's file names and hashes, `srcset`, `layout`, SVG components, AVIF input, `inferRemoteSize`, images in Markdown |
| Which CSS a page gets | 12: alias-tsconfig-baseurl-only, astro-client-only, astro-css-bundling, astro-partial-html, content, content-collections-base, css-double-bundle, css-import-as-inline, css-order-dynamic-import, css-order-import, hoisted-imports, page-level-styles | decision, [014](014-astro-css-cascade-order.md), [019](019-css-chunking.md) | pletivo ships every `src/**/*.css` to every page, unimported files too, and always inlines a page's `.astro` CSS. `@import` in a `<style>` is not inlined (no `preprocessStyle`) |
| Middleware | 10: custom-404-loop-case-4, i18n-routing-manual, i18n-routing-manual-with-default-middleware, middleware-no-user-middleware, middleware-sequence-rewrite, middleware-ssg, redirects, reroute, rewrite-custom-404, rewrite-dynamic-routing | feature, no todo yet | pletivo does not run `src/middleware` in a static build |
| `import.meta.glob` and `Astro.glob` | 8: alias-tsconfig, astro-global, astro-markdown-frontmatter-injection, astro-scripts, css-dangling-references, debug-component, glob-pages-css, static-build | decision, [016](016-workers-host-divergences.md) | the Workers host has the transform (`packages/workers/src/compile/import-meta-glob.ts`); the Bun host needs it too, either moved to core or forked |
| `legacy.collections` | 7: content-collections, content-collections-empty-dir, css-inline-stylesheets, css-inline-stylesheets-2, css-inline-stylesheets-3, legacy-content-collections, legacy-data-collections | decision, [006](006-content-layer-custom-loaders.md) | A legacy `.md` entry's `layout:` (needs a host seam: core cannot import the layout), Astro's slugged ids, and an unknown collection being a warning rather than an error (an error-semantics decision) |
| Endpoints and mixed params | 5: api-routes, data-collections, data-collections-schema, reuse-injected-entrypoint, routing-priority | feature, [012](012-endpoint-routes.md) | A route segment that mixes a param with text (`[id].json`, `[lang]-[v]`): the router's segment model has one kind per segment, and about 30 places read it, the Workers host's included. Also endpoint routes with `getStaticPaths`, injected routes reused with different params |
| Fonts and CSP | 5: css-assets, csp, csp-fonts, fonts, fontsource-package | feature | `astro:assets` `Font`, `Astro.csp`, font files from packages |
| Equivalent output | 5: astro-component-bundling, astro-env, middleware-tailwind, tailwindcss, view-transitions | not a gap | Minifier and Tailwind version differences in text that means the same |
| One fixture each | 16 | mixed | astro-basic (`file://` import), alias-tsconfig-no-baseurl (Bun applies tsconfig `paths` only with a `baseUrl`), astro-mode (`.env` by mode: Bun loads `.env.development` at process start), astro-generator (`Astro.generator` says pletivo), astro-envs (Vite `transform` hooks on JSON), astro-markdown (`?url` of a `.md`), astro-directives (compiler 2.13 vs 3.0 orders `define:vars`), content-layer (`file()` loader), content-layer-rendering (`glob()`'s default id is not slugged as Astro's), content-layer-remark-plugins (MDX remark frontmatter), dynamic-route-collision (Astro's output contradicts its own test; pletivo follows the test), get-static-paths-pages (Astro takes `Astro.params` from the URL), integration-add-page-extension (`addPageExtension` is a no-op; the router knows a fixed list of page extensions), root-srcdir-css (a decision: pletivo stops when its `srcDir` and astro.config's differ), ssr-prerender-chunks (adapter output), virtual-astro-file |

## Per fixture now

First difference as the runner prints it; `<work>` is the work dir. The baseline
table is in this file's history.

| fixture | verdict | routes (common/astro +extra) | pages equal | first difference |
|---|---|---|---|---|
| 0-css | error |  |  | error: Cannot compile Vue component <work>/fixtures/0-css/src/components/VueModules.vue: |
| alias | error |  |  | error: Cannot find package 'component:Client.svelte' from '<work>/fixtures/alias/src/pages/index.astro' |
| alias-tsconfig | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("@components/glob/*.js")', 'import.meta.glob' is undefined) |
| alias-tsconfig-baseurl-only | fail | 1/1 | 0/1 | index.html: `#style-red{color:red}` vs `@import"styles/extra.css":` |
| alias-tsconfig-no-baseurl | error |  |  | error: Cannot find module '@hello/world' from '<work>/fixtures/alias-tsconfig-no-baseurl/src/pages/index.astro' |
| api-routes | fail | 1/3 +1 | 0/0 | missing context/data/one.json, context/data/two.json; extra context/data/[param].json; binary.dat: `1 bytes` vs `3 bytes` |
| asset-url-base | **pass** | 1/1 | 1/1 |  |
| astro pages | **pass** | 3/3 | 3/3 |  |
| astro-assets | fail | 1/1 | 0/1 | index.html: `…~1.png 1x, /_astro/twitter@2x.Cjyw9ZFT.png 2x, /_astro/twitter@3x.BGs7koIb.png ` vs `…~1.png 1x, /_astro/twitter@2x.00f41634.png 2x, /_astro/twitt… |
| astro-assets-dir | fail | 3/3 | 0/3 | blog/index.html: `<img src="/_astro/%E3%83%9A%E3%83%B3%E3%82%AE%E3%83%B3.wSAOfMN3_28CuP5.webp" alt` vs `<img src="/[asset]/penguin1.4a36c476~1.webp" width="100"… |
| astro-attrs | **pass** | 4/4 | 4/4 |  |
| astro-basic | error |  |  | error: Cannot find module '/strings.js' from '<work>/fixtures/astro-basic/src/pages/fileurl.astro' |
| astro-children | **pass** | 4/4 | 4/4 |  |
| astro-class-list | **pass** | 2/2 | 2/2 |  |
| astro-client-only | fail | 5/5 | 0/5 | css-modules/index.html: `._red_146yk_1{color:red}` vs `astro-island,astro-slot,astro-static-slot{display:contents}`; assets extra styles.module-nnh5nfyd.scss |
| astro-component-bundling | fail | 2/2 | 0/2 | astro-in-client/index.html: `<script type="module">const o={};console.log(o);</script>` vs `<script type="module">var o={};console.log(o);</script>` |
| astro-component-code | **pass** | 9/9 | 9/9 |  |
| astro-components | **pass** | 0/0 | 0/0 |  |
| astro-css-bundling | fail | 3/3 | 0/3 | index.html: `.page__index[data-astro-cid-c1]{background:var(--red)}` vs `.page__index{background:var(--red)}` |
| astro-css-bundling-nested-layouts | **pass** | 0/0 | 0/0 |  |
| astro-directives | fail | 3/3 | 2/3 | define-vars/index.html: `…ml data-astro-cid-c1 style="--fg: black;--bg: white;">` vs `…ml data-astro-cid-c1 style="--bg: white;--fg: black;">` |
| astro-doctype | **pass** | 8/8 | 7/7 |  |
| astro-dynamic | **pass** | 3/3 | 3/3 |  |
| astro-env | fail | 1/1 | 0/1 | index.html: `<script type="module">document.getElementById("client-rendered").innerText="DEF"` vs `<script type="module">var e="DEF";document.getElementById("cl… |
| astro-envs | fail | 3/3 | 1/3 | index.html: `…environment-variable id="env">A MYSTERY</environment-variable> ` vs `…environment-variable id="env">` |
| astro-expr | **pass** | 8/8 | 8/8 |  |
| astro-external-files | **pass** | 2/2 | 1/1 |  |
| astro-fallback | **pass** | 1/1 | 1/1 |  |
| astro-generator | fail | 1/1 | 0/1 | index.html: `…<a href="https://astro.build">Astro v5.16.11</a>` vs `…<a href="https://astro.build">pletivo</a>` |
| astro-global | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../post/*.md")', 'Astro.glob' is undefined) |
| astro-head | **pass** | 1/1 | 1/1 |  |
| astro-manifest | **pass** | 2/2 | 2/2 |  |
| astro-markdown | fail | 8/8 | 5/5 | raw-content.json: `…content look right!\n","url":"data:text/markdown;base64,IyBCYXNpYyBwYWdlCgpMZXR` vs `…content look right!\n","url":"/_astro/basic.ad34869d.m… |
| astro-markdown-frontmatter-injection | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("./*.md", { eager: !0 })', 'import.meta.glob' is undefined) |
| astro-markdown-plugins | **pass** | 3/3 | 3/3 |  |
| astro-markdown-remarkRehype | **pass** | 1/1 | 1/1 |  |
| astro-markdown-url | **pass** | 2/2 | 2/2 |  |
| astro-mode | fail | 1/1 | 0/1 | index.html: `<div id="env-title">production</div>` vs `<div id="env-title">development</div>` |
| astro-object-style | **pass** | 2/2 | 2/2 |  |
| astro-page-directory-url | **pass** | 3/3 | 3/3 |  |
| astro-pagination-root-spread | **pass** | 4/4 | 4/4 |  |
| astro-partial-html | fail | 4/4 | 2/4 | jsx/index.html: `<style>` vs `<end>` |
| astro-public | **pass** | 4/4 | 1/1 |  |
| astro-response | **pass** | 1/1 | 1/1 |  |
| astro-scripts | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("/src/components/Glob/*")', 'Astro.glob' is undefined) |
| astro-slot-with-client | fail | 1/1 | 0/1 | index.html: `<script>(()=>{var e=async t=>{await(await t())()};(self.Astro\|\|(self.Astro={})).` vs `<section>` |
| astro-slots-nested | **pass** | 3/3 | 3/3 |  |
| before-hydration | **pass** | 1/1 | 1/1 |  |
| build-readonly-file | **pass** | 2/2 | 1/1 |  |
| code-component | **pass** | 1/1 | 1/1 |  |
| config-vite | **pass** | 1/1 | 1/1 |  |
| config-vite-css-target | **pass** | 1/1 | 1/1 |  |
| content | fail | 6/6 | 1/6 | index.html: `<end>` vs `<style>` |
| content with spaces in folder name | **pass** | 1/1 | 1/1 |  |
| content-collections | fail | 5/5 | 1/3 | collections.json: `…emaConfig":1,"withSlugConfig":95,"withUnionSchema":136,"withSymlinkedContent":1` vs `…emaConfig":1,"withSlugConfig":37,"withUnionSchema":50,… |
| content-collections-base | fail | 1/1 | 0/1 | docs/index.html: `<link rel="stylesheet" href="/docs/[bundle]/1.css">` vs `</head>` |
| content-collections-empty-dir | error |  |  | error: Collection "blogs" not found. Define it in src/content.config.ts or src/content/config.ts |
| content-collections-mutation | **pass** | 2/2 | 2/2 |  |
| content-collections-same-contents | **pass** | 1/1 | 1/1 |  |
| content-layer | error |  |  | SyntaxError: Export named 'file' not found in module 'astro/loaders'. |
| content-layer-remark-plugins | fail | 5/5 | 3/4 | test2/index.html: `…"frontmatter-custom-property">Generated property via remark plugin!</div>` vs `…"frontmatter-custom-property">` |
| content-layer-rendering | fail | 1/2 +1 | 0/2 | missing reptiles/im-back/index.html; extra reptiles/I'm back!/index.html; reptiles/iguana/index.html: `<img src="/[asset]/shuttle~1.webp" alt="file" loading="la… |
| content-static-paths-integration | **pass** | 4/4 | 4/4 |  |
| core-image-base | fail | 9/9 | 3/9 | aliasMarkdown/index.html: `<img src="/[asset]/penguin1~1.webp" alt="A penguin" loading="lazy" decoding="asy` vs `<img src="~/assets/penguin1.jpg" alt="A penguin… |
| core-image-data-url | fail | 1/1 | 0/1 | index.html: `…MDA6MDCpOdKQAAAAAElFTkSuQmCC" alt="transparent" loading="lazy" decoding="async"` vs `…MDA6MDCpOdKQAAAAAElFTkSuQmCC" width="128" height="72" loadin… |
| core-image-fs-config | fail | 2/2 | 1/2 | imported/index.html: `… src="/[asset]/penguin-sibling~1.webp" id="sibling-image" alt="Penguin from sib` vs `… src="/[asset]/penguin-sibling.4a36c476~1.webp" wid… |
| core-image-infersize | error |  |  | SyntaxError: Export named 'inferRemoteSize' not found in module 'astro:assets'. |
| core-image-layout | fail | 6/6 | 0/6 | both/index.html: `<img src="/[asset]/penguin~1.webp" srcset="/[asset]/penguin~2.webp 640w, /[asset` vs `<img src="/[asset]/penguin.839a489d~1.webp" width="2316"… |
| core-image-remark-imgattr | fail | 1/1 | 0/1 | index.html: `<img src="/[asset]/penguin2~1.webp" alt="alt" loading="eager" decoding="async" f` vs `<img src="../assets/penguin2.jpg" alt="alt" loading="eager" w… |
| core-image-svg | error |  |  | error: pletivo cannot render <Plus>: it is an image import, which pletivo does not render as a component (Astro renders an imported SVG inline). Use <img src={P… |
| core-image-svg-in-island | fail | 1/1 | 0/1 | index.html: `<astro-island uid="EdJE2" prefix="r1" component-url="/[bundle]/1.js" component-e` vs `<astro-island uid="fU7So" prefix="r1" component-url="/[bundle… |
| core-image-svg-optimized | error |  |  | error: pletivo cannot render <TestIcon>: it is an image import, which pletivo does not render as a component (Astro renders an imported SVG inline). Use <img sr… |
| core-image-unconventional-settings | error |  |  | error: Unsupported image format: <work>/fixtures/core-image-unconventional-settings/src/assets/light_walrus.avif |
| csp | error |  |  | TypeError: undefined is not an object (evaluating 'Astro.csp.insertScriptResource') |
| csp-fonts | error |  |  | SyntaxError: Export named 'Font' not found in module 'astro:assets'. |
| css-assets | fail | 2/2 | 0/2 | one/index.html: `…300;font-display:swap;src:url(data:font/woff2;base64,SFRUUC8yIDIwMCANCmRhdGU6IF` vs `…300;font-display:swap;src:url(@test/astro-font-awesome-p… |
| css-dangling-references | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("./*.svelte")', 'import.meta.glob' is undefined) |
| css-double-bundle | fail | 1/1 | 0/1 | index.html: `<script type="module" src="/[bundle]/1.js">` vs `</body>` |
| css-import-as-inline | fail | 1/1 | 0/1 | index.html: `html{background-color:#f6f6f6;font-family:system-ui,sans-serif}` vs `body{background:tomato}` |
| css-inline-stylesheets | fail | 1/1 | 0/1 | index.html: `<html lang="en">` vs `<p>` |
| css-inline-stylesheets-2 | fail | 1/1 | 0/1 | index.html: `<html lang="en">` vs `<p>` |
| css-inline-stylesheets-3 | fail | 1/1 | 0/1 | index.html: `<html lang="en">` vs `<p>` |
| css-no-code-split | **pass** | 1/1 | 1/1 |  |
| css-order | **pass** | 3/3 | 3/3 |  |
| css-order-dynamic-import | fail | 2/2 | 0/2 | one/index.html: `body{background:#deb887}` vs `body{background:#ff0}` |
| css-order-import | fail | 3/3 | 0/3 | component/index.html: `.client-1{background:red!important}` vs `.astro-jsx{color:red}` |
| css-order-layout | **pass** | 3/3 | 3/3 |  |
| css-order-transparent | **pass** | 1/1 | 1/1 |  |
| custom-404-html | **pass** | 2/2 | 2/2 |  |
| custom-404-locals | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-1 | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-2 | **pass** | 1/1 | 1/1 |  |
| custom-404-loop-case-3 | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-4 | fail | 1/1 +1 | 1/1 | extra 404.html |
| custom-404-md | **pass** | 2/2 | 2/2 |  |
| data-collections | fail | 3/9 +2 | 0/0 | missing authors/Ben Holmes.json, authors/Fred K Schott.json, authors/Nate Moore.json (+3); extra authors/[id].json, translations/[lang].json; authors/all.json: … |
| data-collections-schema | fail | 3/9 +2 | 0/0 | missing authors/Ben Holmes.json, authors/Fred K Schott.json, authors/Nate Moore.json (+3); extra authors/[id].json, translations/[lang].json; authors/all.json: … |
| debug-component | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../../data/posts/*.md")', 'Astro.glob' is undefined) |
| dynamic-route-build-file | **pass** | 3/3 | 3/3 |  |
| dynamic-route-collision | fail | 9/9 | 7/9 | blog/index.html: `<title>Rest Blog</title>` vs `<title>Dynamic Blog</title>` |
| entry-file-names | fail | 1/3 | 0/1 | missing assets/js/Hello.js, assets/js/client.js; index.html: `…d uid="7Hdzi" component-url="/assets/js/Hello.js" component-export="default" re` vs `…d uid="7Hdz… |
| extension-matching | **pass** | 1/1 | 1/1 |  |
| fetch | **pass** | 1/1 | 1/1 |  |
| fonts | error |  |  | SyntaxError: Export named 'Font' not found in module 'astro:assets'. |
| fontsource-package | fail | 1/1 +14 | 0/1 | extra assets/monofett-latin-400-normal.7c6d572a.woff, assets/monofett-latin-400-normal.e9b88a97.woff2, assets/monofett-latin-ext-400-normal.3d7158b6.woff2 (+11)… |
| get-static-paths-pages | fail | 5/5 | 2/5 | archive/news/july-2024/2/index.html: `<p id="slug">news</p>` vs `<p id="slug">news/july-2024</p>` |
| glob-pages-css | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../pages/**/*.astro")', 'Astro.glob' is undefined) |
| head-injection | **pass** | 6/6 | 6/6 |  |
| hoisted-imports | fail | 8/8 | 2/8 | all/index.html: `<end>` vs `<style>` |
| html-component | **pass** | 1/1 | 1/1 |  |
| html-escape | **pass** | 1/1 | 1/1 |  |
| html-escape-complex | **pass** | 1/1 | 1/1 |  |
| html-page | **pass** | 1/1 | 1/1 |  |
| html-slots | **pass** | 1/1 | 1/1 |  |
| hydration-race | **pass** | 2/2 | 2/2 |  |
| i18n-double-prefix | **pass** | 3/3 | 3/3 |  |
| i18n-locale-index-format-file | **pass** | 3/3 | 3/3 |  |
| i18n-routing | **pass** | 18/18 | 18/18 |  |
| i18n-routing-base | **pass** | 13/13 | 13/13 |  |
| i18n-routing-dynamic | **pass** | 3/3 | 3/3 |  |
| i18n-routing-fallback | **pass** | 18/18 | 18/18 |  |
| i18n-routing-fallback-index | **pass** | 3/3 | 3/3 |  |
| i18n-routing-fallback-rewrite-filename | **pass** | 18/18 | 18/18 |  |
| i18n-routing-manual | fail | 13/13 +1 | 12/13 | extra 404.html; index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| i18n-routing-manual-with-default-middleware | fail | 16/16 +3 | 13/16 | extra it/about/index.html, it/blog/index.html, it/index.html; about/index.html: `ABOUT ME` vs `<!DOCTYPE html>` |
| i18n-routing-prefix-always | **pass** | 17/17 | 16/16 |  |
| i18n-routing-prefix-other-locales | **pass** | 13/13 | 13/13 |  |
| i18n-routing-redirect-preferred-language | **pass** | 11/11 | 11/11 |  |
| import-ts-with-js | **pass** | 1/1 | 1/1 |  |
| impostor-mdx-file | **pass** | 1/1 | 1/1 |  |
| integration-add-page-extension | fail | 0/1 | 0/1 | missing test/index.html |
| integration-server-setup | **pass** | 0/0 | 0/0 |  |
| jsx | **pass** | 2/2 | 2/2 |  |
| large-array | **pass** | 1/1 | 1/1 |  |
| lazy-layout | **pass** | 1/1 | 1/1 |  |
| legacy-content-collections | fail | 5/5 | 1/3 | collections.json: `…Config":1,"withSchemaConfig":42,"withSlugConfig":75,"withUnionSchema":86,"withS` vs `…Config":1,"withSchemaConfig":45,"withSlugConfig":81,"w… |
| legacy-data-collections | error |  |  | error: Collection "authors-without-config" not found. Define it in src/content.config.ts or src/content/config.ts |
| markdown | fail | 4/9 | 3/9 | missing dot-markdown-page/index.html, dot-mdown-page/index.html, dot-mdwn-page/index.html (+2); images/index.html: `<img src="/[asset]/houston~1.webp" alt="hous… |
| middleware-no-user-middleware | fail | 1/4 | 1/4 | missing post/index.html, pre/index.html, url/index.html |
| middleware-sequence-request-clone | **pass** | 1/1 | 1/1 |  |
| middleware-sequence-rewrite | fail | 2/2 | 1/2 | index.html: `<h1>Hello Another</h1>` vs `<h1>Hello Sequence</h1>` |
| middleware-ssg | fail | 2/2 | 0/2 | index.html: `<p>bar</p>` vs `<p>` |
| middleware-tailwind | fail | 1/1 | 0/1 | index.html: `@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inli` vs `p[data-astro-cid-c1]{color:red}` |
| middleware-virtual | **pass** | 1/1 | 1/1 |  |
| minification-html | **pass** | 3/3 | 3/3 |  |
| page-format | **pass** | 6/6 | 6/6 |  |
| page-level-styles | fail | 2/2 | 1/2 | index.html: `<end>` vs `<style>` |
| partials | **pass** | 3/3 | 3/3 |  |
| passthrough-image-service | fail | 1/1 | 0/1 | index.html: `<img src="/[asset]/penguin1~1.jpg" alt="a penguin" loading="lazy" decoding="asyn` vs `<img src="/[asset]/penguin1.4a36c476~1.webp" width="207" heig… |
| postcss | error |  |  | SyntaxError: Export named 'h' not found in module '<work>/node_modules/solid-js/dist/server.js'. |
| preact-component | error |  |  | error: pletivo cannot render Preact components: <FragComponent> returned a Preact element (<k>). Astro renders these through the renderer of the framework's int… |
| prerender-conflict-dynamic-dynamic | **pass** | 5/5 | 5/5 |  |
| prerender-conflict-static-dynamic | **pass** | 1/1 | 1/1 |  |
| public-base-404 | **pass** | 3/3 | 2/2 |  |
| react-and-solid | **pass** | 1/1 | 1/1 |  |
| react-jsx-export | **pass** | 1/1 | 1/1 |  |
| redirects | fail | 9/9 | 8/9 | middleware-redirect/index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| redirects-i18n | **pass** | 2/2 | 2/2 |  |
| reexport-astro-containing-client-component | **pass** | 1/1 | 1/1 |  |
| remote-css | **pass** | 1/1 | 1/1 |  |
| reroute | fail | 13/14 | 3/14 | missing auth/astro-params/index.html; auth/1234/index.html: `<p id="locals">Locals: Params changed</p>` vs `<p id="locals">Locals:</p>` |
| reuse-injected-entrypoint | fail | 1/9 +4 | 1/9 | missing dynamic-a/id-1/index.html, dynamic-a/id-2/index.html, dynamic-b/id-1/index.html (+5); extra dynamic-a/[id], dynamic-b/[id], injected-a (+1) |
| rewrite-custom-404 | fail | 4/4 | 0/4 | 404.html: `<p>Interjected</p>` vs `<p>` |
| rewrite-dynamic-routing | fail | 6/6 | 5/6 | bar/index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| rewrite-i18n-manual-routing | **pass** | 1/1 | 1/1 |  |
| rewrite-trailing-slash-never | **pass** | 3/3 | 3/3 |  |
| rewrite-with-base | **pass** | 9/9 | 9/9 |  |
| root-srcdir-css | error |  |  | astro.config sets srcDir ".", but pletivo reads sources from "src". Set srcDir: "." in pletivo.config as well. |
| routing-priority | fail | 14/21 +5 | 14/18 | missing _injected/index.html, api/catch/a-b.json, api/catch/a.json (+4); extra [id], _injected, api/catch/[...slug].json (+2) |
| scoped-style-strategy | **pass** | 1/1 | 1/1 |  |
| set-html | **pass** | 4/4 | 4/4 |  |
| slots-preact | fail | 2/2 | 1/2 | mdx/index.html: `<astro-island uid="ZlAqok" component-url="/[bundle]/1.js" component-export="defa` vs `<astro-island uid="Z1JrU1X" component-url="/[bundle]/1.js… |
| slots-react | fail | 3/3 | 1/3 | index.html: `…-island uid="HmxFp" prefix="r10" component-url="/[bundle]/1.js" component-expor` vs `…-island uid="HmxFp" prefix="r13" component-url="/[bundle]/1.… |
| slots-solid | fail | 2/2 | 0/2 | index.html: `<astro-island uid="Z13sF6B" data-solid-render-id="s2" component-url="/[bundle]/1` vs `<astro-island uid="Z1Q7Ya8" data-solid-render-id="s5" compone… |
| slots-svelte | fail | 2/2 | 0/2 | index.html: `.counter.svelte-ziooqw{display:grid;font-size:2em;grid-template-columns:repeat(3` vs `astro-island,astro-slot,astro-static-slot{display:contents}` |
| slots-vue | error |  |  | error: pletivo cannot render an unnamed component: a component must be a function, an .astro component or an element name, not a value of type object. |
| sourcemap | **pass** | 1/1 | 1/1 |  |
| special-chars-in-component-imports | fail | 2/2 | 1/2 | mdx/index.html: `…&quot;name&quot;:&quot;Counter$4&quot;,&quot;value&quot;:true}" await-children>` vs `…&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:t… |
| ssr-assets | **pass** | 1/1 | 1/1 |  |
| ssr-env | **pass** | 1/1 | 1/1 |  |
| ssr-markdown | **pass** | 1/1 | 1/1 |  |
| ssr-params | **pass** | 7/7 | 7/7 |  |
| ssr-prerender-chunks | fail | 1/16 | 1/1 | missing _worker.js/_@astrojs-ssr-adapter.mjs, _worker.js/_noop-middleware.mjs, _worker.js/chunks/_@astro-renderers_M9Bh76Zv.mjs (+12) |
| ssr-request | **pass** | 2/2 | 1/1 |  |
| ssr-response | **pass** | 6/6 | 6/6 |  |
| ssr-script | **pass** | 1/1 | 1/1 |  |
| ssr-scripts | **pass** | 1/1 | 1/1 |  |
| static-build | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("./posts/**/*.md")', 'import.meta.glob' is undefined) |
| static-build-code-component | **pass** | 1/1 | 1/1 |  |
| static-build-dir | **pass** | 1/1 | 1/1 |  |
| static-build-page-url-format | **pass** | 2/2 | 2/2 |  |
| static-redirect | **pass** | 2/2 | 2/2 |  |
| svelte-component | error |  |  | error: pletivo cannot render <work>/fixtures/svelte-component/src/components/Custom.sve as a component: pletivo has no module loader for .sve files, so the impo… |
| tailwindcss | fail | 2/2 | 0/2 | index.html: `@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inli` vs `@layer properties:` |
| type-imports | **pass** | 1/1 | 1/1 |  |
| unused-slot | **pass** | 1/1 | 1/1 |  |
| view-transitions | fail | 4/4 | 0/4 | hasIsland/index.html: `…on){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*` vs `…on){::view-transition-group(*){animation:none!impo… |
| virtual-astro-file | error |  |  | error: Cannot find module '@my-plugin/virtual.astro' from '<work>/fixtures/virtual-astro-file/src/pages/index.astro' |
| vue-component | fail | 2/2 | 0/1 | index.html: `<my-button>Click Me</my-button>` vs `<!---->` |
| vue-jsx | error |  |  | error: pletivo cannot render <Counter>: a component must be a function, an .astro component or an element name, not a value of type object. |
| vue-with-multi-renderer | **pass** | 1/1 | 1/1 |  |
| with-subpath-no-trailing-slash | **pass** | 3/3 | 3/3 |  |
