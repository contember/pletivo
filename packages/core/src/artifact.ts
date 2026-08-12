/**
 * What the config/integration phase leaves behind for a host that cannot run it.
 *
 * `astro:config:setup` is arbitrary Node code: it reads the filesystem, resolves npm
 * packages and hands back live function values. A Worker Loader isolate has none of
 * those, so the phase runs ahead of time on Bun — `pletivo prepare` — and what it
 * produces is frozen into the two halves below.
 *
 * The split is not arbitrary. Everything that reaches render time is either **data**
 * (config fields, injected script bodies) or a **module body** (a vendored npm
 * package, a frozen virtual module, an `.astro` file that lives in `node_modules`).
 * Astro's own `SSRManifest` reached the same conclusion — it freezes scripts as
 * strings and carries no Vite plugins at all.
 *
 * This module is the contract, and nothing more: the producer is
 * `packages/pletivo/src/prepare`, the consumer is `packages/workers/src/artifact.ts`.
 * It lives in `@pletivo/core` because both ends need it and neither may depend on the
 * other.
 */

/**
 * Bumped whenever a consumer would misread an older artifact. A host that does not
 * know the version refuses it, rather than rendering a page quietly missing an
 * integration — the failure mode `docs/todos/017 §4` is the cautionary precedent for.
 */
export const ARTIFACT_VERSION = 1;

/** Config fields that survive freezing and are read at render time. */
export interface ArtifactConfig {
  /** `site` from `astro.config.*`. Sets the origin of `Astro.url`. */
  site?: string;
  /** Always `"/"` for now — the Workers host hard-codes it, and prepare says so. */
  base: string;
  trailingSlash: "always" | "never" | "ignore";
  build: { format: "file" | "directory" | "preserve" };
}

/**
 * `injectScript()` bodies, already TS-stripped when they were injected.
 *
 * Emitted verbatim in the order `build.ts` emits them: head-inline as `<script>`,
 * page as `<script type="module">`, then before-hydration — which is moot until the
 * Workers host has islands, and is carried anyway so it is not lost.
 */
export interface InjectedScripts {
  headInline: string[];
  page: string[];
  beforeHydration: string[];
}

/** Something prepare saw and could not carry across, named at the point it was seen. */
export interface ArtifactDiagnostic {
  /** Integration name, package name or project path — whatever identifies the source. */
  source: string;
  /** The hook or mechanism it came through, e.g. `astro:config:setup`. */
  hook: string;
  reason: string;
}

/**
 * The data half. Small, diffable, and safe to read before any module is loaded.
 *
 * The three specifier maps all answer the same question — "what module does this
 * import land on?" — and their values are read the same way: first as a path in
 * `generatedSources` (or in the caller's own file map), then as a key of
 * `ArtifactModules`. One rule, so a vendored package and a package's `.astro` file
 * are named the same way.
 */
export interface SiteArtifact {
  version: number;
  /** Content address of the whole artifact. Names it in logs and in the isolate id. */
  id: string;

  config: ArtifactConfig;
  scripts: InjectedScripts;

  /**
   * Frozen Vite virtual modules: the specifier a source writes -> what answers it.
   * `virtual:astro-icon` is the canonical one — its `load()` returns a JSON literal.
   */
  virtualModules: Record<string, string>;

  /**
   * Bare npm specifiers -> what answers them, plus the relative specifiers inside a
   * vendored package that need redirecting (TypeScript's `./cache.js` naming a
   * `cache.ts`, which no file-map lookup would find).
   */
  vendor: Record<string, string>;

  /**
   * Extra sources compiled as if they were project files, keyed by the path they
   * must be compiled *at* — an `.astro` component in `node_modules` derives its
   * `astro-{scope}` hash from its filename, so the two hosts have to spell it the
   * same way or every scoped rule on the page misses.
   */
  generatedSources: Record<string, string>;

  diagnostics: ArtifactDiagnostic[];
}

