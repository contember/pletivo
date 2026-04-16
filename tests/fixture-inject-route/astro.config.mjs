import { defineConfig } from "astro/config";

/** Test integration that injects routes */
function testInjectRoutes() {
  return {
    name: "test-inject-routes",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        injectRoute({
          pattern: "/robots.txt",
          entrypoint: "./src/routes/robots.ts",
        });
        injectRoute({
          pattern: "/feed.xml",
          entrypoint: "./src/routes/feed.xml.ts",
        });
      },
    },
  };
}

export default defineConfig({
  site: "https://example.com",
  integrations: [testInjectRoutes()],
});
