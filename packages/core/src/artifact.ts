/** Serialized executable input shared by `pletivo prepare` and non-Bun hosts. */

import { compareStrings } from "./compare-strings";

export const ARTIFACT_VERSION = 2;

/** Stable module identity within the prepared graph. */
export type ModuleId = string;

/** Source kinds the Workers compiler deliberately understands. */
export type ArtifactModuleKind = "js" | "ts" | "jsx" | "tsx" | "json" | "astro" | "css";

export interface ArtifactModule {
  id: ModuleId;
  kind: ArtifactModuleKind;
  source: string;
  /** Compilation identity when it intentionally differs from `id`. */
  compilePath?: string;
}

export interface ArtifactModuleTarget {
  kind: "module";
  id: ModuleId;
}

/** Host semantics remain consumer-owned; the artifact only names the external. */
export interface ArtifactExternalTarget {
  kind: "external";
  specifier: string;
}

export type ArtifactResolutionTarget = ArtifactModuleTarget | ArtifactExternalTarget;

/**
 * The importer of a resolution that answers for every project file. A project has one
 * `node_modules` root, so a file added after `pletivo prepare` resolves a package the
 * same way the files prepare saw do.
 */
export const ANY_PROJECT_IMPORTER = "project:*";

/** One importer-aware answer for a source import. */
export interface ArtifactResolution {
  importer: ModuleId;
  specifier: string;
  target: ArtifactResolutionTarget;
}

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type ArtifactJson =
  | null
  | boolean
  | number
  | string
  | ArtifactJson[]
  | { [key: string]: ArtifactJson };

/**
 * The property a remark/rehype plugin function carries to say where an isolate can
 * import the same function: `plugin[PORTABLE_MODULE] = { module, export }`. `module`
 * is a bare specifier importable from the project; `export` is its named export.
 */
export const PORTABLE_MODULE: unique symbol = Symbol.for("pletivo.portableModule");

/** A markdown plugin as the artifact carries it: where to import it, and its options. */
export interface PortablePlugin {
  module: string;
  export: string;
  /** The second element of the `[plugin, options]` tuple, when there was one. */
  options?: ArtifactJson;
}

/** `markdown` from the Astro config, with its plugins as portable references. */
export interface ArtifactMarkdownConfig {
  remarkPlugins: PortablePlugin[];
  rehypePlugins: PortablePlugin[];
  remarkRehype?: { [key: string]: ArtifactJson };
  gfm?: boolean;
}

/** A locale as Astro's `i18n.locales` spells it. */
export type ArtifactLocale = string | { path: string; codes: string[] };

/**
 * `i18n` from the Astro config, as `resolveI18nConfig` reads it. A type literal, not an
 * interface, so it is assignable to that function's index-signature parameter.
 */
export type ArtifactI18nConfig = {
  defaultLocale: string;
  locales: ArtifactLocale[];
  routing?: {
    prefixDefaultLocale?: boolean;
    redirectToDefaultLocale?: boolean;
    fallbackType?: "rewrite" | "redirect";
  };
  /** Target locale -> the locale its missing pages fall back to. */
  fallback?: { [locale: string]: string };
};

/** One `redirects` entry: a route pattern (`/blog/[slug]`) and where it points. */
export interface ArtifactRedirect {
  source: string;
  destination: string;
  status: number;
}

export type ArtifactTrailingSlash = "always" | "never" | "ignore";

/** Config fields the Workers host currently consumes. */
export interface ArtifactConfig {
  site?: string;
  markdown?: ArtifactMarkdownConfig;
  i18n?: ArtifactI18nConfig;
  trailingSlash?: ArtifactTrailingSlash;
  /** In config order; the first whose source matches wins. */
  redirects?: ArtifactRedirect[];
}

/** Injected scripts the Workers host currently emits, in semantic order. */
export interface InjectedScripts {
  headInline: string[];
  page: string[];
}

