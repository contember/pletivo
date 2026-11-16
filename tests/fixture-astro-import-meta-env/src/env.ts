// A plain module: Astro gives it the same `import.meta.env` as a component.
export const fromModule = {
  base: import.meta.env.BASE_URL,
  mode: import.meta.env.MODE,
  dev: import.meta.env.DEV,
  prod: import.meta.env.PROD,
  ssr: import.meta.env.SSR,
  site: import.meta.env.SITE,
  publicVar: import.meta.env.PUBLIC_FIXTURE_VAR,
};
