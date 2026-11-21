# 028 — Astro's own test fixtures, built by pletivo

**Priority:** S-tier
**Status:** open; harness committed, baseline 41 of 202 pass
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

## Baseline (main at ef4a76a)

**41 pass, 110 fail, 51 error** of 202.

## Gaps

Ranked by how many fixtures each one breaks at baseline; a fixture often has
more than one, so a fix shows as a pass only once its last gap closes.

## Per fixture at baseline

First difference as the runner prints it; `<work>` is the work dir.

| fixture | verdict | routes (common/astro +extra) | pages equal | first difference |
|---|---|---|---|---|
| 0-css | error |  |  | error: Cannot compile Vue component <work>/fixtures/0-css/src/components/VueModules.vue: |
| alias | error |  |  | error: Cannot find package 'component:Client.svelte' from '<work>/fixtures/alias/src/pages/index.astro' |
| alias-tsconfig | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("@components/glob/*.js")', 'import.meta.glob' is undefined) |
| alias-tsconfig-baseurl-only | fail | 1/1 | 0/1 | index.html: `#style-red{color:red}` vs `@import"styles/extra.css":` |
| alias-tsconfig-no-baseurl | error |  |  | error: Cannot find module '@hello/world' from '<work>/fixtures/alias-tsconfig-no-baseurl/src/pages/index.astro' |
| api-routes | fail | 1/3 +2 | 0/0 | missing context/data/one.json, context/data/two.json; extra context/data/[param].json, sitemap.xml; binary.dat: `1 bytes` vs `3 bytes` |
| asset-url-base | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| astro pages | fail | 3/3 +1 | 0/3 | extra sitemap.xml; index.html: `<meta charset="utf-8">` vs `<html>` |
| astro-assets | fail | 1/1 | 0/1 | index.html: `…~1.png 1x, /_astro/twitter@2x.Cjyw9ZFT.png 2x, /_astro/twitter@3x.BGs7koIb.png ` vs `…~1.png 1x, /_astro/twitter@2x.00f41634.png 2x, /_astro/twitt… |
| astro-assets-dir | fail | 3/3 | 0/3 | blog/index.html: `<img src="/_astro/%E3%83%9A%E3%83%B3%E3%82%AE%E3%83%B3.wSAOfMN3_28CuP5.webp" alt` vs `<img src="/[asset]/penguin1.4a36c476~1.webp" width="100"… |
| astro-attrs | fail | 4/4 | 3/4 | index.html: `…string-truthy" allowfullscreen>` vs `…string-truthy" allowfullscreen="foo">` |
| astro-basic | error |  |  | error: Cannot find module '/strings.js' from '<work>/fixtures/astro-basic/src/pages/fileurl.astro' |
| astro-children | **pass** | 4/4 | 4/4 |  |
| astro-class-list | fail | 2/2 +1 | 0/2 | extra sitemap.xml; component/index.html: `<!DOCTYPE html>` vs `<span class="test control">test control</span> ` |
| astro-client-only | fail | 5/5 | 0/5 | css-modules/index.html: `._red_146yk_1{color:red}` vs `astro-island,astro-slot,astro-static-slot{display:contents}`; assets extra styles.module-nnh5nfyd.scss |
| astro-component-bundling | fail | 2/2 | 0/2 | astro-in-client/index.html: `<script type="module">const o={};console.log(o);</script>` vs `<script type="module">var o="./AstroComponent-y0regfta.astro";consol… |
| astro-component-code | fail | 9/9 +1 | 9/9 | extra sitemap.xml |
| astro-components | error |  |  | ENOENT: no such file or directory, open '<work>/fixtures/astro-components/src/pages' |
| astro-css-bundling | fail | 3/3 +1 | 0/3 | extra sitemap.xml; index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| astro-css-bundling-nested-layouts | error |  |  | ENOENT: no such file or directory, open '<work>/fixtures/astro-css-bundling-nested-layouts/src/pages' |
| astro-directives | fail | 3/3 +1 | 1/3 | extra sitemap.xml; define-vars/index.html: `<html data-astro-cid-c1 style="--fg: black;--bg: white;">` vs `<html class="astro-s1" style="--bg: white;--fg: black… |
| astro-doctype | fail | 7/8 +2 | 4/7 | missing styles/global.css; extra sitemap.xml, styles/global.a7718466.css; in-layout-article/index.html: `…eshseet" href="/styles/global.css">` vs `…eshseet" hre… |
| astro-dynamic | **pass** | 3/3 | 3/3 |  |
| astro-env | error |  |  | error: Could not resolve: "astro:env/client". Maybe you need to "bun install"? |
| astro-envs | error |  |  | TypeError: css.includes is not a function. (In 'css.includes("SECRET_PLACE")', 'css.includes' is undefined) |
| astro-expr | **pass** | 8/8 | 8/8 |  |
| astro-external-files | fail | 1/2 +2 | 0/1 | missing external-file.js; extra external-file.8103d20a.js, sitemap.xml; index.html: `<script src="/external-file.js" type="module">` vs `<script src="/external-… |
| astro-fallback | **pass** | 1/1 | 1/1 |  |
| astro-generator | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `…<a href="https://astro.build">Astro v5.16.11</a>` vs `…<a href="https://astro.build">pletivo</a>` |
| astro-global | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../post/*.md")', 'Astro.glob' is undefined) |
| astro-head | fail | 1/1 +1 | 0/1 | extra sitemap.xml; head-own-component/index.html: `<html lang="en" data-astro-cid-c1>` vs `<html lang="en" class="astro-s1">` |
| astro-manifest | error |  |  | error: Cannot find module 'astro:config/client' from '<work>/fixtures/astro-manifest/src/pages/index.astro' |
| astro-markdown | fail | 8/8 | 1/5 | basic/index.html: `<meta charset="utf-8">` vs `<html>`; assets extra basic.md |
| astro-markdown-frontmatter-injection | error |  |  | TypeError: undefined is not an object (evaluating 'data.astro.frontmatter') |
| astro-markdown-plugins | fail | 3/3 | 1/3 | with-gfm/index.html: `<meta charset="utf-8">` vs `<html>` |
| astro-markdown-remarkRehype | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<meta charset="utf-8">` vs `<html>` |
| astro-markdown-url | fail | 2/2 +1 | 0/2 | extra sitemap.xml; docs/pages/how-to-make-a-page/index.html: `<meta charset="utf-8">` vs `<html>` |
| astro-mode | fail | 1/1 | 0/1 | index.html: `<div id="env-title">production</div>` vs `<div id="env-title">development</div>` |
| astro-object-style | fail | 2/2 +1 | 0/2 | extra sitemap.xml; component/index.html: `<!DOCTYPE html>` vs `<span style="background-color:green">` |
| astro-page-directory-url | fail | 3/3 +1 | 2/3 | extra sitemap.xml; nested-md/index.html: `<meta charset="utf-8">` vs `<html>` |
| astro-pagination-root-spread | fail | 4/4 +1 | 0/4 | extra sitemap.xml; 2/index.html: `<!DOCTYPE html>` vs `<a id="prev" href="/">Back</a>` |
| astro-partial-html | fail | 4/4 | 2/4 | jsx/index.html: `<style>` vs `<end>` |
| astro-public | fail | 1/4 +4 | 0/1 | missing example.css, example.js, images/twitter.png; extra example.d41d8cd9.css, example.d41d8cd9.js, images/twitter.c0a1259a.png (+1); index.html: `<link href=… |
| astro-response | fail | 1/1 +1 | 0/1 | extra sitemap.xml; not-found-custom/index.html: `<!DOCTYPE html>` vs `<div>Custom 404</div>` |
| astro-scripts | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("/src/components/Glob/*")', 'Astro.glob' is undefined) |
| astro-slot-with-client | fail | 1/1 | 0/1 | index.html: `<script>(()=>{var e=async t=>{await(await t())()};(self.Astro\|\|(self.Astro={})).` vs `<section>` |
| astro-slots-nested | **pass** | 3/3 | 3/3 |  |
| before-hydration | **pass** | 1/1 | 1/1 |  |
| build-readonly-file | fail | 2/2 +1 | 0/1 | extra sitemap.xml; index.html: `<!DOCTYPE html>` vs `<script type="module">console.log("test");</script>` |
| code-component | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| config-vite | **pass** | 1/1 | 1/1 |  |
| config-vite-css-target | **pass** | 1/1 | 1/1 |  |
| content | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| content with spaces in folder name | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<html lang="en" data-astro-cid-c1>` vs `<html lang="en" class="astro-s1">` |
| content-collections | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| content-collections-base | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| content-collections-empty-dir | error |  |  | error: Collection "blogs" not found. Define it in src/content.config.ts or src/content/config.ts |
| content-collections-mutation | fail | 2/2 | 1/2 | another_page/index.html: `<h2>Third Blog</h2>` vs `<h2>Second Blog</h2>` |
| content-collections-same-contents | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| content-layer | error |  |  | SyntaxError: Export named 'file' not found in module 'astro/loaders'. |
| content-layer-remark-plugins | fail | 5/5 | 1/4 | empty-content/index.html: `…"frontmatter-custom-property">Generated property via remark plugin!</div>` vs `…"frontmatter-custom-property">` |
| content-layer-rendering | error |  |  | TypeError: The "paths[1]" property must be of type string, got object |
| content-static-paths-integration | **pass** | 4/4 | 4/4 |  |
| core-image-base | fail | 9/9 +1 | 1/9 | extra sitemap.xml; alias/index.html: `<!DOCTYPE html>` vs `<img src="/[asset]/penguin1~1.jpg" width="207" height="243" alt="A penguin!">`; assets missing pengui… |
| core-image-data-url | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `…MDA6MDCpOdKQAAAAAElFTkSuQmCC" alt="transparent" loading="lazy" decoding="async"` vs `…MDA6MDCpOdKQAAAAAElFTkSuQmCC" width="128"… |
| core-image-fs-config | fail | 2/2 | 1/2 | imported/index.html: `… src="/[asset]/penguin-sibling~1.webp" id="sibling-image" alt="Penguin from sib` vs `… src="/[asset]/penguin-sibling.4a36c476~1.webp" wid… |
| core-image-infersize | error |  |  | SyntaxError: Export named 'inferRemoteSize' not found in module 'astro:assets'. |
| core-image-layout | fail | 6/6 | 0/6 | both/index.html: `<img src="/[asset]/penguin~1.webp" srcset="/[asset]/penguin~2.webp 640w, /[asset` vs `<img src="/[asset]/penguin.839a489d~1.webp" width="2316"… |
| core-image-remark-imgattr | fail | 1/1 | 0/1 | index.html: `<meta charset="utf-8">` vs `<html>`; assets missing penguin2.webp |
| core-image-svg | error |  |  | error: pletivo cannot render <Plus>: it is an image import, which pletivo does not render as a component (Astro renders an imported SVG inline). Use <img src={P… |
| core-image-svg-in-island | fail | 1/1 | 0/1 | index.html: `<astro-island uid="EdJE2" prefix="r1" component-url="/[bundle]/1.js" component-e` vs `<astro-island uid="fU7So" prefix="r1" component-url="/[bundle… |
| core-image-svg-optimized | error |  |  | error: pletivo cannot render <TestIcon>: it is an image import, which pletivo does not render as a component (Astro renders an imported SVG inline). Use <img sr… |
| core-image-unconventional-settings | error |  |  | error: Unsupported image format: <work>/fixtures/core-image-unconventional-settings/src/assets/light_walrus.avif |
| csp | error |  |  | TypeError: undefined is not an object (evaluating 'Astro.csp.insertStyleResource') |
| csp-fonts | error |  |  | SyntaxError: Export named 'Font' not found in module 'astro:assets'. |
| css-assets | fail | 2/2 +1 | 0/2 | extra sitemap.xml; one/index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| css-dangling-references | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("./*.svelte")', 'import.meta.glob' is undefined) |
| css-double-bundle | fail | 1/1 | 0/1 | index.html: `<script type="module" src="/[bundle]/1.js">` vs `</body>` |
| css-import-as-inline | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<p id="inline">body{background:tomato}</p>` vs `<p id="inline">[object Object]</p>` |
| css-inline-stylesheets | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| css-inline-stylesheets-2 | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| css-inline-stylesheets-3 | error |  |  | SyntaxError: Export named 'getEntryBySlug' not found in module 'astro:content'. |
| css-no-code-split | **pass** | 1/1 | 1/1 |  |
| css-order | **pass** | 3/3 | 3/3 |  |
| css-order-dynamic-import | fail | 2/2 +1 | 0/2 | extra sitemap.xml; one/index.html: `body{background:#deb887}` vs `body{background:#ff0}` |
| css-order-import | fail | 3/3 | 0/3 | component/index.html: `.client-1{background:red!important}` vs `.astro-jsx{color:red}` |
| css-order-layout | **pass** | 3/3 | 3/3 |  |
| css-order-transparent | **pass** | 1/1 | 1/1 |  |
| custom-404-html | fail | 1/2 | 1/2 | missing 404.html |
| custom-404-locals | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-1 | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-2 | **pass** | 1/1 | 1/1 |  |
| custom-404-loop-case-3 | **pass** | 2/2 | 2/2 |  |
| custom-404-loop-case-4 | fail | 1/1 +1 | 1/1 | extra 404.html |
| custom-404-md | fail | 1/2 +1 | 1/2 | missing 404.html; extra 404/index.html |
| data-collections | error |  |  | SyntaxError: Export named 'getDataEntryById' not found in module 'astro:content'. |
| data-collections-schema | error |  |  | SyntaxError: Export named 'getDataEntryById' not found in module 'astro:content'. |
| debug-component | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../../data/posts/*.md")', 'Astro.glob' is undefined) |
| dynamic-route-build-file | fail | 3/3 +1 | 3/3 | extra sitemap.xml |
| dynamic-route-collision | fail | 9/9 +1 | 2/9 | extra sitemap.xml; about/index.html: `<title>Static About Page</title>` vs `<title>Dynamic About</title>` |
| entry-file-names | fail | 1/3 | 0/1 | missing assets/js/Hello.js, assets/js/client.js; index.html: `…d uid="7Hdzi" component-url="/assets/js/Hello.js" component-export="default" re` vs `…d uid="7Hdz… |
| extension-matching | **pass** | 1/1 | 1/1 |  |
| fetch | **pass** | 1/1 | 1/1 |  |
| fonts | error |  |  | SyntaxError: Export named 'Font' not found in module 'astro:assets'. |
| fontsource-package | fail | 1/1 +14 | 0/1 | extra assets/monofett-latin-400-normal.7c6d572a.woff, assets/monofett-latin-400-normal.e9b88a97.woff2, assets/monofett-latin-ext-400-normal.3d7158b6.woff2 (+11)… |
| get-static-paths-pages | fail | 5/5 +1 | 2/5 | extra sitemap.xml; archive/news/july-2024/2/index.html: `<p id="slug">news</p>` vs `<p id="slug">news/july-2024</p>` |
| glob-pages-css | error |  |  | TypeError: Astro.glob is not a function. (In 'Astro.glob("../pages/**/*.astro")', 'Astro.glob' is undefined) |
| head-injection | fail | 6/6 +1 | 0/6 | extra sitemap.xml; index.html: `<html lang="en" class="dark" data-astro-cid-c1>` vs `<html lang="en" class="dark astro-s1">` |
| hoisted-imports | fail | 8/8 | 2/8 | all/index.html: `<end>` vs `<style>` |
| html-component | error |  |  | error: pletivo cannot render <Test>: a component must be a function, an .astro component or an element name, not a value of type object. |
| html-escape | error |  |  | error: pletivo cannot render <Test>: a component must be a function, an .astro component or an element name, not a value of type object. |
| html-escape-complex | fail | 0/1 +1 | 0/1 | missing index.html; extra sitemap.xml |
| html-page | fail | 0/1 +1 | 0/1 | missing index.html; extra sitemap.xml |
| html-slots | error |  |  | error: pletivo cannot render <Named>: a component must be a function, an .astro component or an element name, not a value of type object. |
| hydration-race | **pass** | 2/2 | 2/2 |  |
| i18n-double-prefix | **pass** | 3/3 | 3/3 |  |
| i18n-locale-index-format-file | fail | 0/3 +3 | 0/3 | missing en-us.html, es-mx.html, fr-fr.html; extra en-us/index.html, es-mx/index.html, fr-fr/index.html |
| i18n-routing | fail | 18/18 | 17/18 | virtual-module/index.html: `…doesn't break About: /pt/about/ About spanish: /spanish/about/ Spain path: span` vs `…doesn't break About: /pt/about About spanish:… |
| i18n-routing-base | fail | 13/13 +4 | 12/13 | extra blog/1/index.html, blog/2/index.html, blog/3/index.html (+1); index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| i18n-routing-dynamic | fail | 2/3 | 0/3 | missing index.html; en/index.html: `<div>en</div>` vs `<div>` |
| i18n-routing-fallback | fail | 15/18 +3 | 10/18 | missing it/blog/1/index.html, it/blog/2/index.html, it/blog/3/index.html; extra it/1/index.html, it/2/index.html, it/3/index.html; it/end/index.html: `<!doctype… |
| i18n-routing-fallback-index | fail | 3/3 | 2/3 | it/index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| i18n-routing-fallback-rewrite-filename | **pass** | 18/18 | 18/18 |  |
| i18n-routing-manual | fail | 13/13 +1 | 12/13 | extra 404.html; index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| i18n-routing-manual-with-default-middleware | fail | 16/16 +3 | 13/16 | extra it/about/index.html, it/blog/index.html, it/index.html; about/index.html: `ABOUT ME` vs `<!DOCTYPE html>` |
| i18n-routing-prefix-always | fail | 16/17 +5 | 14/16 | missing 500.html; extra 500/index.html, blog/1/index.html, blog/2/index.html (+2); index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| i18n-routing-prefix-other-locales | **pass** | 13/13 | 13/13 |  |
| i18n-routing-redirect-preferred-language | **pass** | 11/11 | 11/11 |  |
| import-ts-with-js | **pass** | 1/1 | 1/1 |  |
| impostor-mdx-file | **pass** | 1/1 | 1/1 |  |
| integration-add-page-extension | fail | 0/1 | 0/1 | missing test/index.html |
| integration-server-setup | error |  |  | ENOENT: no such file or directory, open '<work>/fixtures/integration-server-setup/src/pages' |
| jsx | **pass** | 2/2 | 2/2 |  |
| large-array | **pass** | 1/1 | 1/1 |  |
| lazy-layout | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| legacy-content-collections | error |  |  | error: Collection "with-scripts" not found. Define it in src/content.config.ts or src/content/config.ts |
| legacy-data-collections | error |  |  | SyntaxError: Export named 'getDataEntryById' not found in module 'astro:content'. |
| markdown | fail | 4/9 | 0/9 | missing dot-markdown-page/index.html, dot-mdown-page/index.html, dot-mdwn-page/index.html (+2); entities/index.html: `<meta charset="utf-8">` vs `<html>`; asset… |
| middleware-no-user-middleware | fail | 1/4 | 1/4 | missing post/index.html, pre/index.html, url/index.html |
| middleware-sequence-request-clone | **pass** | 1/1 | 1/1 |  |
| middleware-sequence-rewrite | fail | 2/2 | 1/2 | index.html: `<h1>Hello Another</h1>` vs `<h1>Hello Sequence</h1>` |
| middleware-ssg | fail | 2/2 | 0/2 | index.html: `<p>bar</p>` vs `<p>` |
| middleware-tailwind | fail | 1/1 | 0/1 | index.html: `@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inli` vs `p[data-astro-cid-c1]{color:red}` |
| middleware-virtual | **pass** | 1/1 | 1/1 |  |
| minification-html | **pass** | 3/3 | 3/3 |  |
| page-format | fail | 6/6 +1 | 4/6 | extra sitemap.xml; en/nested/page/index.html: `<!DOCTYPE html>` vs `<a id="another" href="/en/nested/page/another/">` |
| page-level-styles | fail | 2/2 +1 | 1/2 | extra sitemap.xml; index.html: `<end>` vs `<style>` |
| partials | **pass** | 3/3 | 3/3 |  |
| passthrough-image-service | fail | 1/1 | 0/1 | index.html: `<img src="/[asset]/penguin1~1.jpg" alt="a penguin" loading="lazy" decoding="asyn` vs `<img src="/[asset]/penguin1.4a36c476~1.webp" width="207" heig… |
| postcss | error |  |  | SyntaxError: Export named 'h' not found in module '<work>/node_modules/solid-js/dist/server.js'. |
| preact-component | error |  |  | error: pletivo cannot render Preact components: <FragComponent> returned a Preact element (<k>). Astro renders these through the renderer of the framework's int… |
| prerender-conflict-dynamic-dynamic | fail | 5/5 | 4/5 | c/index.html: `<!DOCTYPE html>Bar: c` vs `<!DOCTYPE html>Foo: c` |
| prerender-conflict-static-dynamic | fail | 1/1 | 0/1 | c/index.html: `<!DOCTYPE html>Static C page` vs `<!DOCTYPE html>Foo: c` |
| public-base-404 | fail | 2/3 +2 | 1/2 | missing twitter.png; extra sitemap.xml, twitter.c0a1259a.png; index.html: `<img src="/twitter.png">` vs `<img src="/twitter.c0a1259a.png">` |
| react-and-solid | **pass** | 1/1 | 1/1 |  |
| react-jsx-export | **pass** | 1/1 | 1/1 |  |
| redirects | fail | 9/9 | 6/9 | late/index.html: `<h1>Testing</h1>` vs `<h1>Testing</h1>[object Response]</body>` |
| redirects-i18n | fail | 0/2 | 0/2 | missing index.html, mytest/index.html |
| reexport-astro-containing-client-component | **pass** | 1/1 | 1/1 |  |
| remote-css | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| reroute | fail | 13/14 | 3/14 | missing auth/astro-params/index.html; auth/1234/index.html: `<p id="locals">Locals: Params changed</p>` vs `<p id="locals">Locals:</p>` |
| reuse-injected-entrypoint | fail | 1/9 +4 | 1/9 | missing dynamic-a/id-1/index.html, dynamic-a/id-2/index.html, dynamic-b/id-1/index.html (+5); extra dynamic-a/[id], dynamic-b/[id], injected-a (+1) |
| rewrite-custom-404 | fail | 3/4 +1 | 0/4 | missing 500.html; extra 500/index.html; 404.html: `<p>Interjected</p>` vs `<p>` |
| rewrite-dynamic-routing | fail | 6/6 | 5/6 | bar/index.html: `<!doctype html>` vs `<!DOCTYPE html>` |
| rewrite-i18n-manual-routing | **pass** | 1/1 | 1/1 |  |
| rewrite-trailing-slash-never | error |  |  | error: Astro.rewrite("/base") matched no route. |
| rewrite-with-base | error |  |  | error: Astro.rewrite("/base/") matched no route. |
| root-srcdir-css | error |  |  | astro.config sets srcDir ".", but pletivo reads sources from "src". Set srcDir: "." in pletivo.config as well. |
| routing-priority | fail | 14/21 +5 | 13/18 | missing _injected/index.html, api/catch/a-b.json, api/catch/a.json (+4); extra [id], _injected, api/catch/[...slug].json (+2); de/index.html: `<h1>de/index.astr… |
| scoped-style-strategy | fail | 1/1 +1 | 0/1 | extra sitemap.xml; index.html: `<html data-astro-cid-c1>` vs `<html class="astro-s1">` |
| set-html | fail | 4/4 +1 | 3/4 | extra sitemap.xml; index.html: `<div id="response">` vs `<div id="response">[object Response]</div>` |
| slots-preact | fail | 2/2 | 1/2 | mdx/index.html: `<astro-island uid="ZlAqok" component-url="/[bundle]/1.js" component-export="defa` vs `<astro-island uid="Z1JrU1X" component-url="/[bundle]/1.js… |
| slots-react | fail | 3/3 | 1/3 | index.html: `…-island uid="HmxFp" prefix="r10" component-url="/[bundle]/1.js" component-expor` vs `…-island uid="HmxFp" prefix="r13" component-url="/[bundle]/1.… |
| slots-solid | fail | 2/2 | 0/2 | index.html: `<astro-island uid="Z13sF6B" data-solid-render-id="s2" component-url="/[bundle]/1` vs `<astro-island uid="Z1Q7Ya8" data-solid-render-id="s5" compone… |
| slots-svelte | fail | 2/2 | 0/2 | index.html: `.counter.svelte-ziooqw{display:grid;font-size:2em;grid-template-columns:repeat(3` vs `astro-island,astro-slot,astro-static-slot{display:contents}` |
| slots-vue | error |  |  | error: pletivo cannot render an unnamed component: a component must be a function, an .astro component or an element name, not a value of type object. |
| sourcemap | **pass** | 1/1 | 1/1 |  |
| special-chars-in-component-imports | fail | 2/2 | 1/2 | mdx/index.html: `…&quot;name&quot;:&quot;Counter$4&quot;,&quot;value&quot;:true}" await-children>` vs `…&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:t… |
| ssr-assets | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| ssr-env | **pass** | 1/1 | 1/1 |  |
| ssr-markdown | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| ssr-params | fail | 7/7 +1 | 7/7 | extra sitemap.xml |
| ssr-prerender-chunks | fail | 1/16 | 1/1 | missing _worker.js/_@astrojs-ssr-adapter.mjs, _worker.js/_noop-middleware.mjs, _worker.js/chunks/_@astro-renderers_M9Bh76Zv.mjs (+12) |
| ssr-request | fail | 2/2 | 0/1 | request/index.html: `…-astro-cid-c1>http://localhost:4321</p>` vs `…-astro-cid-c1>http://localhost</p>` |
| ssr-response | fail | 6/6 +1 | 4/6 | extra sitemap.xml; another/index.html: `<h1>Hello http://localhost:4321/another/</h1>` vs `<h1>Hello http://localhost/another/</h1>` |
| ssr-script | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| ssr-scripts | **pass** | 1/1 | 1/1 |  |
| static-build | error |  |  | TypeError: import.meta.glob is not a function. (In 'import.meta.glob("./posts/**/*.md")', 'import.meta.glob' is undefined) |
| static-build-code-component | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| static-build-dir | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| static-build-page-url-format | fail | 0/2 +2 | 0/2 | missing one.html, sub/page.html; extra one/index.html, sub/page/index.html |
| static-redirect | fail | 1/2 | 1/2 | missing configured-redirect/index.html |
| svelte-component | error |  |  | error: pletivo cannot render <work>/fixtures/svelte-component/src/components/Custom.sve as a component: pletivo has no module loader for .sve files, so the impo… |
| tailwindcss | fail | 2/2 | 0/2 | index.html: `@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inli` vs `@layer properties:` |
| type-imports | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| unused-slot | fail | 1/1 +1 | 1/1 | extra sitemap.xml |
| view-transitions | fail | 4/4 | 0/4 | hasIsland/index.html: `…on){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*` vs `…on){::view-transition-group(*){animation:none!impo… |
| virtual-astro-file | error |  |  | error: Cannot find module '@my-plugin/virtual.astro' from '<work>/fixtures/virtual-astro-file/src/pages/index.astro' |
| vue-component | fail | 2/2 | 0/1 | index.html: `<my-button>Click Me</my-button>` vs `<!---->` |
| vue-jsx | error |  |  | error: pletivo cannot render <Counter>: a component must be a function, an .astro component or an element name, not a value of type object. |
| vue-with-multi-renderer | **pass** | 1/1 | 1/1 |  |
| with-subpath-no-trailing-slash | **pass** | 3/3 | 3/3 |  |