/** The complete executable graph produced by `pletivo prepare`. */
export interface SiteArtifact {
  version: typeof ARTIFACT_VERSION;
  config: ArtifactConfig;
  scripts: InjectedScripts;
  modules: ArtifactModule[];
  resolutions: ArtifactResolution[];
  /**
   * Resolutions of the browser graph: imports of processed `<script>` blocks and of
   * what they reach, resolved with browser export conditions. Targets are `modules`
   * entries; a project importer is always `ANY_PROJECT_IMPORTER`.
   */
  browserResolutions?: ArtifactResolution[];
}

/** Marks an `ArtifactInput.path` as relative to the workspace root rather than the project root. */
export const WORKSPACE_INPUT_PREFIX = "workspace:";

/** A file `pletivo prepare` read, and the digest of its bytes at that time. */
export interface ArtifactInput {
  /**
   * Project-root-relative, `/`-separated, no leading `/`, no `.` or `..` segments. A
   * `workspace:` prefix (`workspace:bun.lock`) makes it relative to the workspace root
   * the site installs from instead; see `@pletivo/core/prepare-inputs`.
   */
  path: string;
  /** `sha256:` + 64 lowercase hex characters. */
  digest: string;
}

/** Producer/consumer envelope: the executable artifact plus its provenance. */
export interface PreparedSite {
  artifact: SiteArtifact;
  /** Provenance for staleness checks; never part of program identity. */
  inputs?: ArtifactInput[];
}

/** An artifact from a generation this build cannot read. */
export class ArtifactVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `[pletivo] this site artifact is version ${found}, and this host reads version ` +
        `${ARTIFACT_VERSION}. Re-run \`pletivo prepare\`.`,
    );
    this.name = "ArtifactVersionError";
  }
}

/** A malformed artifact, named at the invalid field. */
export class ArtifactFormatError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`[pletivo] invalid site artifact at ${path}: ${reason}`);
    this.name = "ArtifactFormatError";
  }
}

/** Refuse an artifact from a different generation rather than half-reading it. */
export function assertArtifactVersion(artifact: { version: number }): void {
  if (artifact.version !== ARTIFACT_VERSION) throw new ArtifactVersionError(artifact.version);
}

/** Parse and fully validate a producer/consumer envelope. */
export function parsePreparedSite(value: unknown): PreparedSite {
  const prepared = requireObject(value, "$", "an object");
  const artifact = requireObject(requiredField(prepared, "artifact", "$"), "$.artifact", "an object");

  const version = requiredField(artifact, "version", "$.artifact");
  if (typeof version !== "number") {
    throw new ArtifactFormatError("$.artifact.version", "expected a number");
  }
  assertArtifactVersion({ version });

  assertExactFields(prepared, ["artifact", "inputs"], "$");
  assertExactFields(
    artifact,
    ["version", "config", "scripts", "modules", "resolutions", "browserResolutions"],
    "$.artifact",
  );

  const config = parseConfig(requiredField(artifact, "config", "$.artifact"));
  const scripts = parseScripts(requiredField(artifact, "scripts", "$.artifact"));
  const modules = parseModules(requiredField(artifact, "modules", "$.artifact"));
  const resolutions = parseResolutions(
    requiredField(artifact, "resolutions", "$.artifact"),
    modules,
    "$.artifact.resolutions",
  );

  const site: PreparedSite = {
    artifact: {
      version: ARTIFACT_VERSION,
      config,
      scripts,
      modules,
      resolutions,
    },
  };
  if (hasOwn(artifact, "browserResolutions")) {
    const browserResolutions = parseResolutions(
      Reflect.get(artifact, "browserResolutions"),
      modules,
      "$.artifact.browserResolutions",
    );
    const external = browserResolutions.findIndex((resolution) => resolution.target.kind !== "module");
    if (external !== -1) {
      throw new ArtifactFormatError(
        `$.artifact.browserResolutions[${external}].target.kind`,
        'a browser import must resolve to a "module"',
      );
    }
    site.artifact.browserResolutions = browserResolutions;
  }
  if (hasOwn(prepared, "inputs")) site.inputs = parseInputs(Reflect.get(prepared, "inputs"));
  return site;
}

