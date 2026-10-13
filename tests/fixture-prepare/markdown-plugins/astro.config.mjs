import { rehypeMark, remarkShout } from "portable-markdown";

export default {
  markdown: {
    remarkPlugins: [[remarkShout, { suffix: "!" }]],
    rehypePlugins: [rehypeMark],
    remarkRehype: { allowDangerousHtml: true },
  },
};
