// Shape of a compiled `.astro` module, so the smoke scripts typecheck.
// pletivo's astro plugin registers the real loader at runtime.
declare module "*.astro" {
  const component: import("../../packages/pletivo/src/runtime/astro-shim").AstroComponentFactory;
  export default component;
}
