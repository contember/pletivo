import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { load as cheerioLoad } from 'cheerio';
import { loadFixture } from './test-utils.js';

let fixture;

describe('TSX Pages', () => {
  before(async () => {
    fixture = await loadFixture({
      root: new URL('./fixtures/tsx-pages-basic/', import.meta.url),
    });
  });

  describe('build', () => {
    before(async () => {
      await fixture.build();
    });

    it('Can render index.tsx as a page', async () => {
      const html = await fixture.readFile('/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Welcome to TSX Pages');
      assert.equal($('title').text(), 'TSX Pages - Home');
      assert.ok($('p').text().includes('This page is rendered from a TSX file'));
    });

    it('Can render about.tsx as a page', async () => {
      const html = await fixture.readFile('/about/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'About Us');
      assert.equal($('title').text(), 'About Us');
    });

    it('Can render dynamic routes with getStaticPaths', async () => {
      // First blog post
      const html1 = await fixture.readFile('/blog/hello-world/index.html');
      const $1 = cheerioLoad(html1);

      assert.equal($1('h1').text(), 'Hello World');
      assert.equal($1('title').text(), 'Hello World');
      assert.ok($1('p').text().includes('This is my first post'));

      // Second blog post
      const html2 = await fixture.readFile('/blog/second-post/index.html');
      const $2 = cheerioLoad(html2);

      assert.equal($2('h1').text(), 'Second Post');
      assert.equal($2('title').text(), 'Second Post');
    });

    it('Can render TSX page with imported React component', async () => {
      const html = await fixture.readFile('/with-component/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Page with React Component');
      // Counter component should be SSR rendered
      assert.ok($('p').text().includes('Count: 5'));
    });

    it('Can render TSX page with island components (client:load)', async () => {
      const html = await fixture.readFile('/interactive/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Interactive Page with Islands');

      // Check for astro-island elements (hydration markers)
      const islands = $('astro-island');
      assert.ok(islands.length >= 1, `Expected at least 1 astro-island, got ${islands.length}`);
    });

    it('Can render React page with islands (@jsxImportSource react)', async () => {
      const html = await fixture.readFile('/react-with-islands/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'React Page with Islands');

      // Check for astro-island elements (hydration markers)
      const islands = $('astro-island');
      assert.ok(islands.length >= 1, `Expected at least 1 astro-island, got ${islands.length}`);

      // Check that the Counter is SSR rendered with correct initial value
      // Note: React's renderToString adds <!-- --> comments, so we check for text content
      const islandText = islands.first().text();
      assert.ok(islandText.includes('Count: 42') || islandText.includes('Count:42'), 'Counter should be SSR rendered with initial value 42');

      // Check that props are passed correctly
      const propsAttr = islands.first().attr('props');
      assert.ok(propsAttr, 'Island should have props attribute');
      // Props are JSON with Astro's encoding format: { key: [type, value] }
      const props = JSON.parse(propsAttr);
      assert.ok(props.initial, 'Props should contain initial');
      // Astro encodes as [type, value] where type 0 = primitive
      assert.equal(props.initial[1], 42, 'Props should contain initial: 42');
    });

    it('Can render nested pages (admin/users/list.tsx)', async () => {
      const html = await fixture.readFile('/admin/users/list/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Admin - Users List');
      assert.equal($('title').text(), 'Users List');
      // Check users are rendered
      const listItems = $('li');
      assert.equal(listItems.length, 3);
    });

    it('Can render anonymous arrow function export', async () => {
      const html = await fixture.readFile('/anonymous-export/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Anonymous Arrow Function Export');
      assert.equal($('title').text(), 'Anonymous Export');
    });

    it('Can render named export pattern (const Page = ...; export default Page)', async () => {
      const html = await fixture.readFile('/named-export/index.html');
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Named Export Pattern');
      assert.equal($('title').text(), 'Named Export');
    });

    describe('client: directive edge cases', () => {
      it('Can handle client:media with value', async () => {
        const html = await fixture.readFile('/edge-cases/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Edge Cases Page');

        // Check for astro-island elements
        const islands = $('astro-island');
        assert.ok(islands.length >= 3, `Expected at least 3 astro-islands, got ${islands.length}`);

        // Check for client:media island
        const mediaIsland = $('astro-island[client="media"]');
        assert.ok(mediaIsland.length >= 1, 'Expected at least one client:media island');
      });

      it('Can handle self-closing tags without space', async () => {
        const html = await fixture.readFile('/edge-cases/index.html');
        const $ = cheerioLoad(html);

        // Check that client:load island exists
        const loadIsland = $('astro-island[client="load"]');
        assert.ok(loadIsland.length >= 1, 'Expected at least one client:load island');
      });

      it('Can handle multiline props with client: directives', async () => {
        const html = await fixture.readFile('/edge-cases/index.html');
        const $ = cheerioLoad(html);

        // Check that client:idle island exists
        const idleIsland = $('astro-island[client="idle"]');
        assert.ok(idleIsland.length >= 1, 'Expected at least one client:idle island');
      });

      it('Can handle default import with different local name', async () => {
        const html = await fixture.readFile('/edge-cases/aliased-import/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Aliased Import Test');

        // Check that component imported with different name is hydrated
        const islands = $('astro-island[client="load"]');
        assert.ok(islands.length >= 1, 'Expected at least one client:load island for renamed import');

        // Check SSR rendered content
        assert.ok(html.includes('Count:'), 'Counter should be SSR rendered');
        assert.ok(html.includes('42'), 'Counter should show initial value 42');
      });

      it('Can handle client:only directive (no SSR)', async () => {
        const html = await fixture.readFile('/edge-cases/client-only/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Client Only Test');

        // client:only should create an island but NOT render content on server
        const clientOnlyIsland = $('astro-island[client="only"]');
        assert.ok(clientOnlyIsland.length >= 1, 'Expected at least one client:only island');

        // client:load should still SSR render
        const clientLoadIsland = $('astro-island[client="load"]');
        assert.ok(clientLoadIsland.length >= 1, 'Expected at least one client:load island');

        // Check that client:load counter IS rendered (has content)
        const loadContainer = $('#client-load-container');
        assert.ok(loadContainer.text().includes('50'), 'client:load counter should be SSR rendered with value 50');
      });

      it('Can handle named exports from component file', async () => {
        const html = await fixture.readFile('/edge-cases/named-component-export/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Named Component Export Test');

        // Check for both islands
        const loadIslands = $('astro-island[client="load"]');
        const visibleIslands = $('astro-island[client="visible"]');

        assert.ok(loadIslands.length >= 1, 'Expected at least one client:load island for NamedCounter');
        assert.ok(visibleIslands.length >= 1, 'Expected at least one client:visible island for AnotherComponent');

        // Check SSR content
        assert.ok(html.includes('Named Count:'), 'NamedCounter should be SSR rendered');
        assert.ok(html.includes('100'), 'NamedCounter should show initial value 100');
      });

      it('Can handle components with children', async () => {
        const html = await fixture.readFile('/edge-cases/with-children/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Components With Children Test');

        // Check for hydrated wrappers
        const islands = $('astro-island');
        assert.ok(islands.length >= 2, `Expected at least 2 astro-islands, got ${islands.length}`);

        // Check that wrapper content is rendered
        assert.ok(html.includes('Interactive Wrapper'), 'First wrapper should have title');
        assert.ok(html.includes('child content inside'), 'First wrapper should render children');
        assert.ok(html.includes('Visible Wrapper'), 'Second wrapper should have title');
      });

      it('Can handle barrel imports and aliased named imports ({ X as Y })', async () => {
        const html = await fixture.readFile('/edge-cases/barrel-import/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Barrel Import Test');

        // Check for all three hydrated components
        const loadIslands = $('astro-island[client="load"]');
        const visibleIslands = $('astro-island[client="visible"]');
        const idleIslands = $('astro-island[client="idle"]');

        assert.ok(loadIslands.length >= 1, 'Expected Counter with client:load');
        assert.ok(visibleIslands.length >= 1, 'Expected Button (aliased as MyButton) with client:visible');
        assert.ok(idleIslands.length >= 1, 'Expected Wrapper with client:idle');

        // Check SSR content
        assert.ok(html.includes('Count:'), 'Counter should be SSR rendered');
        assert.ok(html.includes('Aliased Button'), 'Button (aliased) should be SSR rendered');
        assert.ok(html.includes('From Barrel'), 'Wrapper should be SSR rendered');
      });

      it('Can handle strings containing "client:" without false positives', async () => {
        const html = await fixture.readFile('/edge-cases/string-false-positive/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'String False Positive Test');

        // Should only have ONE actual hydrated component
        const islands = $('astro-island');
        assert.equal(islands.length, 1, `Expected exactly 1 astro-island, got ${islands.length}`);

        // The actual counter should be hydrated with value 77
        assert.ok(html.includes('77'), 'Actual Counter should show initial value 77');

        // String content should be present but not processed as directive
        assert.ok(html.includes('Use client:load for immediate hydration'), 'Instruction string should be preserved');
      });

      it('Can handle complex props with special characters', async () => {
        const html = await fixture.readFile('/edge-cases/complex-props/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Complex Props Test');

        // Check for all hydrated components
        const islands = $('astro-island');
        assert.ok(islands.length >= 3, `Expected at least 3 astro-islands, got ${islands.length}`);

        // Check that special characters in props don't break rendering
        assert.ok(html.includes('Title with'), 'Wrapper with special chars should be rendered');
        assert.ok(html.includes('999'), 'Counter should show initial value 999');
      });

      it('Can handle async page components', async () => {
        const html = await fixture.readFile('/edge-cases/async-component/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Async Page');
        assert.equal($('title').text(), 'Async Page');

        // Check that async data was resolved
        assert.ok(html.includes('This page component is async'), 'Async page should render');
        assert.ok(html.includes('Fetched count: 25'), 'Async data should be resolved');

        // Check for hydrated component
        const islands = $('astro-island[client="load"]');
        assert.ok(islands.length >= 1, 'Expected at least one client:load island');
      });

      it('Can handle multiple client directives on same component', async () => {
        const html = await fixture.readFile('/edge-cases/multiple-directives/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Multiple Client Directives Test');

        // Component should be hydrated (first directive wins)
        const islands = $('astro-island');
        assert.ok(islands.length >= 1, 'Expected at least one astro-island');

        // Check SSR content
        assert.ok(html.includes('99'), 'Counter should show initial value 99');
      });

      it('Can handle fragment returns in components', async () => {
        const html = await fixture.readFile('/edge-cases/fragment-return/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Fragment Return Test');

        // Check that fragment content is rendered
        assert.ok(html.includes('First paragraph in fragment'), 'First fragment paragraph should render');
        assert.ok(html.includes('Second paragraph in fragment'), 'Second fragment paragraph should render');
        assert.ok(html.includes('After fragment content'), 'Content after fragment should render');
      });

      it('Can handle template literal props with client directives', async () => {
        const html = await fixture.readFile('/edge-cases/template-literal-props/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Template Literal Props Test');

        // Check for hydrated components
        const loadIslands = $('astro-island[client="load"]');
        const visibleIslands = $('astro-island[client="visible"]');
        const idleIslands = $('astro-island[client="idle"]');

        assert.ok(loadIslands.length >= 1, 'Expected Wrapper with client:load');
        assert.ok(visibleIslands.length >= 1, 'Expected Counter with client:visible');
        assert.ok(idleIslands.length >= 1, 'Expected Counter with client:idle');

        // Check SSR content
        assert.ok(html.includes('Hello User'), 'Template literal title should be rendered');
        assert.ok(html.includes('20'), 'Computed initial value (10*2) should render');
        assert.ok(html.includes('15'), 'Computed initial value (10+5) should render');
      });

      it('Can handle conditional rendering with client directives', async () => {
        const html = await fixture.readFile('/edge-cases/conditional-render/index.html');
        const $ = cheerioLoad(html);

        assert.equal($('h1').text(), 'Conditional Render Test');

        // First counter should be rendered (showCounter = true)
        assert.ok(html.includes('111'), 'First conditional counter should be rendered');

        // Second counter should NOT be rendered (showSecondCounter = false)
        assert.ok(html.includes('Second counter is hidden'), 'Fallback text should show');

        // Array conditionals - odd numbers (1, 3) should render, even (2) should not
        assert.ok(html.includes('100'), 'Counter with initial 100 (1*100) should render');
        assert.ok(html.includes('300'), 'Counter with initial 300 (3*100) should render');

        // Check for hydrated components
        const islands = $('astro-island');
        assert.ok(islands.length >= 3, `Expected at least 3 astro-islands, got ${islands.length}`);
      });
    });
  });

  describe('dev', () => {
    let devServer;

    before(async () => {
      devServer = await fixture.startDevServer();
    });

    after(async () => {
      await devServer.stop();
    });

    it('Can serve index.tsx in dev mode', async () => {
      const response = await fixture.fetch('/');
      assert.equal(response.status, 200);

      const html = await response.text();
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Welcome to TSX Pages');
    });

    it('Can serve about.tsx in dev mode', async () => {
      const response = await fixture.fetch('/about');
      assert.equal(response.status, 200);

      const html = await response.text();
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'About Us');
    });

    it('Can serve dynamic routes in dev mode', async () => {
      const response = await fixture.fetch('/blog/hello-world');
      assert.equal(response.status, 200);

      const html = await response.text();
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Hello World');
    });

    it('Can serve island components in dev mode', async () => {
      const response = await fixture.fetch('/interactive');
      assert.equal(response.status, 200);

      const html = await response.text();
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Interactive Page with Islands');
      // Check for astro-island elements
      const islands = $('astro-island');
      assert.ok(islands.length >= 1, `Expected at least 1 astro-island in dev mode, got ${islands.length}`);
    });

    it('Can serve nested pages in dev mode', async () => {
      const response = await fixture.fetch('/admin/users/list');
      assert.equal(response.status, 200);

      const html = await response.text();
      const $ = cheerioLoad(html);

      assert.equal($('h1').text(), 'Admin - Users List');
    });

    it('Returns 404 for non-existent pages', async () => {
      const response = await fixture.fetch('/non-existent-page');
      assert.equal(response.status, 404);
    });
  });
});

