import preact from "@astrojs/preact";
import vue from "@astrojs/vue";

const inner = preact();

// Preact's setup needs state that a later integration's setup creates: it fails on the first
// pass of every fresh process and passes on a retry.
export default {
  integrations: [
    vue(),
    {
      name: "preact-after-flag",
      hooks: {
        ...inner.hooks,
        "astro:config:setup": async (options) => {
          if (!globalThis.__pletivoLateSetupReady) throw new Error("flag not ready");
          await inner.hooks["astro:config:setup"](options);
        },
      },
    },
    {
      name: "flag-setter",
      hooks: {
        "astro:config:setup": () => {
          globalThis.__pletivoLateSetupReady = true;
        },
      },
    },
  ],
};
