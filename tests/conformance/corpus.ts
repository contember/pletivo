/**
 * The conformance corpus: real projects from this repo, picked to cover the
 * rendering surface rather than to maximise page count.
 *
 * Tiers:
 *  - `fast` runs on every `bun test`. Every entry is small and its output is
 *    fully reproducible from a clean checkout.
 *  - `full` is opt-in via `CONFORMANCE_FULL=1`. It holds the two benchmark
 *    examples, whose generated content trees under `src/content` are
 *    gitignored: they exist on a machine that ran `scripts/benchmark.sh`,
 *    so those projects build ~1500 (pletivo) / ~6000 (astro) extra pages
 *    locally and none in CI. Their entries snapshot only the routes that do not
 *    read a collection, which is why they carry an explicit `routes` list.
 */
import path from "path";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import type { CaseNormalizeOptions } from "./normalize";

export const repoRoot = path.resolve(import.meta.dir, "../..");

export interface CorpusEntry {
  /** Stable id. Also the snapshot filename, so renaming an entry orphans one. */
  id: string;
  /** Project root, relative to the repo. */
  root: string;
  /** What this entry exists to lock down. */
  covers: string[];
  tier: "fast" | "full";
  /**
   * Output paths to snapshot. Omit to snapshot every text output the render
   * produced plus the full emitted-file manifest — the strict default. Set it
   * only when part of the output is not reproducible (see the tier note above);
   * the manifest is then dropped too, since it would list the same unstable set.
   */
  routes?: string[];
  /**
   * Routes whose *content* is not snapshotted. They still have to be emitted —
   * they stay in the manifest — only their bytes are skipped. Reserved for
   * output that is genuinely not reproducible across machines; every use needs
   * a comment saying why.
   */
  excludeRoutes?: string[];
  /** Case-scoped normalizations on top of the always-on ones. */
  normalize?: CaseNormalizeOptions;
  /** Overrides merged over `defaultConfig`. */
  config?: Partial<PletivoConfig>;
}

/**
 * The same config every integration test uses. `astro.config.*` in a project
 * still overrides `base` / `site` / `i18n` on top of this.
 */
export const defaultConfig: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  host: "localhost",
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

