// Sets a camelCase hast property, which MDX names per its elementAttributeNameCase.
function rehypeTabIndex() {
  const visit = (node) => {
    if (node.type === "element" && node.tagName === "pre") node.properties.tabIndex = 0;
    node.children?.forEach(visit);
  };
  return visit;
}

export default { mdx: { rehypePlugins: [rehypeTabIndex] } };
