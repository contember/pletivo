const VIRTUAL_ENTRY = "virtual:test-build-setup/entry";

/**
 * A page script whose Vite plugin arrives only in `astro:build:setup`, so the build must
 * run that hook before it bundles the page scripts.
 */
function lateEntryPlugin() {
  return {
    name: "test-build-setup-page-script",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        injectScript("page", `import "${VIRTUAL_ENTRY}";`);
      },
      "astro:build:setup": ({ updateConfig }) => {
        updateConfig({
          plugins: [
            {
              name: "test-build-setup-entry",
              resolveId(id) {
                if (id === VIRTUAL_ENTRY) return "\0" + VIRTUAL_ENTRY;
              },
              load(id) {
                if (id === "\0" + VIRTUAL_ENTRY) {
                  return `document.documentElement.dataset.late = "build-setup-marker";`;
                }
              },
            },
          ],
        });
      },
    },
  };
}

export default {
  site: "https://example.com",
  integrations: [lateEntryPlugin()],
};
