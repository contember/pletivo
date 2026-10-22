/**
 * The files `pletivo prepare` records in `PreparedSite.inputs`. A host that reads the
 * project through another filesystem computes them with the same functions, so its
 * inputs match the CLI's byte for byte.
 */

import yaml from "js-yaml";
import { WORKSPACE_INPUT_PREFIX, digestArtifactInput, type ArtifactInput } from "./artifact";
import { compareStrings } from "./compare-strings";
import { escapeRegex } from "./escape-regex";

/** `bun.lockb` is binary and superseded by `bun.lock`; it is deliberately not recorded. */
export const RECORDED_LOCKFILES = ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/** Recorded from the site root. */
export const PACKAGE_INPUT_FILES = ["package.json", ...RECORDED_LOCKFILES] as const;

/** Recorded from the workspace root, under `WORKSPACE_INPUT_PREFIX`. */
export const WORKSPACE_INPUT_FILES = [...PACKAGE_INPUT_FILES, "pnpm-workspace.yaml"] as const;

/** In lookup order: the first that exists is the config the CLI loads and records. */
export const ASTRO_CONFIG_FILES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.mjs",
  "astro.config.js",
] as const;
export const PLETIVO_CONFIG_FILES = ["pletivo.config.ts", "pletivo.config.js"] as const;

/** A site that has one of these owns its dependency install. */
const INSTALL_LOCKFILES = [...RECORDED_LOCKFILES, "bun.lockb"];

/**
 * The bytes of the regular file at `path`, `/`-separated and relative to the directory
 * the reader serves, or `null` when there is no such file.
 */
export type InputFileReader = (path: string) => Promise<Uint8Array | null>;

export interface PrepareInputOptions {
  /** Reads the directory that `findWorkspaceRoot` returned for the site. */
  workspaceRoot?: InputFileReader;
}

/** Digest the site's package files and configs, and the workspace root's package files. */
export async function readPrepareInputs(
  site: InputFileReader,
  options: PrepareInputOptions = {},
): Promise<ArtifactInput[]> {
  const inputs: ArtifactInput[] = [];
  async function record(read: InputFileReader, file: string, path: string): Promise<boolean> {
    const bytes = await read(file);
    if (bytes === null) return false;
    inputs.push({ path, digest: await digestArtifactInput(bytes) });
    return true;
  }

  for (const file of PACKAGE_INPUT_FILES) await record(site, file, file);
  for (const candidates of [ASTRO_CONFIG_FILES, PLETIVO_CONFIG_FILES]) {
    for (const file of candidates) {
      if (await record(site, file, file)) break;
    }
  }
  const { workspaceRoot } = options;
  if (workspaceRoot !== undefined) {
    for (const file of WORKSPACE_INPUT_FILES) {
      await record(workspaceRoot, file, WORKSPACE_INPUT_PREFIX + file);
    }
  }
  return inputs.sort((left, right) => compareStrings(left.path, right.path));
}

/**
 * The workspace the site is a member of: the nearest directory above `sitePath` whose
 * `package.json` `workspaces` or `pnpm-workspace.yaml` `packages` match the site.
 *
 * Paths are `/`-separated and relative to the top of the search, which the caller picks
 * (a repository root, a store root); `""` is the top itself. `null` when the site has no
 * `package.json`, owns its install (a lockfile, or workspaces of its own), or no
 * directory up to the top lists it.
 */
export async function findWorkspaceRoot(
  sitePath: string,
  readerAt: (directory: string) => InputFileReader,
): Promise<string | null> {
  const site = readerAt(sitePath);
  if ((await site("package.json")) === null) return null;
  for (const file of INSTALL_LOCKFILES) {
    if ((await site(file)) !== null) return null;
  }
  if ((await workspacePatterns(site)) !== null) return null;

  let directory = sitePath;
  while (directory !== "") {
    directory = parentDirectory(directory);
    const patterns = await workspacePatterns(readerAt(directory));
    const memberPath = directory === "" ? sitePath : sitePath.slice(directory.length + 1);
    if (patterns !== null && listsMember(patterns, memberPath)) return directory;
  }
  return null;
}

/** The member globs a directory declares, or `null` when it declares none. */
async function workspacePatterns(read: InputFileReader): Promise<string[] | null> {
  const declared: string[][] = [];
  const manifest = await read("package.json");
  if (manifest !== null) {
    const workspaces = fieldOf(parseDocument(manifest, JSON.parse), "workspaces");
    const patterns = stringArray(workspaces) ?? stringArray(fieldOf(workspaces, "packages"));
    if (patterns !== null) declared.push(patterns);
  }
  const pnpmWorkspace = await read("pnpm-workspace.yaml");
  if (pnpmWorkspace !== null) {
    const patterns = stringArray(fieldOf(parseDocument(pnpmWorkspace, yaml.load), "packages"));
    if (patterns !== null) declared.push(patterns);
  }
  return declared.length === 0 ? null : declared.flat();
}

/**
 * The document, or `undefined` when it does not parse: a broken manifest in an
 * unrelated directory must not fail the site's prepare.
 */
function parseDocument(bytes: Uint8Array, parse: (source: string) => unknown): unknown {
  try {
    return parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, field);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") strings.push(entry);
  }
  return strings;
}

/** Whether a `!`-negatable glob list includes `memberPath`, as package managers read it. */
function listsMember(patterns: readonly string[], memberPath: string): boolean {
  let listed = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith("!");
    if (globRegex(excluded ? pattern.slice(1) : pattern).test(memberPath)) {
      if (excluded) return false;
      listed = true;
    }
  }
  return listed;
}

/** `*` and `?` stay within a segment, `**` spans segments, `{a,b}` is an alternation. */
function globRegex(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      index++;
      if (pattern.charAt(index + 1) === "/") {
        index++;
        source += "(?:[^/]+/)*";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{" && pattern.indexOf("}", index) !== -1) {
      const end = pattern.indexOf("}", index);
      source += `(?:${pattern.slice(index + 1, end).split(",").map(escapeRegex).join("|")})`;
      index = end;
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function parentDirectory(directory: string): string {
  const at = directory.lastIndexOf("/");
  return at === -1 ? "" : directory.slice(0, at);
}