export const corpus: CorpusEntry[] = [
  {
    id: "tsx-pages",
    root: "tests/fixture",
    tier: "fast",
    covers: [
      "TSX pages, layouts, dynamic `[slug]` routes via getStaticPaths",
      "islands: client:load with SSR content, client:only with an empty wrapper",
      "inline hydration script injected only on pages that have an island",
      "markdown content collection + entry.render()",
      "literal <style> blocks in TSX hoisted into <head>, not leaked cross-page",
      "public asset content hashing and href rewriting",
      "404.html and sitemap.xml emission",
    ],
  },
  {
    id: "astro-scoped-styles",
    root: "tests/fixture-astro-styles",
    tier: "fast",
    // Hard for a second runtime: scope-class ↔ stylesheet correspondence, and
    // the class-presence gating that decides which component CSS lands where.
    covers: [
      ".astro scoped CSS with :where(.astro-XXXX) selectors",
      "scope classes on elements, including on <html>/<body> from a layout",
      "<style is:global> from a component that renders no DOM",
      ":global() inside a scoped block",
      "CSS injected into a page that has no <head>",
      "no cross-page leakage of scoped or global CSS",
    ],
    // See CaseNormalizeOptions.sortStyleBlocks — emission order flips between
    // builds on this fixture.
    normalize: { sortStyleBlocks: true },
  },
  {
    id: "astro-hoisted-scripts",
    root: "tests/fixture-astro-scripts",
    tier: "fast",
    // Hard for a second runtime: hoisted scripts need a bundler pass, which a
    // request-time runtime has to do somewhere other than in the request.
    covers: [
      "hoisted <script> bundled to _astro/hoisted-<hash>.js and referenced by src",
      "TypeScript stripped from hoisted scripts",
      "integration injectScript('page') and injectScript('head-inline') placement",
    ],
  },
  {
    id: "astro-hoisted-imports",
    root: "tests/fixture-astro-hoisted-imports",
    tier: "fast",
    covers: [
      "hoisted <script> that imports a local module",
      "CSS imported from .astro frontmatter, emitted as a hashed bundle",
    ],
  },
  {
    id: "base-path",
    root: "tests/fixture-base-path",
    tier: "fast",
    covers: [
      "astro.config base: '/sub-app' prefixed onto emitted asset URLs",
      "filesystem output paths staying un-prefixed",
    ],
  },
  {
    id: "i18n",
    root: "tests/fixture-i18n",
    tier: "fast",
    covers: [
      "default locale at root, locale subdirectories, aliased locale path",
      "astro:i18n virtual module and Astro.currentLocale",
      "hreflang link generation",
    ],
  },
  {
    id: "i18n-fallback",
    root: "tests/fixture-i18n-fallback",
    tier: "fast",
    covers: ["locale fallback emission for routes missing in a locale"],
  },
  {
    id: "i18n-prefix-always",
    root: "tests/fixture-i18n-prefix-always",
    tier: "fast",
    covers: ["prefixDefaultLocale routing, including the generated root redirect"],
  },
  {
    id: "endpoints",
    root: "tests/fixture-endpoint-routes",
    tier: "fast",
    covers: [
      "endpoint routes in src/pages: .json.ts, .xml.ts, .txt.ts",
      "endpoint output emitted at its own path, not wrapped in HTML",
    ],
  },
  {
    id: "inject-route",
    root: "tests/fixture-inject-route",
    tier: "fast",
    covers: [
      "integration injectRoute() for endpoints outside src/pages",
      "site URL reaching an injected route's context",
    ],
  },
  {
    id: "images",
    root: "tests/fixture-image",
    tier: "fast",
    covers: [
      "ESM image imports resolving to {src,width,height,format}",
      "images emitted into _astro/ with a content hash",
      "case-preserving extensions (.JPG)",
    ],
  },
  {
    id: "vite-virtual-module",
    root: "tests/fixture-vite-virtual-module",
    tier: "fast",
    covers: ["a vite plugin's virtual module resolved and rendered from .astro"],
  },
  {
    id: "custom-404-astro",
    root: "tests/fixture-404-astro",
    tier: "fast",
    covers: ["404.astro rendered to 404.html and kept out of the sitemap"],
  },
  {
    id: "content-formats",
    root: "tests/conformance/fixtures/content-formats",
    tier: "fast",
    // Owned by the harness: no existing fixture routes .mdx or renders a YAML
    // data collection through a page, and the ones that load YAML build their
    // content.config.ts at test time so they cannot be built standalone.
    covers: [
      ".mdx page route with frontmatter and a layout",
      ".md and .mdx entries in one collection, rendered through entry.render()",
      "YAML data collection with anchors, folded and literal scalars, flow style",
      "GFM tables and autolinks in markdown output",
    ],
  },
  {
    id: "astro-native-example",
    root: "examples/basic-astro-native",
    tier: "fast",
    covers: ["the .astro example project built by pletivo end to end"],
  },
  {
    id: "example-basic",
    root: "examples/basic",
    tier: "full",
    // Collection-backed routes are excluded: with benchmark content present
    // they enumerate ~500 generated posts, and every post page computes
    // `related` across the whole collection.
    routes: ["index.html", "about/index.html", "404.html"],
    covers: [
      "the pletivo-native example project: layout, island, public stylesheet",
    ],
  },
  {
    id: "example-basic-astro",
    root: "examples/basic-astro",
    tier: "full",
    routes: ["index.html", "about/index.html", "404.html"],
    covers: [
      "the astro example project built by pletivo rather than by astro",
    ],
  },
];

export function selectCorpus(env: Record<string, string | undefined> = process.env): CorpusEntry[] {
  const wanted = env.CONFORMANCE_CASE?.split(",").map((s) => s.trim()).filter(Boolean);
  const full = env.CONFORMANCE_FULL === "1";
  return corpus.filter((entry) => {
    if (wanted?.length) return wanted.includes(entry.id);
    return full || entry.tier === "fast";
  });
}