/** Digest file bytes in the `ArtifactInput.digest` format. */
export async function digestArtifactInput(bytes: Uint8Array): Promise<string> {
  // WebCrypto refuses a view over a SharedArrayBuffer; the copy is always ArrayBuffer-backed.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** Serialize with stable object, module, and resolution ordering. */
export function serializePreparedSite(value: unknown): string {
  const prepared = parsePreparedSite(value);
  const modules = [...prepared.artifact.modules].sort((left, right) =>
    compareStrings(left.id, right.id),
  );

  const canonical: PreparedSite = {
    artifact: {
      version: ARTIFACT_VERSION,
      config: canonicalConfig(prepared.artifact.config),
      scripts: {
        headInline: [...prepared.artifact.scripts.headInline],
        page: [...prepared.artifact.scripts.page],
      },
      modules: modules.map(canonicalModule),
      resolutions: canonicalResolutions(prepared.artifact.resolutions),
    },
  };
  const { browserResolutions } = prepared.artifact;
  if (browserResolutions !== undefined) {
    canonical.artifact.browserResolutions = canonicalResolutions(browserResolutions);
  }
  if (prepared.inputs !== undefined) {
    canonical.inputs = prepared.inputs.map((input) => ({ path: input.path, digest: input.digest }));
  }
  return JSON.stringify(canonical);
}

function parseConfig(value: unknown): ArtifactConfig {
  const at = "$.artifact.config";
  const config = requireObject(value, at, "an object");
  assertExactFields(config, ["site", "markdown", "i18n", "trailingSlash", "redirects"], at);
  const parsed: ArtifactConfig = {};
  if (hasOwn(config, "site")) {
    const site = Reflect.get(config, "site");
    if (typeof site !== "string") throw new ArtifactFormatError(`${at}.site`, "expected a string");
    parsed.site = site;
  }
  if (hasOwn(config, "markdown")) parsed.markdown = parseMarkdownConfig(Reflect.get(config, "markdown"), `${at}.markdown`);
  if (hasOwn(config, "i18n")) parsed.i18n = parseI18nConfig(Reflect.get(config, "i18n"), `${at}.i18n`);
  if (hasOwn(config, "trailingSlash")) {
    const trailingSlash = Reflect.get(config, "trailingSlash");
    if (trailingSlash !== "always" && trailingSlash !== "never" && trailingSlash !== "ignore") {
      throw new ArtifactFormatError(`${at}.trailingSlash`, 'expected "always", "never" or "ignore"');
    }
    parsed.trailingSlash = trailingSlash;
  }
  if (hasOwn(config, "redirects")) parsed.redirects = parseRedirects(Reflect.get(config, "redirects"), `${at}.redirects`);
  return parsed;
}

function parseI18nConfig(value: unknown, at: string): ArtifactI18nConfig {
  const i18n = requireObject(value, at, "an object");
  assertExactFields(i18n, ["defaultLocale", "locales", "routing", "fallback"], at);
  const locales = requiredField(i18n, "locales", at);
  if (!Array.isArray(locales)) throw new ArtifactFormatError(`${at}.locales`, "expected an array");
  const parsed: ArtifactI18nConfig = {
    defaultLocale: requireNonEmptyString(requiredField(i18n, "defaultLocale", at), `${at}.defaultLocale`),
    locales: locales.map((locale: unknown, index): ArtifactLocale => {
      const path = `${at}.locales[${index}]`;
      if (typeof locale === "string") return requireNonEmptyString(locale, path);
      const entry = requireObject(locale, path, "a string or an object");
      assertExactFields(entry, ["path", "codes"], path);
      const codes = parseStringArray(requiredField(entry, "codes", path), `${path}.codes`);
      if (codes.length === 0) throw new ArtifactFormatError(`${path}.codes`, "expected at least one code");
      return { path: requireNonEmptyString(requiredField(entry, "path", path), `${path}.path`), codes };
    }),
  };
  if (hasOwn(i18n, "routing")) {
    const routingAt = `${at}.routing`;
    const routing = requireObject(Reflect.get(i18n, "routing"), routingAt, "an object");
    assertExactFields(routing, ["prefixDefaultLocale", "redirectToDefaultLocale", "fallbackType"], routingAt);
    parsed.routing = {};
    for (const field of ["prefixDefaultLocale", "redirectToDefaultLocale"] as const) {
      if (!hasOwn(routing, field)) continue;
      const flag = Reflect.get(routing, field);
      if (typeof flag !== "boolean") throw new ArtifactFormatError(`${routingAt}.${field}`, "expected a boolean");
      parsed.routing[field] = flag;
    }
    if (hasOwn(routing, "fallbackType")) {
      const fallbackType = Reflect.get(routing, "fallbackType");
      if (fallbackType !== "rewrite" && fallbackType !== "redirect") {
        throw new ArtifactFormatError(`${routingAt}.fallbackType`, 'expected "rewrite" or "redirect"');
      }
      parsed.routing.fallbackType = fallbackType;
    }
  }
  if (hasOwn(i18n, "fallback")) {
    const fallbackAt = `${at}.fallback`;
    const fallback = requireObject(Reflect.get(i18n, "fallback"), fallbackAt, "an object");
    const entries = Object.keys(fallback).map((locale): [string, string] => [
      locale,
      requireNonEmptyString(Reflect.get(fallback, locale), `${fallbackAt}.${locale}`),
    ]);
    parsed.fallback = Object.fromEntries(entries);
  }
  return parsed;
}

function parseRedirects(value: unknown, at: string): ArtifactRedirect[] {
  if (!Array.isArray(value)) throw new ArtifactFormatError(at, "expected an array");
  return value.map((entry: unknown, index): ArtifactRedirect => {
    const path = `${at}[${index}]`;
    const redirect = requireObject(entry, path, "an object");
    assertExactFields(redirect, ["source", "destination", "status"], path);
    const source = requireNonEmptyString(requiredField(redirect, "source", path), `${path}.source`);
    if (!source.startsWith("/")) throw new ArtifactFormatError(`${path}.source`, 'expected a path starting with "/"');
    const status = requiredField(redirect, "status", path);
    if (typeof status !== "number" || !REDIRECT_STATUSES.has(status)) {
      throw new ArtifactFormatError(`${path}.status`, "expected 301, 302, 303, 307 or 308");
    }
    return {
      source,
      destination: requireNonEmptyString(requiredField(redirect, "destination", path), `${path}.destination`),
      status,
    };
  });
}

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function parseMarkdownConfig(value: unknown, at: string): ArtifactMarkdownConfig {
  const markdown = requireObject(value, at, "an object");
  assertExactFields(markdown, ["remarkPlugins", "rehypePlugins", "remarkRehype", "gfm"], at);
  const parsed: ArtifactMarkdownConfig = {
    remarkPlugins: parsePlugins(requiredField(markdown, "remarkPlugins", at), `${at}.remarkPlugins`),
    rehypePlugins: parsePlugins(requiredField(markdown, "rehypePlugins", at), `${at}.rehypePlugins`),
  };
  if (hasOwn(markdown, "remarkRehype")) {
    const options = parseJson(Reflect.get(markdown, "remarkRehype"), `${at}.remarkRehype`);
    if (!isJsonObject(options)) throw new ArtifactFormatError(`${at}.remarkRehype`, "expected an object");
    parsed.remarkRehype = options;
  }
  if (hasOwn(markdown, "gfm")) {
    const gfm = Reflect.get(markdown, "gfm");
    if (typeof gfm !== "boolean") throw new ArtifactFormatError(`${at}.gfm`, "expected a boolean");
    parsed.gfm = gfm;
  }
  return parsed;
}

function parsePlugins(value: unknown, at: string): PortablePlugin[] {
  if (!Array.isArray(value)) throw new ArtifactFormatError(at, "expected an array");
  const plugins: PortablePlugin[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `${at}[${index}]`;
    if (!hasOwn(value, index)) throw new ArtifactFormatError(path, "sparse array entries are not allowed");
    const plugin = requireObject(value[index], path, "an object");
    assertExactFields(plugin, ["module", "export", "options"], path);
    const parsed: PortablePlugin = {
      module: requireNonEmptyString(requiredField(plugin, "module", path), `${path}.module`),
      export: requireNonEmptyString(requiredField(plugin, "export", path), `${path}.export`),
    };
    if (hasOwn(plugin, "options")) parsed.options = parseJson(Reflect.get(plugin, "options"), `${path}.options`);
    plugins.push(parsed);
  }
  return plugins;
}

/** Validate a JSON value, rebuilt so nothing but plain data survives. */
export function parseJson(value: unknown, at: string): ArtifactJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtifactFormatError(at, "expected a finite number");
    return value;
  }
  if (Array.isArray(value)) {
    const items: ArtifactJson[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!hasOwn(value, index)) throw new ArtifactFormatError(`${at}[${index}]`, "sparse array entries are not allowed");
      items.push(parseJson(value[index], `${at}[${index}]`));
    }
    return items;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value).map((key): [string, ArtifactJson] => [
      key,
      parseJson(Reflect.get(value, key), `${at}.${key}`),
    ]);
    return Object.fromEntries(entries);
  }
  throw new ArtifactFormatError(at, "expected JSON data (null, boolean, number, string, array or plain object)");
}

