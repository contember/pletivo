import { defineConfig } from "astro/config";

function virtualGreeting() {
  return {
    name: "virtual-greeting",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: "virtual-greeting-plugin",
                resolveId(id) {
                  if (id === "virtual:greeting") return "\0virtual:greeting";
                },
                load(id) {
                  if (id === "\0virtual:greeting") {
                    return `export const greeting = "hello from virtual";`;
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

export default defineConfig({
  site: "https://example.com",
  integrations: [virtualGreeting()],
});
