// From Astro's examples/with-mdx (MIT); without Shiki, which the Workers host does not run (docs/todos/016).
import preact from "@astrojs/preact";

export default { integrations: [preact()], markdown: { syntaxHighlight: false } };
