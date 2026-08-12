export default {
  integrations: [{
    name: "malformed-virtual",
    hooks: {
      "astro:config:setup"({ updateConfig }) {
        updateConfig({ vite: { plugins: [{
          name: "malformed-source",
          resolveId(id) {
            if (id === "virtual:malformed") return "\0virtual:malformed.ts";
          },
          load(id) {
            if (id === "\0virtual:malformed.ts") return "export const = broken;";
          },
        }] } });
      },
    },
  }],
};
