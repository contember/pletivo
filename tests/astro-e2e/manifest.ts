export const ASTRO_REPO = "https://github.com/withastro/astro.git";
export const ASTRO_REF = "astro@5.7.13";

export interface FixtureEntry {
  /** Short name used in logs and directory names */
  name: string;
  /**
   * Test file name inside astro's source directory. Set to `null` for
   * fixture-only entries (copy the fixture but write our own test
   * against it — useful when Astro's own test file is tangled with
   * inline config overrides or SSR adapters we don't support).
   */
  testFile: string | null;
  /** Fixture directory name inside astro's fixtures/ */
  fixture: string;
  /** Extra npm deps the fixture code imports (beyond what pletivo provides) */
  extraDeps?: Record<string, string>;
  /** String replacements applied to the copied test file */
  testPatches?: Array<{ search: string; replace: string }>;
  /** Files to remove from the fixture after copying (glob-style paths relative to fixture root) */
  removeFiles?: string[];
}

// ---------------------------------------------------------------------------
// E2E tests — Playwright browser tests (packages/astro/e2e/)
// ---------------------------------------------------------------------------

export const e2eEntries: FixtureEntry[] = [
  {
    name: "css",
    testFile: "css.test.js",
    fixture: "css",
    testPatches: [
      {
        search: "test('removes Astro-injected CSS once Vite-injected CSS loads',",
        replace:
          "test.skip('removes Astro-injected CSS once Vite-injected CSS loads [vite-specific]',",
      },
    ],
  },
  {
    name: "astro-component",
    testFile: "astro-component.test.js",
    fixture: "astro-component",
    testPatches: [
      {
        search: "test('update linked dep Astro html',",
        replace: "test.skip('update linked dep Astro html [vite-specific]',",
      },
      {
        search: "test('update linked dep Astro style',",
        replace: "test.skip('update linked dep Astro style [vite-specific]',",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Integration tests — node:test + cheerio, build output assertions
// Source: packages/astro/test/
// ---------------------------------------------------------------------------

export const integrationEntries: FixtureEntry[] = [
  // i18n fixtures — we copy Astro's actual fixture directories but
  // don't use Astro's own i18n-routing.test.js, because it's heavily
  // tangled with SSR adapter, inline loadFixture({ i18n: ... })
  // overrides, and dev-server behavior tests. Instead,
  // `integration/pletivo-i18n-ssg.test.js` (checked in separately)
  // asserts SSG-side behavior against the copied fixtures.
  {
    name: "i18n-routing",
    testFile: null,
    fixture: "i18n-routing",
    removeFiles: [
      // Server islands need an SSR adapter — pletivo is SSG-only.
      "src/pages/server-island.astro",
      // JS route handlers aren't supported in pletivo.
      "src/pages/test.json.js",
    ],
  },
  {
    name: "i18n-routing-prefix-always",
    testFile: null,
    fixture: "i18n-routing-prefix-always",
    removeFiles: ["src/pages/test.json.js"],
  },
  {
    name: "i18n-routing-fallback",
    testFile: null,
    fixture: "i18n-routing-fallback",
  },
  {
    name: "astro-slots",
    testFile: "astro-slots.test.js",
    fixture: "astro-slots",
  },
  {
    name: "astro-class-list",
    testFile: "astro-class-list.test.js",
    fixture: "astro-class-list",
  },
  {
    name: "astro-basic",
    testFile: "astro-basic.test.js",
    fixture: "astro-basic",
    // Remove pages that use features pletivo doesn't support (md, mdx, file:// URLs,
    // ?raw imports, JS route handlers, preact components)
    removeFiles: [
      "src/pages/fileurl.astro",
      "src/pages/import-queries/_content.astro",
      "src/pages/import-queries/raw.astro",
      "src/pages/get-static-paths-with-mjs/[...file].js",
      "src/pages/news.astro",
      "src/pages/client.astro",
      "src/pages/nested-astro/index.astro",
      "src/pages/nested-md/index.md",
      "src/components/Tour.jsx",
      "src/strings.js",
      "my-config.mjs",
    ],
    testPatches: [
      // Preview server is Astro-specific — skip that entire describe block
      {
        search: "describe('preview',",
        replace: "describe.skip('preview [astro-specific]',",
      },
      // special chars in .md filename
      {
        search: "it('supports special chars in filename',",
        replace: "it.skip('supports special chars in filename [special chars in path]',",
      },
      // .mjs output pages use Astro's getStaticPaths JS route handler
      {
        search: "it('Generates pages that end with .mjs',",
        replace: "it.skip('Generates pages that end with .mjs [astro-specific]',",
      },
      // file:// URL imports use Vite resolution
      {
        search: "it('allows file:// urls as module specifiers',",
        replace: "it.skip('allows file:// urls as module specifiers [vite-specific]',",
      },
      // ?raw imports use Vite query handling
      {
        search: "it('Handles importing .astro?raw correctly',",
        replace: "it.skip('Handles importing .astro?raw correctly [vite-specific]',",
      },
      // special chars in filename is a .md page
      {
        search: "it('supports special chars in filename',",
        replace: "it.skip('supports special chars in filename [requires md]',",
      },
      // sourcemaps check is build-tooling-specific
      {
        search: "it('server sourcemaps not included in output',",
        replace: "it.skip('server sourcemaps not included in output [astro-specific]',",
      },
      // Dev section uses Astro dev server
      {
        search: "describe('Astro basic development',",
        replace: "describe.skip('Astro basic development [astro dev server]',",
      },
    ],
  },
];