/** Module name -> JavaScript. Merged into the bundle the isolate runs, same as `GENERATED_MODULES`. */
export type ArtifactModules = Readonly<Record<string, string>>;

/** The two halves together, which is how every consumer takes them. */
export interface PreparedSite {
  artifact: SiteArtifact;
  modules: ArtifactModules;
}

/** An artifact this build cannot read. */
export class ArtifactVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `[pletivo] this site artifact is version ${found}, and this host reads version ` +
        `${ARTIFACT_VERSION}. Re-run \`pletivo prepare\`.`,
    );
    this.name = "ArtifactVersionError";
  }
}

/** Refuse an artifact from a different generation rather than half-reading it. */
export function assertArtifactVersion(artifact: { version: number }): void {
  if (artifact.version !== ARTIFACT_VERSION) throw new ArtifactVersionError(artifact.version);
}

/**
 * Read a `PreparedSite` out of parsed JSON, or `null`.
 *
 * For a host that ships the artifact out of band — R2, KV, a request body — rather
 * than through its bundler. Shallow on purpose: it checks the shape a consumer
 * indexes into, and the version, which is the thing that actually goes wrong.
 */
export function parsePreparedSite(value: unknown): PreparedSite | null {
  if (typeof value !== "object" || value === null) return null;
  const artifact: unknown = Reflect.get(value, "artifact");
  const modules: unknown = Reflect.get(value, "modules");
  if (!isStringRecord(modules)) return null;
  if (typeof artifact !== "object" || artifact === null) return null;

  const version: unknown = Reflect.get(artifact, "version");
  const id: unknown = Reflect.get(artifact, "id");
  const config: unknown = Reflect.get(artifact, "config");
  const scripts: unknown = Reflect.get(artifact, "scripts");
  const virtualModules: unknown = Reflect.get(artifact, "virtualModules");
  const vendor: unknown = Reflect.get(artifact, "vendor");
  const generatedSources: unknown = Reflect.get(artifact, "generatedSources");
  const diagnostics: unknown = Reflect.get(artifact, "diagnostics");
  if (typeof version !== "number" || typeof id !== "string") return null;
  if (!isArtifactConfig(config) || !isInjectedScripts(scripts)) return null;
  if (!isStringRecord(virtualModules) || !isStringRecord(vendor)) return null;
  if (!isStringRecord(generatedSources) || !Array.isArray(diagnostics)) return null;

  return {
    artifact: {
      version,
      id,
      config,
      scripts,
      virtualModules,
      vendor,
      generatedSources,
      diagnostics: diagnostics.filter(isDiagnostic),
    },
    modules,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isArtifactConfig(value: unknown): value is ArtifactConfig {
  if (typeof value !== "object" || value === null) return false;
  const site: unknown = Reflect.get(value, "site");
  const base: unknown = Reflect.get(value, "base");
  const trailingSlash: unknown = Reflect.get(value, "trailingSlash");
  const build: unknown = Reflect.get(value, "build");
  if (site !== undefined && typeof site !== "string") return false;
  if (typeof base !== "string") return false;
  if (trailingSlash !== "always" && trailingSlash !== "never" && trailingSlash !== "ignore") {
    return false;
  }
  if (typeof build !== "object" || build === null) return false;
  const format: unknown = Reflect.get(build, "format");
  return format === "file" || format === "directory" || format === "preserve";
}

function isInjectedScripts(value: unknown): value is InjectedScripts {
  if (typeof value !== "object" || value === null) return false;
  return (
    isStringArray(Reflect.get(value, "headInline")) &&
    isStringArray(Reflect.get(value, "page")) &&
    isStringArray(Reflect.get(value, "beforeHydration"))
  );
}

function isDiagnostic(value: unknown): value is ArtifactDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "source") === "string" &&
    typeof Reflect.get(value, "hook") === "string" &&
    typeof Reflect.get(value, "reason") === "string"
  );
}

/** The config a project with no `astro.config.*` — and therefore no artifact — has. */
export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
  base: "/",
  trailingSlash: "ignore",
  build: { format: "directory" },
};
