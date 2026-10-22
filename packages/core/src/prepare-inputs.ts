/**
 * The files `pletivo prepare` records in `PreparedSite.inputs`. A host that reads the
 * project through another filesystem computes them with the same functions, so its
 * inputs match the CLI's byte for byte.
 */

import { WORKSPACE_INPUT_PREFIX, digestArtifactInput, type ArtifactInput } from "./artifact";

/** `bun.lockb` is binary and superseded by `bun.lock`; it is deliberately not recorded. */
export const RECORDED_LOCKFILES = ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/** Recorded from the site root, and from its workspace root under `WORKSPACE_INPUT_PREFIX`. */
export const PACKAGE_INPUT_FILES = ["package.json", ...RECORDED_LOCKFILES] as const;

/** In lookup order: the first that exists is the config the CLI loads and records. */
export const ASTRO_CONFIG_FILES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.mjs",
  "astro.config.js",
] as const;
export const PLETIVO_CONFIG_FILES = ["pletivo.config.ts", "pletivo.config.js"] as const;

/** A directory that has one of these owns its dependency install. */
const INSTALL_LOCKFILES = [...RECORDED_LOCKFILES, "bun.lockb"];

/**
 * The bytes of the regular file at `path`, `/`-separated and relative to the directory
 * the reader serves, or `null` when there is no such file.
 */
export type InputFileReader = (path: string) => Promise<Uint8Array | null>;

export interface PrepareInputOptions {
  /** Reads the workspace root that `findWorkspaceRoot` returned for the site. */
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
    for (const file of PACKAGE_INPUT_FILES) {
      await record(workspaceRoot, file, WORKSPACE_INPUT_PREFIX + file);
    }
  }
  return inputs.sort((left, right) => compareStrings(left.path, right.path));
}

/**
 * The nearest of `ancestors` (closest first) that owns the site's install, or `null`
 * when the site owns it itself or no ancestor does. The caller bounds `ancestors`.
 */
export async function findWorkspaceRoot(
  site: InputFileReader,
  ancestors: Iterable<string>,
  readerAt: (directory: string) => InputFileReader,
): Promise<string | null> {
  if (await isInstallRoot(site)) return null;
  for (const directory of ancestors) {
    if (await isInstallRoot(readerAt(directory))) return directory;
  }
  return null;
}

/** A directory owns its install when it has a lockfile or a `package.json` with `workspaces`. */
async function isInstallRoot(read: InputFileReader): Promise<boolean> {
  for (const file of INSTALL_LOCKFILES) {
    if ((await read(file)) !== null) return true;
  }
  const manifest = await read("package.json");
  return manifest !== null && declaresWorkspaces(manifest);
}

function declaresWorkspaces(manifest: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifest));
  } catch (error) {
    // An unrelated ancestor's broken manifest must not fail the site's prepare.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return typeof parsed === "object" && parsed !== null && "workspaces" in parsed;
}

/** Code-unit order, independent of locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
