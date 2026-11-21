/**
 * `astro:env` for the Bun host: the Astro config's `env.schema`, parsed once, and the modules
 * `astro:env/client` and `astro:env/server` built from it. A public variable is validated and
 * typed as Astro's `validateEnvVariable` does when its module is built; a secret one is read
 * from `process.env` when the page reads it, falling back to its default, unvalidated.
 */

type EnvFieldKind =
  | { type: "string"; max?: number; min?: number; length?: number; url?: boolean; includes?: string; startsWith?: string; endsWith?: string }
  | { type: "number"; gt?: number; min?: number; lt?: number; max?: number; int?: boolean }
  | { type: "boolean" }
  | { type: "enum"; values: string[] };

export type EnvValue = string | number | boolean | undefined;

export interface EnvField {
  name: string;
  context: "client" | "server";
  access: "public" | "secret";
  optional: boolean;
  default: EnvValue;
  kind: EnvFieldKind;
}

/** Parse the config's `env.schema` as Astro's `envField` helpers write it. Throws on a field they cannot produce. */
export function parseEnvConfig(env: unknown): EnvField[] {
  if (env === undefined) return [];
  if (!isRecord(env)) throw new Error("astro config: env must be an object");
  const schema = env.schema;
  if (schema === undefined) return [];
  if (!isRecord(schema)) throw new Error("astro config: env.schema must be an object");
  return Object.entries(schema).map(([name, field]) => parseField(name, field));
}

function parseField(name: string, field: unknown): EnvField {
  const at = `astro config: env.schema.${name}`;
  if (!isRecord(field)) throw new Error(`${at} must be an envField`);
  const context = field.context;
  const access = field.access;
  if (context !== "client" && context !== "server") throw new Error(`${at}.context must be "client" or "server"`);
  if (access !== "public" && access !== "secret") throw new Error(`${at}.access must be "public" or "secret"`);
  if (context === "client" && access === "secret") throw new Error(`${at}: a client variable cannot be secret`);
  const optional = field.optional ?? false;
  if (typeof optional !== "boolean") throw new Error(`${at}.optional must be a boolean`);
  const fallback = field.default;
  if (fallback !== undefined && typeof fallback !== "string" && typeof fallback !== "number" && typeof fallback !== "boolean") {
    throw new Error(`${at}.default must be a string, a number or a boolean`);
  }
  return { name, context, access, optional, default: fallback, kind: parseKind(field, at) };
}

function parseKind(field: Record<string, unknown>, at: string): EnvFieldKind {
  const number = (key: string): number | undefined => {
    const value = field[key];
    if (value !== undefined && typeof value !== "number") throw new Error(`${at}.${key} must be a number`);
    return value;
  };
  const text = (key: string): string | undefined => {
    const value = field[key];
    if (value !== undefined && typeof value !== "string") throw new Error(`${at}.${key} must be a string`);
    return value;
  };
  const flag = (key: string): boolean | undefined => {
    const value = field[key];
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${at}.${key} must be a boolean`);
    return value;
  };
  switch (field.type) {
    case "string":
      return {
        type: "string", max: number("max"), min: number("min"), length: number("length"), url: flag("url"),
        includes: text("includes"), startsWith: text("startsWith"), endsWith: text("endsWith"),
      };
    case "number":
      return { type: "number", gt: number("gt"), min: number("min"), lt: number("lt"), max: number("max"), int: flag("int") };
    case "boolean":
      return { type: "boolean" };
    case "enum": {
      const values = field.values;
      if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) throw new Error(`${at}.values must be strings`);
      return { type: "enum", values };
    }
    default:
      throw new Error(`${at}.type must be "string", "number", "boolean" or "enum"`);
  }
}

type Validation = { ok: true; value: EnvValue } | { ok: false; errors: string[] };

/** Astro's `validateEnvVariable`. */
export function validateEnvVariable(input: string | undefined, field: EnvField): Validation {
  const optional = field.optional || field.default !== undefined;
  if (input === undefined) return optional ? { ok: true, value: field.default } : { ok: false, errors: ["missing"] };
  const { kind } = field;
  switch (kind.type) {
    case "string": {
      const errors: string[] = [];
      if (kind.max !== undefined && !(input.length <= kind.max)) errors.push("max");
      if (kind.min !== undefined && !(input.length >= kind.min)) errors.push("min");
      if (kind.length !== undefined && !(input.length === kind.length)) errors.push("length");
      if (kind.url !== undefined && !URL.canParse(input)) errors.push("url");
      if (kind.includes !== undefined && !input.includes(kind.includes)) errors.push("includes");
      if (kind.startsWith !== undefined && !input.startsWith(kind.startsWith)) errors.push("startsWith");
      if (kind.endsWith !== undefined && !input.endsWith(kind.endsWith)) errors.push("endsWith");
      return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
    }
    case "number": {
      const num = parseFloat(input);
      if (isNaN(num)) return { ok: false, errors: ["type"] };
      const errors: string[] = [];
      if (kind.gt !== undefined && !(num > kind.gt)) errors.push("gt");
      if (kind.min !== undefined && !(num >= kind.min)) errors.push("min");
      if (kind.lt !== undefined && !(num < kind.lt)) errors.push("lt");
      if (kind.max !== undefined && !(num <= kind.max)) errors.push("max");
      if (kind.int !== undefined && Number.isInteger(num) !== kind.int) errors.push("int");
      return errors.length > 0 ? { ok: false, errors } : { ok: true, value: num };
    }
    case "boolean":
      return input === "true" ? { ok: true, value: true } : input === "false" ? { ok: true, value: false } : { ok: false, errors: ["type"] };
    case "enum":
      return kind.values.includes(input) ? { ok: true, value: input } : { ok: false, errors: ["type"] };
  }
}

/**
 * The source of `astro:env/client` (its public client variables) or `astro:env/server` (every
 * variable). Throws, as Astro's `EnvInvalidVariables`, when a public variable is invalid.
 */
export function envModuleSource(fields: readonly EnvField[], context: "client" | "server", env: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    // Astro's server module has server variables only; pletivo's, and the Workers host's, has all.
    if (context === "client" && field.context !== "client") continue;
    if (field.access === "secret") {
      lines.push(`export const ${field.name} = process.env[${JSON.stringify(field.name)}] || ${JSON.stringify(field.default)};`);
      continue;
    }
    const input = env[field.name];
    const result = validateEnvVariable(input === "" ? undefined : input, field);
    if (result.ok) lines.push(`export const ${field.name} = ${JSON.stringify(result.value)};`);
    else invalid.push(invalidMessage(field, result.errors));
  }
  if (invalid.length > 0) {
    throw new Error(`The following environment variables defined in \`env.schema\` are invalid:\n\n${invalid.map((error) => `- ${error}`).join("\n")}\n`);
  }
  return lines.length > 0 ? lines.join("\n") : "export {};";
}

/** Astro's `invalidVariablesToError`, one variable. */
function invalidMessage(field: EnvField, errors: string[]): string {
  if (errors[0] === "missing") return `${field.name} is missing`;
  if (errors[0] === "type") {
    const type = field.kind.type === "enum" ? field.kind.values.map((value) => `'${value}'`).join(" | ") : field.kind.type;
    return `${field.name}'s type is invalid, expected: ${type}`;
  }
  return `The following constraints for ${field.name} are not met: ${errors.join(", ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