export function isJsonObject(value: ArtifactJson): value is { [key: string]: ArtifactJson } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Object keys sorted, so equal values serialize to equal text. */
function canonicalJson(value: ArtifactJson): ArtifactJson {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isJsonObject(value)) return value;
  const keys = Object.keys(value).sort(compareStrings);
  return Object.fromEntries(keys.map((key): [string, ArtifactJson] => [key, canonicalJson(value[key])]));
}

function parseScripts(value: unknown): InjectedScripts {
  const scripts = requireObject(value, "$.artifact.scripts", "an object");
  assertExactFields(scripts, ["headInline", "page"], "$.artifact.scripts");
  return {
    headInline: parseStringArray(
      requiredField(scripts, "headInline", "$.artifact.scripts"),
      "$.artifact.scripts.headInline",
    ),
    page: parseStringArray(
      requiredField(scripts, "page", "$.artifact.scripts"),
      "$.artifact.scripts.page",
    ),
  };
}

function parseModules(value: unknown): ArtifactModule[] {
  if (!Array.isArray(value)) {
    throw new ArtifactFormatError("$.artifact.modules", "expected an array");
  }

  const ids = new Set<string>();
  const parsed: ArtifactModule[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `$.artifact.modules[${index}]`;
    if (!hasOwn(value, index)) {
      throw new ArtifactFormatError(path, "sparse array entries are not allowed");
    }
    const entry: unknown = value[index];
    const module = requireObject(entry, path, "an object");
    assertExactFields(module, ["id", "kind", "source", "compilePath"], path);

    const id = requireNonEmptyString(requiredField(module, "id", path), `${path}.id`);
    if (ids.has(id)) throw new ArtifactFormatError(`${path}.id`, `duplicate module id ${JSON.stringify(id)}`);
    ids.add(id);

    const kind = parseModuleKind(requiredField(module, "kind", path), `${path}.kind`);
    const source = requiredField(module, "source", path);
    if (typeof source !== "string") {
      throw new ArtifactFormatError(`${path}.source`, "expected a string");
    }

    if (!hasOwn(module, "compilePath")) {
      parsed.push({ id, kind, source });
      continue;
    }
    const compilePath = requireNonEmptyString(Reflect.get(module, "compilePath"), `${path}.compilePath`);
    parsed.push({ id, kind, source, compilePath });
  }
  return parsed;
}

