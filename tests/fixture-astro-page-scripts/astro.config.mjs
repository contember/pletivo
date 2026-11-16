// A plain object, not `defineConfig`: `pletivo prepare` runs first in the Workers parity
// harness, before the build has registered the `astro/config` shim.
const VIRTUAL_ENTRY = "virtual:test-page-scripts/entry";

/**
 * Page scripts the way `@astrojs/alpinejs` writes them: a package import, a Vite virtual
 * module, TypeScript, a second script that reuses a top-level name, and the `$` patterns
 * of `String.prototype.replace`.
 */
function testPageScripts() {
  return {
    name: "test-page-scripts",
    hooks: {
      "astro:config:setup": ({ injectScript, updateConfig }) => {
        injectScript(
          "page",
          `import { mark } from "page-script-lib";\n` +
            `import { setup } from "${VIRTUAL_ENTRY}";\n` +
            `const label: string = "first";\n` +
            `setup(mark, label);`,
        );
        injectScript(
          "page",
          `const label = "second-script-marker";\n` +
            `document.documentElement.dataset.second = label;`,
        );
        // `String.replace` reads these as substitution patterns in a string replacement.
        injectScript("page", "document.documentElement.dataset.dollar = \"$$|$&|$'\";");
        updateConfig({
          vite: {
            plugins: [
              {
                name: "test-page-scripts-entry",
                resolveId(id) {
                  if (id === VIRTUAL_ENTRY) return "\0" + VIRTUAL_ENTRY;
                },
                load(id) {
                  if (id === "\0" + VIRTUAL_ENTRY) {
                    return `export const setup = (mark, label) => mark("virtual-entry-marker-" + label);`;
                  }
                },
              },
            ],
          },
        });
      },
    },
  };
}

export default {
  site: "https://example.com",
  integrations: [testPageScripts()],
};
