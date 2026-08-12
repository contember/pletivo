const noopPlugin = () => {};

export default {
  redirects: { "/old": "/new" },
  markdown: { remarkPlugins: [noopPlugin] },
  integrations: [{
    name: "unsupported-semantics",
    hooks: {
      "astro:config:setup"({ injectRoute, injectScript }) {
        injectRoute({ pattern: "/injected", entrypoint: "./src/pages/index.ts", prerender: true });
        injectScript("before-hydration", "window.before = true;");
      },
    },
  }],
};
