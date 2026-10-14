export default {
  trailingSlash: "always",
  redirects: {
    "/old": "/new",
    "/blog/[slug]": { status: 302, destination: "/posts/[slug]" },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", { path: "spanish", codes: ["es", "es-AR"] }],
    routing: { prefixDefaultLocale: false },
    fallback: { es: "en" },
  },
};
