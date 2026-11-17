import preact from "@astrojs/preact";
import react from "@astrojs/react";
import solid from "@astrojs/solid-js";
import svelte from "@astrojs/svelte";
import vue from "@astrojs/vue";

export default {
  integrations: [
    preact({ include: ["**/preact/*"] }),
    solid({ include: ["**/solid/*"] }),
    react({ include: ["**/react/*"] }),
    svelte(),
    vue(),
  ],
};
