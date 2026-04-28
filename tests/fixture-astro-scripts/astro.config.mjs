import { defineConfig } from "astro/config";

/** Test integration that exercises every injectScript stage with TS code. */
function testInjectScripts() {
  return {
    name: "test-inject-scripts",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        injectScript(
          "page",
          `const injectedPageValue: number = 42;\n` +
            `document.documentElement.dataset.injectedPage = String(injectedPageValue);`,
        );
        injectScript(
          "head-inline",
          `const injectedHeadValue: string = "head-ok";\n` +
            `document.documentElement.dataset.injectedHead = injectedHeadValue;`,
        );
      },
    },
  };
}

export default defineConfig({
  site: "https://example.com",
  integrations: [testInjectScripts()],
});
