import { existsSync } from "node:fs";
import preact from "@astrojs/preact";
import vue from "@astrojs/vue";

const inner = preact();

// Vue is wired at start; Preact's setup fails until src/ready.txt exists, so a retry changes the wired set.
export default {
  integrations: [
    vue(),
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
