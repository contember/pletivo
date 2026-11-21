import { writeFileSync } from "node:fs";

export default {
  build: { format: "file" },
  integrations: [
    {
      name: "record-pages",
      hooks: {
        "astro:build:done": ({ dir, pages }) => {
          writeFileSync(new URL("pages.json", dir), JSON.stringify(pages.map((page) => page.pathname).sort()));
        },
      },
    },
  ],
};
