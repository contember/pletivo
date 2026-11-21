// Marks the code blocks it sees already highlighted: Astro highlights before the user's rehype plugins.
// Marks the headings it sees without an id.
function rehypeMarkHighlighted() {
  const visit = (node) => {
    const className = node.properties?.className ?? node.properties?.class;
    const classes = Array.isArray(className) ? className : String(className ?? "").split(" ");
    if (node.type === "element" && node.tagName === "pre" && classes.includes("astro-code")) node.properties.dataSeen = "";
    // Astro gives headings their ids after the user's rehype plugins.
    if (node.type === "element" && node.tagName === "h2" && node.properties.id === undefined) node.properties.dataNoId = "";
    node.children?.forEach(visit);
  };
  return visit;
}

export default { markdown: { rehypePlugins: [rehypeMarkHighlighted] } };
