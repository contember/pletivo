import { describe, expect, test } from "bun:test";
import path from "node:path";
import { tailwindDir } from "./tailwind-sources.ts";

/**
 * The only assertion in this suite that compares the two hosts' actual bytes.
 *
 * Everything else here checks the Workers host against what it is *believed* the Bun
 * host does; this runs `pletivo build` for real and diffs the HTML and the generated
 * stylesheet against it. `local-parity.ts` does the work — in a subprocess, because a
 * build registers process-global Bun plugins and because the Astro compiler owns one
 * `globalThis` slot per process, which this file has already taken.
 *
 * `test/parity.ts` is the same comparison against a real workerd, and has to stay a
 * manual run: it needs `wrangler dev` listening.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** Tailwind's own sources are read off disk here, and the Bun host needs oxide too. */
const HAS_TAILWIND = tailwindDir() !== null && canResolve("@tailwindcss/oxide");

function canResolve(specifier: string): boolean {
  try {
    Bun.resolveSync(specifier, import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

async function localParity(fixture: string): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(
    ["bun", path.join(import.meta.dir, "local-parity.ts"), fixture],
    { cwd: REPO_ROOT, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, output: stdout + stderr };
}

describe("byte parity with pletivo build", () => {
  test(
    "the dynamic-route fixture renders every path the build emitted",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-dynamic-routes");
      // One static page, three getStaticPaths slugs, two paginate() pages and two
      // .tsx slugs — every one of them byte-for-byte against `pletivo build`.
      expect(output).toContain("8/8 byte-identical");
      // And the enumeration half agrees with the build's own page list.
      expect(output).toContain("= 8 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the content fixture renders every collection-backed path the build emitted",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-content");
      // A listing page, two `getStaticPaths` slugs off a markdown collection (one of
      // them nested), and two off a JSON one — the markdown rendered by
      // `entry.render()`, the ids resolved through `reference()`.
      expect(output).toContain("5/5 byte-identical");
      // The draft post is loaded and filtered out on both hosts, so the enumeration
      // agreeing is also the schema default agreeing.
      expect(output).toContain("= 5 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the page-scripts fixture carries the build's bundled injectScript('page') module",
    async () => {
      const { ok, output } = await localParity("tests/fixture-astro-page-scripts");
      // The Workers host emits `scripts.page` from the artifact; `prepare` froze the
      // module the build inlines (`tests/integration/astro-page-scripts.test.ts`).
      expect(output).toContain("2/2 byte-identical");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the Markdown-layout fixture renders each .md page inside its layout the same way",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-md-layout");
      // Pages inside a layout named relatively, from the project root and as a package (it
      // reaches the isolate only if prepare vendors it), with its scoped style and its
      // component's; an .astro page importing a non-route .md whose layout is another
      // package component; and one page with no layout. An imported stylesheet and a
      // hoisted script are delivered differently by design (docs/todos/016).
      expect(output).toContain("5/5 byte-identical");
      expect(output).toContain("= 5 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the vendor fixture renders a page whose components come from npm",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-vendor");
      // One page, and everything on it arrived through the artifact: a bare specifier
      // resolved to a package's `.astro`, that component's scoped CSS, a frozen
      // `virtual:` module, a bundled JS entry, `site` from the frozen config and an
      // `injectScript('head-inline')` body — all byte-for-byte against `pletivo build`.
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the outside-root fixture scopes a component above the site root the same way",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-outside-root/site");
      // The site is `site/`; its one component sits in a `node_modules` above it, as a
      // workspace hoists it. Its scoped style's id is hashed from a `../` path on both hosts.
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the image fixture names every file the same way, and serves what it names",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-images");
      // Two pages: one whose images are ESM imports, one whose images come out of an
      // `image()` collection schema by way of the content binding.
      expect(output).toContain("2/2 byte-identical");
      // And each URL those pages emit resolves to the same bytes `pletivo build`
      // wrote under `_astro/` — a URL that 404s is worse than no image.
      expect(output).toContain("= /_astro/hero.");
      expect(output).toContain("= /_astro/badge.");
      expect(output).toContain("= /_astro/thumb.");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the multi-renderer fixture renders each framework's islands as the build does",
    async () => {
      const { ok, output } = await localParity("tests/fixture-astro-renderers-multi");
      // Preact, Solid, React, Svelte and Vue islands on one page, through the server bundle
      // `prepare` built: the markup, Astro's island scripts and every component-url,
      // renderer-url and uid, byte-for-byte against `pletivo build`.
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      // And the islands hydrate from this host: each component-url and renderer-url, and the
      // chunks they import, served as JavaScript with the bytes `pletivo build` wrote. Prepare
      // bundled the components the `.astro` sources hydrate, the build those it rendered.
      expect(output).toContain("= 18 island module(s) served as JavaScript, every import among them");
      expect(output).toContain("= 18/18 island module(s) byte-identical to pletivo build");
      expect(ok).toBe(true);
    },
    180_000,
  );

  test(
    "the MDX example compiles its page in the MDX isolate and renders it as the build does",
    async () => {
      const { ok, output } = await localParity("tests/fixture-astro-mdx-example");
      // Astro's with-mdx: ESM exports and expressions, a `components` export mapping `h1` to a
      // scoped `.astro` component (its style inlined, compared through inlined-style.ts), and a
      // Preact island hydrated from MDX, its component-url and uid rewritten as the build names them.
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      expect(output).toContain("= 5 island module(s) served as JavaScript, every import among them");
      expect(output).toContain("= 5/5 island module(s) byte-identical to pletivo build");
      expect(ok).toBe(true);
    },
    180_000,
  );

  test(
    "the mdx() options fixture runs the integration's plugins, gfm and extendMarkdownConfig in the isolate",
    async () => {
      const { ok, output } = await localParity("tests/fixture-astro-mdx-plugins");
      // The build renders `<h1 id="plugins">Plugins!</h1>` and `<p class="marked">Some ~~struck~~ text.!</p>`:
      // a remark and a rehype plugin from `mdx({...})`, GFM off, Astro's `markdown` plugins dropped.
      // The child prepares first and the build reuses its config, so a prepare that lost the options
      // would lose them on both sides: the size is what shows they arrived (52 B without them).
      expect(output).toContain("Built 1 pages (112 B total)");
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test(
    "the outside-srcDir MDX fixture renders an .mdx only a page import reaches, and its island",
    async () => {
      const { ok, output } = await localParity("tests/fixture-astro-mdx-outside");
      // `docs/Outside.mdx` is the project's only `.mdx` file and hydrates a Preact island:
      // prepare must freeze the MDX pipeline and build the island's client from it.
      expect(output).toContain("1/1 byte-identical");
      expect(output).toContain("= 1 enumerated path(s)");
      expect(output).toContain("= 5/5 island module(s) byte-identical to pletivo build");
      expect(ok).toBe(true);
    },
    180_000,
  );

  const singleRenderers: { renderer: string; pages: number; urlTarget?: string }[] = [
    { renderer: "react", pages: 1 },
    { renderer: "solid", pages: 1 },
    // The component's `url(./bg.svg)`, over the 4 kB inline limit: the file the build wrote,
    // under the name it wrote it, byte for byte.
    { renderer: "svelte", pages: 1, urlTarget: "/assets/bg.2ea6e94c.svg (4904 B)" },
    { renderer: "vue", pages: 2, urlTarget: "/assets/bg.2ea6e94c.svg (4904 B)" },
    // Not preact: its endpoint imports astro/container, which reaches node:path and prepare refuses.
  ];
  for (const { renderer, pages, urlTarget } of singleRenderers) {
    test(
      `the ${renderer} fixture renders its islands and inlined CSS as the build does`,
      async () => {
        const { ok, output } = await localParity(`tests/fixture-astro-renderers-${renderer}`);
        // The build inlines the component CSS minified, this host as written: both minified, then every
        // byte of the page compared (inlined-style.ts).
        expect(output).toContain(`${pages}/${pages} byte-identical`);
        expect(output).toContain(`= ${pages} enumerated path(s)`);
        expect(output).toContain("= 3 island module(s) served as JavaScript, every import among them");
        expect(output).toContain("= 3/3 island module(s) byte-identical to pletivo build");
        if (urlTarget !== undefined) {
          expect(output).toContain(`= ${urlTarget}`);
          expect(output).not.toContain("! /assets/");
        }
        expect(ok).toBe(true);
      },
      180_000,
    );
  }

  // Astro's framework examples as written: each page has a component stylesheet and its own scoped `<style>`,
  // which the build inlines as one block. framework-preact is checked outside the repo (docs/todos/027): here the
  // root tsconfig maps `preact/hooks` to pletivo's SSR stub, which lacks the hooks `preact/compat` imports.
  const frameworkExamples: { example: string; modules: number }[] = [
    { example: "react", modules: 3 },
    { example: "solid", modules: 3 },
    { example: "svelte", modules: 3 },
    { example: "vue", modules: 3 },
    { example: "multiple", modules: 18 },
  ];
  for (const { example, modules } of frameworkExamples) {
    test(
      `Astro's framework-${example} example renders and hydrates as the build does`,
      async () => {
        const { ok, output } = await localParity(`tests/fixture-astro-${example}-example`);
        expect(output).toContain("1/1 byte-identical");
        expect(output).toContain("= 1 enumerated path(s)");
        expect(output).toContain(`= ${modules} island module(s) served as JavaScript, every import among them`);
        expect(output).toContain(`= ${modules}/${modules} island module(s) byte-identical to pletivo build`);
        expect(ok).toBe(true);
      },
      180_000,
    );
  }

  // Each page has a stylesheet and its own scoped `<style>`; the two share one block only where the build inlines the sheet.
  const stylesheetDelivery: { fixture: string; delivery: string }[] = [
    // `auto`, a sheet over Vite's 4096 B: the build links it.
    { fixture: "stylesheet-linked", delivery: "1 with the CSS delivery excepted" },
    // `never`, a small sheet: linked too.
    { fixture: "stylesheet-never", delivery: "1 with the CSS delivery excepted" },
    // `always`, the same sheet as the linked fixture: inlined and merged.
    { fixture: "stylesheet-always", delivery: "1 with the inlined <style> compared minified" },
    // `vite.build.assetsInlineLimit: 10000`: the sheet is inlined and its 4904 B `url()` target is a `data:` URI.
    { fixture: "stylesheet-limit", delivery: "1 with the inlined <style> compared minified" },
  ];
  for (const { fixture, delivery } of stylesheetDelivery) {
    test(
      `the ${fixture} fixture delivers its stylesheet and scoped CSS as the build does`,
      async () => {
        const { ok, output } = await localParity(`tests/fixture-astro-${fixture}`);
        expect(output).toContain("1/1 byte-identical");
        expect(output).toContain(delivery);
        expect(ok).toBe(true);
      },
      60_000,
    );
  }

  test(
    "a stylesheet imported before a component comes before that component's, as the import graph orders them",
    async () => {
      // The page imports styles/z.css, then a component that imports styles/a.css: walk order z, a; path order a, z.
      const { ok, output } = await localParity("tests/fixture-astro-css-import-order");
      expect(output).toContain("1/1 byte-identical");
      expect(ok).toBe(true);
    },
    60_000,
  );

  test.skipIf(!HAS_TAILWIND)(
    "the Tailwind fixture agrees on every byte except how the CSS is delivered",
    async () => {
      const { ok, output } = await localParity("packages/workers/test/fixture-tailwind");
      // The two hosts fork here on purpose: `pletivo build` links one stylesheet for
      // the site, this host inlines the page's own (docs/todos/023 §5). One node is
      // removed from each side and the rest of both pages still has to match.
      expect(output).toContain("2/2 byte-identical");
      expect(output).toContain("2 with the CSS delivery excepted");
      // What the removed comparison used to prove, kept: the JS candidate scanner plus
      // Tailwind over a virtual file map still emit the same bytes as the real
      // `@tailwindcss/node` + `@tailwindcss/oxide`, given the same candidates.
      expect(output).toMatch(/= \d{4,} B of Tailwind, byte-identical to pletivo build/);
      // And what it never proved, which the per-page model now needs: every utility
      // class the rendered page applies survives into the CSS that page carries.
      expect(output).toMatch(/= index\.html — \d+ applied class\(es\) covered by \d+ B inline/);
      expect(ok).toBe(true);
    },
    60_000,
  );
});