function parseResolutions(
  value: unknown,
  modules: readonly ArtifactModule[],
  at: string,
): ArtifactResolution[] {
  if (!Array.isArray(value)) {
    throw new ArtifactFormatError(at, "expected an array");
  }

  const moduleIds = new Set(modules.map((module) => module.id));
  const keys = new Map<string, Set<string>>();

  const parsed: ArtifactResolution[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `${at}[${index}]`;
    if (!hasOwn(value, index)) {
      throw new ArtifactFormatError(path, "sparse array entries are not allowed");
    }
    const entry: unknown = value[index];
    const resolution = requireObject(entry, path, "an object");
    assertExactFields(resolution, ["importer", "specifier", "target"], path);
    const importer = requireNonEmptyString(
      requiredField(resolution, "importer", path),
      `${path}.importer`,
    );
    const specifier = requireNonEmptyString(
      requiredField(resolution, "specifier", path),
      `${path}.specifier`,
    );

    let importerKeys = keys.get(importer);
    if (!importerKeys) {
      importerKeys = new Set<string>();
      keys.set(importer, importerKeys);
    }
    if (importerKeys.has(specifier)) {
      throw new ArtifactFormatError(path, "duplicate importer/specifier resolution");
    }
    importerKeys.add(specifier);

    const target = parseTarget(requiredField(resolution, "target", path), `${path}.target`);
    if (target.kind === "module" && !moduleIds.has(target.id)) {
      throw new ArtifactFormatError(`${path}.target.id`, `unknown module ${JSON.stringify(target.id)}`);
    }
    parsed.push({ importer, specifier, target });
  }
  return parsed;
}

