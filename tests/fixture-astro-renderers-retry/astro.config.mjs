import { existsSync } from "node:fs";
import preact from "@astrojs/preact";

const inner = preact();

// Preact's setup, failing until src/ready.txt exists: a renderer that registers only on a retry.
export default {
  integrations: [
    {
      name: "preact-when-ready",
      hooks: {
        ...inner.hooks,
        "astro:config:setup": async (options) => {
          if (!existsSync(new URL("./src/ready.txt", import.meta.url))) throw new Error("not ready yet");
          await inner.hooks["astro:config:setup"](options);
        },
      },
    },
  ],
};
