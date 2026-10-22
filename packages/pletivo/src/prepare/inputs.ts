/** Record the project files `pletivo prepare` was prepared from. */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactInput } from "@pletivo/core/artifact";
import { findWorkspaceRoot, readPrepareInputs, type InputFileReader } from "@pletivo/core/prepare-inputs";
import { isMissingFile } from "./paths";

export async function readProjectInputs(projectRoot: string): Promise<ArtifactInput[]> {
  const site = fileReader(projectRoot);
  const workspaceRoot = await findWorkspaceRoot(site, repositoryAncestors(projectRoot), fileReader);
  return readPrepareInputs(site, workspaceRoot === null ? {} : { workspaceRoot: fileReader(workspaceRoot) });
}

/**
 * The parents of `directory`, closest first, up to the first that holds `.git` or the
 * filesystem root. The search never leaves the repository the site is checked out in.
 */
function* repositoryAncestors(directory: string): Generator<string> {
  let current = directory;
  while (!existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    yield current;
  }
}

function fileReader(directory: string): InputFileReader {
  return (file) => readOptionalFile(path.join(directory, file));
}

async function readOptionalFile(file: string): Promise<Uint8Array | null> {
  try {
    if (!(await fs.stat(file)).isFile()) return null;
    return await fs.readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