function parseTarget(value: unknown, path: string): ArtifactResolutionTarget {
  const target = requireObject(value, path, "an object");
  const kind = requiredField(target, "kind", path);
  if (kind === "module") {
    assertExactFields(target, ["kind", "id"], path);
    return {
      kind,
      id: requireNonEmptyString(requiredField(target, "id", path), `${path}.id`),
    };
  }
  if (kind === "external") {
    assertExactFields(target, ["kind", "specifier"], path);
    return {
      kind,
      specifier: requireNonEmptyString(
        requiredField(target, "specifier", path),
        `${path}.specifier`,
      ),
    };
  }
  throw new ArtifactFormatError(`${path}.kind`, 'expected "module" or "external"');
}

const INPUT_DIGEST = /^sha256:[0-9a-f]{64}$/;

function parseInputs(value: unknown): ArtifactInput[] {
  if (!Array.isArray(value)) throw new ArtifactFormatError("$.inputs", "expected an array");
  const parsed: ArtifactInput[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `$.inputs[${index}]`;
    if (!hasOwn(value, index)) {
      throw new ArtifactFormatError(path, "sparse array entries are not allowed");
    }
    const entry: unknown = value[index];
    const input = requireObject(entry, path, "an object");
    assertExactFields(input, ["path", "digest"], path);

    const inputPath = requiredField(input, "path", path);
    if (typeof inputPath !== "string" || !isInputPath(inputPath)) {
      throw new ArtifactFormatError(
        `${path}.path`,
        'expected a "/"-separated project-relative path, optionally prefixed with "workspace:", ' +
          'without empty, ".", or ".." segments, backslashes, or other colons',
      );
    }
    const previous = parsed.at(-1);
    if (previous !== undefined && compareStrings(previous.path, inputPath) >= 0) {
      throw new ArtifactFormatError(`${path}.path`, "inputs must be strictly ascending by path");
    }

    const digest = requiredField(input, "digest", path);
    if (typeof digest !== "string" || !INPUT_DIGEST.test(digest)) {
      throw new ArtifactFormatError(
        `${path}.digest`,
        "expected \"sha256:\" followed by 64 lowercase hex characters",
      );
    }
    parsed.push({ path: inputPath, digest });
  }
  return parsed;
}

function isInputPath(value: string): boolean {
  if (value.startsWith(WORKSPACE_INPUT_PREFIX)) {
    return isProjectRelativePath(value.slice(WORKSPACE_INPUT_PREFIX.length));
  }
  return isProjectRelativePath(value);
}

function isProjectRelativePath(value: string): boolean {
  if (value.includes("\\") || value.includes(":")) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseModuleKind(value: unknown, path: string): ArtifactModuleKind {
  if (
    value === "js" ||
    value === "ts" ||
    value === "jsx" ||
    value === "tsx" ||
    value === "json" ||
    value === "astro" ||
    value === "css"
  ) {
    return value;
  }
  throw new ArtifactFormatError(path, "unsupported module kind");
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ArtifactFormatError(path, "expected an array");
  const parsed: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!hasOwn(value, index)) {
      throw new ArtifactFormatError(`${path}[${index}]`, "sparse array entries are not allowed");
    }
    const entry: unknown = value[index];
    if (typeof entry !== "string") {
      throw new ArtifactFormatError(`${path}[${index}]`, "expected a string");
    }
    parsed.push(entry);
  }
  return parsed;
}

