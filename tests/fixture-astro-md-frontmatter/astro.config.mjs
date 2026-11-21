// A remark plugin that adds to the frontmatter, as Astro's `file.data.astro.frontmatter` allows.
function remarkInject() {
  return (_tree, file) => {
    file.data.astro.frontmatter.injected = `injected into ${file.data.astro.frontmatter.title}`;
  };
}

export default { markdown: { remarkPlugins: [remarkInject] } };
