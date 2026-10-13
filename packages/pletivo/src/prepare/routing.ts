/** Freeze the routing parts of the Astro config: `i18n`, `trailingSlash`, `redirects`. */

import {
  REDIRECT_STATUSES,
  type ArtifactI18nConfig,
  type ArtifactLocale,
  type ArtifactRedirect,
  type ArtifactTrailingSlash,
} from "@pletivo/core/artifact";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import type { PrepareDiagnostic } from "./error";

export interface FrozenRouting {
  i18n: ArtifactI18nConfig | null;
  trailingSlash: ArtifactTrailingSlash | null;
  redirects: ArtifactRedirect[];
  diagnostics: PrepareDiagnostic[];
}

/** Astro's status for a redirect given as a bare destination. */
const DEFAULT_REDIRECT_STATUS = 301;

export function freezeRouting(config: AstroConfig | undefined): FrozenRouting {
  const diagnostics: PrepareDiagnostic[] = [];
  const fail = (hook: string, reason: string): void => {
    diagnostics.push({ source: "astro.config", hook, reason });
  };

  let trailingSlash: ArtifactTrailingSlash | null = null;
  const configured = config?.trailingSlash;
  if (configured === "always" || configured === "never") trailingSlash = configured;
  else if (configured !== undefined && configured !== "ignore") {
    fail("trailingSlash", `trailingSlash ${JSON.stringify(configured)} is not "always", "never" or "ignore"`);
  }

  const redirects: ArtifactRedirect[] = [];
  for (const [source, target] of Object.entries(config?.redirects ?? {})) {
    const destination = typeof target === "string" ? target : target.destination;
    const status = typeof target === "string" ? DEFAULT_REDIRECT_STATUS : target.status;
    if (!source.startsWith("/")) fail("redirects", `redirect source ${JSON.stringify(source)} does not start with "/"`);
    else if (!REDIRECT_STATUSES.has(status)) fail("redirects", `redirect ${JSON.stringify(source)} has status ${status}`);
    else redirects.push({ source, destination, status });
  }

  return { i18n: freezeI18n(config?.i18n, fail), trailingSlash, redirects, diagnostics };
}

function freezeI18n(
  i18n: AstroConfig["i18n"],
  fail: (hook: string, reason: string) => void,
): ArtifactI18nConfig | null {
  if (i18n === undefined) return null;
  const locales: ArtifactLocale[] = i18n.locales.map((locale) =>
    typeof locale === "string" ? locale : { path: locale.path, codes: [...locale.codes] },
  );
  const frozen: ArtifactI18nConfig = { defaultLocale: i18n.defaultLocale, locales };

  const routing: unknown = i18n.routing;
  if (routing === "manual") {
    fail("i18n", 'i18n.routing "manual" needs middleware, which the Workers host does not run');
  } else if (typeof routing === "object" && routing !== null) {
    frozen.routing = {};
    const prefixDefaultLocale: unknown = Reflect.get(routing, "prefixDefaultLocale");
    const redirectToDefaultLocale: unknown = Reflect.get(routing, "redirectToDefaultLocale");
    const fallbackType: unknown = Reflect.get(routing, "fallbackType");
    if (typeof prefixDefaultLocale === "boolean") frozen.routing.prefixDefaultLocale = prefixDefaultLocale;
    if (typeof redirectToDefaultLocale === "boolean") frozen.routing.redirectToDefaultLocale = redirectToDefaultLocale;
    if (fallbackType === "rewrite" || fallbackType === "redirect") frozen.routing.fallbackType = fallbackType;
  }

  const fallback: unknown = i18n.fallback;
  if (typeof fallback === "object" && fallback !== null) {
    const entries: [string, string][] = [];
    for (const locale of Object.keys(fallback)) {
      const source: unknown = Reflect.get(fallback, locale);
      if (typeof source === "string") entries.push([locale, source]);
    }
    frozen.fallback = Object.fromEntries(entries);
  }

  const domains: unknown = i18n.domains;
  if (typeof domains === "object" && domains !== null && Object.keys(domains).length > 0) {
    fail("i18n", "i18n.domains maps locales to other origins, which a single preview origin cannot serve");
  }
  return frozen;
}