function canonicalConfig(config: ArtifactConfig): ArtifactConfig {
  const canonical: ArtifactConfig = {};
  if (config.site !== undefined) canonical.site = config.site;
  if (config.markdown !== undefined) canonical.markdown = canonicalMarkdown(config.markdown);
  if (config.i18n !== undefined) canonical.i18n = canonicalI18n(config.i18n);
  if (config.trailingSlash !== undefined) canonical.trailingSlash = config.trailingSlash;
  if (config.redirects !== undefined) {
    canonical.redirects = config.redirects.map((redirect) => ({
      source: redirect.source,
      destination: redirect.destination,
      status: redirect.status,
    }));
  }
  return canonical;
}

function canonicalI18n(i18n: ArtifactI18nConfig): ArtifactI18nConfig {
  const canonical: ArtifactI18nConfig = {
    defaultLocale: i18n.defaultLocale,
    locales: i18n.locales.map((locale) =>
      typeof locale === "string" ? locale : { path: locale.path, codes: [...locale.codes] },
    ),
  };
  if (i18n.routing !== undefined) {
    const { prefixDefaultLocale, redirectToDefaultLocale, fallbackType } = i18n.routing;
    canonical.routing = {};
    if (prefixDefaultLocale !== undefined) canonical.routing.prefixDefaultLocale = prefixDefaultLocale;
    if (redirectToDefaultLocale !== undefined) canonical.routing.redirectToDefaultLocale = redirectToDefaultLocale;
    if (fallbackType !== undefined) canonical.routing.fallbackType = fallbackType;
  }
  if (i18n.fallback !== undefined) {
    const { fallback } = i18n;
    const locales = Object.keys(fallback).sort(compareStrings);
    canonical.fallback = Object.fromEntries(locales.map((locale): [string, string] => [locale, fallback[locale]]));
  }
  return canonical;
}

function canonicalMarkdown(markdown: ArtifactMarkdownConfig): ArtifactMarkdownConfig {
  // Plugin order is semantic: the pipeline runs them as listed.
  const plugin = (entry: PortablePlugin): PortablePlugin =>
    entry.options === undefined
      ? { module: entry.module, export: entry.export }
      : { module: entry.module, export: entry.export, options: canonicalJson(entry.options) };
  const canonical: ArtifactMarkdownConfig = {
    remarkPlugins: markdown.remarkPlugins.map(plugin),
    rehypePlugins: markdown.rehypePlugins.map(plugin),
  };
  if (markdown.remarkRehype !== undefined) {
    const options = canonicalJson(markdown.remarkRehype);
    if (isJsonObject(options)) canonical.remarkRehype = options;
  }
  if (markdown.gfm !== undefined) canonical.gfm = markdown.gfm;
  return canonical;
}

function canonicalModule(module: ArtifactModule): ArtifactModule {
  return module.compilePath === undefined
    ? { id: module.id, kind: module.kind, source: module.source }
    : {
        id: module.id,
        kind: module.kind,
        source: module.source,
        compilePath: module.compilePath,
      };
}

function canonicalResolutions(resolutions: readonly ArtifactResolution[]): ArtifactResolution[] {
  return [...resolutions]
    .sort((left, right) => {
      const importerOrder = compareStrings(left.importer, right.importer);
      return importerOrder === 0 ? compareStrings(left.specifier, right.specifier) : importerOrder;
    })
    .map(canonicalResolution);
}

function canonicalResolution(resolution: ArtifactResolution): ArtifactResolution {
  const target: ArtifactResolutionTarget =
    resolution.target.kind === "module"
      ? { kind: "module", id: resolution.target.id }
      : { kind: "external", specifier: resolution.target.specifier };
  return {
    importer: resolution.importer,
    specifier: resolution.specifier,
    target,
  };
}

function requireObject(value: unknown, path: string, expected: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactFormatError(path, `expected ${expected}`);
  }
  return value;
}

function requiredField(value: object, field: string, path: string): unknown {
  if (!hasOwn(value, field)) {
    throw new ArtifactFormatError(`${path}.${field}`, "missing required field");
  }
  return Reflect.get(value, field);
}

function assertExactFields(value: object, allowed: readonly string[], path: string): void {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new ArtifactFormatError(`${path}.${field}`, "unknown field");
    }
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactFormatError(path, "expected a non-empty string");
  }
  return value;
}

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}
