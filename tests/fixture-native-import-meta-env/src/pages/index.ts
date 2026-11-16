// A pletivo-native page: no Astro config, so BASE_URL is pletivo's `base`.
export default function Home() {
  const env = { base: import.meta.env.BASE_URL, mode: import.meta.env.MODE, dev: import.meta.env.DEV };
  return {
    __html: `<!DOCTYPE html><html><body><pre id="env">${JSON.stringify(env).replaceAll('"', "&quot;")}</pre></body></html>`,
  };
}
