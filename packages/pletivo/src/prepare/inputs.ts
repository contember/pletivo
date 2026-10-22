/** Record the project files `pletivo prepare` was prepared from. */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactInput } from "@pletivo/core/artifact";
import { findWorkspaceRoot, readPrepareInputs, type InputFileReader } from "@pletivo/core/prepare-inputs";
import { isMissingFile, normalizePath } from "./paths";

/** `projectRoot` is a real path: a symlinked site is looked up where it really lives. */
export async function readProjectInputs(projectRoot: string): Promise<ArtifactInput[]> {
  const site = fileReader(projectRoot);
  const top = repositoryRoot(projectRoot);
  const workspaceRoot = await findWorkspaceRoot(normalizePath(path.relative(top, projectRoot)), (directory) =>
    fileReader(path.join(top, directory)),
  );
  return readPrepareInputs(
    site,
    workspaceRoot === null ? {} : { workspaceRoot: fileReader(path.join(top, workspaceRoot)) },
  );
}

/**
 * The nearest directory at or above `directory` that holds `.git`, else the filesystem
 * root. The workspace search never leaves the repository the site is checked out in.
 */
function repositoryRoot(directory: string): string {
  let current = directory;
  while (!existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
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
