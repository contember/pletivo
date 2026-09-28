/** Record the project files `pletivo prepare` was prepared from. */

import fs from "node:fs/promises";
import path from "node:path";
import { digestArtifactInput, type ArtifactInput } from "@pletivo/core/artifact";
import { findAstroConfig } from "../astro-host/config-loader";
import { findPletivoConfig } from "../config";

/** `bun.lockb` is binary and superseded by `bun.lock`; it is deliberately not recorded. */
const OPTIONAL_INPUTS = ["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

export async function readPrepareInputs(projectRoot: string): Promise<ArtifactInput[]> {
  const files = OPTIONAL_INPUTS.map((name) => path.join(projectRoot, name));
  for (const config of [findAstroConfig(projectRoot), findPletivoConfig(projectRoot)]) {
    if (config !== null) files.push(config);
  }

  const inputs: ArtifactInput[] = [];
  for (const file of files) {
    const bytes = await readOptionalFile(file);
    if (bytes === null) continue;
    inputs.push({
      path: path.relative(projectRoot, file).split(path.sep).join("/"),
      digest: await digestArtifactInput(bytes),
    });
  }
  return inputs.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function readOptionalFile(file: string): Promise<Uint8Array | null> {
  try {
    if (!(await fs.stat(file)).isFile()) return null;
    return await fs.readFile(file);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return null;
    }
    throw error;
  }
}
