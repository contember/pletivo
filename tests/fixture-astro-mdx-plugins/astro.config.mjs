import mdx from "@astrojs/mdx";
import { rehypeMark, remarkShout } from "portable-markdown";

// `extendMarkdownConfig: false` drops `markdown.remarkPlugins`, so no `?` reaches the page.
export default {
  markdown: { syntaxHighlight: false, remarkPlugins: [[remarkShout, { suffix: "?" }]] },
  integrations: [mdx({ remarkPlugins: [[remarkShout, { suffix: "!" }]], rehypePlugins: [rehypeMark], gfm: false, extendMarkdownConfig: false })],
};
