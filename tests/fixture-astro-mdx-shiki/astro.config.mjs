// Marks the code blocks it sees already highlighted: Astro highlights before the user's rehype plugins.
function rehypeMarkHighlighted() {
  const visit = (node) => {
    const className = node.properties?.className ?? node.properties?.class;
    const classes = Array.isArray(className) ? className : String(className ?? "").split(" ");
    if (node.type === "element" && node.tagName === "pre" && classes.includes("astro-code")) node.properties.dataSeen = "";
    node.children?.forEach(visit);
  };
  return visit;
}

export default { markdown: { rehypePlugins: [rehypeMarkHighlighted] } };
