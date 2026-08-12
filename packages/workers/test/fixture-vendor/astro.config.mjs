import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The config phase, doing what real ones do: reading the filesystem before any hook
 * runs. the static dogfood site's own config walks 93 YAML files at module scope; this reads one JSON
 * file. Either way an isolate cannot run it, which is why `pletivo prepare` exists.
 */
const tones = JSON.parse(
  readFileSync(fileURLToPath(new URL("./tones.json", import.meta.url)), "utf8"),
);

/**
 * astro-icon's whole `astro:config:setup` surface, in miniature: one Vite plugin
 * whose `load()` returns a JSON literal computed off disk. Freezable exactly because
 * nothing in it depends on the request.
 */
const tokensPlugin = {
  name: "vendor-demo-tokens",
  resolveId(id) {
    if (id === "virtual:vendor-demo") return "\0virtual:vendor-demo";
  },
  load(id) {
    if (id === "\0virtual:vendor-demo") {
      return `export default ${JSON.stringify({ tones })};`;
    }
  },
};

export default {
  site: "https://vendor.example",
  integrations: [
    {
      name: "vendor-demo",
      hooks: {
        "astro:config:setup"({ updateConfig, injectScript }) {
          updateConfig({ vite: { plugins: [tokensPlugin] } });
          injectScript("head-inline", 'window.__vendorDemo = "ready";');
        },
      },
    },
  ],
};
