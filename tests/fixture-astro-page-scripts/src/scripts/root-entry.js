// Reached only by Vite's root-relative id `/src/scripts/root-entry.js`, from a virtual module.
export default function rootEntry() {
  document.documentElement.dataset.rootEntry = "root-relative-marker";
}
