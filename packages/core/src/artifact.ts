/** Serialized executable input shared by `pletivo prepare` and non-Bun hosts. */

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

/** One importer-aware answer for a source import. */
export interface ArtifactResolution {
  importer: ModuleId;
  specifier: string;
  target: ArtifactResolutionTarget;
}

/** Config fields the Workers host currently consumes. */
export interface ArtifactConfig {
  site?: string;
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
}

/** Producer/consumer envelope kept distinct from the prepare report. */
export interface PreparedSite {
  artifact: SiteArtifact;
}

export type PrepareDiagnosticSeverity = "fatal" | "warning";

export interface PrepareDiagnostic {
  severity: PrepareDiagnosticSeverity;
  source: string;
  hook: string;
  reason: string;
}

/** Non-executable producer output that never participates in program identity. */
export interface PrepareReport {
  diagnostics: PrepareDiagnostic[];
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

/** A malformed V2 artifact, named at the invalid field. */
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

/** Parse and fully validate a V2 producer/consumer envelope. */
export function parsePreparedSite(value: unknown): PreparedSite {
  const prepared = requireObject(value, "$", "an object");
  const artifact = requireObject(requiredField(prepared, "artifact", "$"), "$.artifact", "an object");

  const version = requiredField(artifact, "version", "$.artifact");
  if (typeof version !== "number") {
    throw new ArtifactFormatError("$.artifact.version", "expected a number");
  }
  assertArtifactVersion({ version });

  assertExactFields(prepared, ["artifact"], "$");
  assertExactFields(
    artifact,
    ["version", "config", "scripts", "modules", "resolutions"],
    "$.artifact",
  );

  const config = parseConfig(requiredField(artifact, "config", "$.artifact"));
  const scripts = parseScripts(requiredField(artifact, "scripts", "$.artifact"));
  const modules = parseModules(requiredField(artifact, "modules", "$.artifact"));
  const resolutions = parseResolutions(
    requiredField(artifact, "resolutions", "$.artifact"),
    modules,
  );

  return {
    artifact: {
      version: ARTIFACT_VERSION,
      config,
      scripts,
      modules,
      resolutions,
    },
  };
}

/** Serialize V2 with stable object, module, and resolution ordering. */
export function serializePreparedSite(value: unknown): string {
  const prepared = parsePreparedSite(value);
  const modules = [...prepared.artifact.modules].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const resolutions = [...prepared.artifact.resolutions].sort((left, right) => {
    const importerOrder = compareStrings(left.importer, right.importer);
    return importerOrder === 0
      ? compareStrings(left.specifier, right.specifier)
      : importerOrder;
  });

  const canonical: PreparedSite = {
    artifact: {
      version: ARTIFACT_VERSION,
      config: canonicalConfig(prepared.artifact.config),
      scripts: {
        headInline: [...prepared.artifact.scripts.headInline],
        page: [...prepared.artifact.scripts.page],
      },
      modules: modules.map(canonicalModule),
      resolutions: resolutions.map(canonicalResolution),
    },
  };
  return JSON.stringify(canonical);
}

function parseConfig(value: unknown): ArtifactConfig {
  const config = requireObject(value, "$.artifact.config", "an object");
  assertExactFields(config, ["site"], "$.artifact.config");
  if (!hasOwn(config, "site")) return {};
  const site = Reflect.get(config, "site");
  if (typeof site !== "string") {
    throw new ArtifactFormatError("$.artifact.config.site", "expected a string");
  }
  return { site };
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

function parseResolutions(value: unknown, modules: readonly ArtifactModule[]): ArtifactResolution[] {
  if (!Array.isArray(value)) {
    throw new ArtifactFormatError("$.artifact.resolutions", "expected an array");
  }

  const moduleIds = new Set(modules.map((module) => module.id));
  const keys = new Map<string, Set<string>>();

  const parsed: ArtifactResolution[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `$.artifact.resolutions[${index}]`;
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
  return config.site === undefined ? {} : { site: config.site };
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The config a project with no prepared Astro config has. */
export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {};
