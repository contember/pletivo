/**
 * Runtime backing for the `astro:i18n` virtual module. Every helper a
 * user might import from `astro:i18n` is exported from here; the
 * virtual-module registration in `astro-plugin.ts` just re-exports
 * everything in this file under the `astro:i18n` specifier.
 *
 * This module owns the mutable runtime state (resolved config + base +
 * site) because the virtual module has to look identical across all
 * importers — we cannot pass config down per-call. Dev and build each
 * call `setI18nRuntimeState()` once after `initAstroHost()` resolves
 * the user's Astro config, which is strictly before any `.astro` file
 * (and therefore any `astro:i18n` import) is loaded.
 *
 * Helpers throw when called without state set — users see that as
 * `astro:i18n: i18n is not configured in astro.config.*` rather than a
 * silently wrong URL.
 */

import type { ResolvedI18nConfig } from "./config";
import {
  getPathByLocale as _getPathByLocale,
  getLocaleByPath as _getLocaleByPath,
  getRelativeLocaleUrl as _getRelativeLocaleUrl,
  getAbsoluteLocaleUrl as _getAbsoluteLocaleUrl,
  getRelativeLocaleUrlList as _getRelativeLocaleUrlList,
  getAbsoluteLocaleUrlList as _getAbsoluteLocaleUrlList,
  type LocaleUrlOptions,
} from "./helpers";

interface I18nRuntimeState {
  config: ResolvedI18nConfig;
  base: string;
  site: string | undefined;
}

let state: I18nRuntimeState | null = null;

/**
 * Install the resolved i18n config that every `astro:i18n` helper will
 * read from. Called once per process from dev / build after the Astro
 * config has been loaded. Safe to call multiple times — later calls
 * replace earlier state.
 */
export function setI18nRuntimeState(
  config: ResolvedI18nConfig | null,
  base: string,
  site: string | undefined,
): void {
  state = config ? { config, base, site } : null;
}

/** For tests — reset to a clean slate. */
export function __resetI18nRuntimeState(): void {
  state = null;
}

function requireState(fn: string): I18nRuntimeState {
  if (!state) {
    throw new Error(
      `astro:i18n.${fn}() was called but i18n is not configured. ` +
        `Add an \`i18n\` field to your astro.config.*.`,
    );
  }
  return state;
}

// ── Public astro:i18n surface ───────────────────────────────────────

export function getPathByLocale(locale: string): string {
  const { config } = requireState("getPathByLocale");
  return _getPathByLocale(config, locale);
}

export function getLocaleByPath(path: string): string {
  const { config } = requireState("getLocaleByPath");
  return _getLocaleByPath(config, path);
}

export function getRelativeLocaleUrl(
  locale: string,
  path: string = "",
  opts: LocaleUrlOptions = {},
): string {
  const { config, base } = requireState("getRelativeLocaleUrl");
  return _getRelativeLocaleUrl(config, base, locale, path, opts);
}

export function getAbsoluteLocaleUrl(
  locale: string,
  path: string = "",
  opts: LocaleUrlOptions = {},
): string {
  const { config, base, site } = requireState("getAbsoluteLocaleUrl");
  return _getAbsoluteLocaleUrl(config, base, site, locale, path, opts);
}

export function getRelativeLocaleUrlList(
  path: string = "",
  opts: LocaleUrlOptions = {},
): string[] {
  const { config, base } = requireState("getRelativeLocaleUrlList");
  return _getRelativeLocaleUrlList(config, base, path, opts);
}

export function getAbsoluteLocaleUrlList(
  path: string = "",
  opts: LocaleUrlOptions = {},
): string[] {
  const { config, base, site } = requireState("getAbsoluteLocaleUrlList");
  return _getAbsoluteLocaleUrlList(config, base, site, path, opts);
}

/**
 * Stub for Astro's SSR-only helper. Pletivo is SSG-only, so we can't
 * return a real `Response` redirect. The function signature is kept
 * for type compatibility — calling it throws.
 */
export function redirectToDefaultLocale(): never {
  throw new Error(
    "astro:i18n.redirectToDefaultLocale() is not supported in pletivo's " +
      "static-site output. Use a build-time redirect config entry instead.",
  );
}

/** Same caveat as above. */
export function redirectToFallback(): never {
  throw new Error(
    "astro:i18n.redirectToFallback() is not supported in pletivo's " +
      "static-site output.",
  );
}

export function notFound(): never {
  throw new Error(
    "astro:i18n.notFound() is not supported in pletivo's static-site output.",
  );
}

/**
 * Astro's middleware factory for i18n — returns a middleware function
 * that sets `currentLocale` / handles `redirectToDefaultLocale`. In
 * pletivo, dev-server middleware is driven by Connect, and those two
 * concerns are already handled natively, so this returns a no-op that
 * satisfies the import signature for user middleware chains.
 */
export function middleware(_options?: unknown): (
  ctx: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown> {
  return async (_ctx, next) => next();
}
