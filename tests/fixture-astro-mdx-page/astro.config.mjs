// Sets an id only where none is set yet: it keeps its id only when it runs before Astro's heading ids.
function rehypePresetId() {
  const visit = (node) => {
    const text = node.children?.map((child) => child.value ?? "").join("");
    if (node.type === "element" && node.tagName === "h2" && text === "Preset") node.properties.id ??= "set-by-plugin";
    node.children?.forEach(visit);
  };
  return visit;
}

export default { markdown: { rehypePlugins: [rehypePresetId] } };
