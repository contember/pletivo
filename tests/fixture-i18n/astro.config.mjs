// Mini fixture exercising pletivo's astro-compat i18n path.
// Mirrors the shape of Astro's own `i18n-routing` test fixture so the
// same helpers and conventions get exercised end-to-end.
export default {
  site: "https://example.com",
  i18n: {
    defaultLocale: "en",
    locales: [
      "en",
      "pt",
      { path: "spanish", codes: ["es", "es-SP"] },
    ],
  },
};
