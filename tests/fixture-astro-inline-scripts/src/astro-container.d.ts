// pletivo's astro plugin serves `astro/container` at run time; astro itself is not installed.
declare module "astro/container" {
  export const experimental_AstroContainer: typeof import("../../../packages/runtime/src/astro-container").experimental_AstroContainer;
}
