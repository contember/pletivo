/**
 * Renderer setup reads Astro's prebuilt island scripts from the project's own `astro`, and fails
 * by name when they are not there, leaving no renderer wired.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { setupAstroRenderers } from "../../packages/pletivo/src/astro-renderers";

let project = "";

beforeEach(async () => {
  // Outside the repo, so `astro` resolves only to what a test puts in the project.
  project = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-renderer-setup-"));
  await fs.writeFile(
    path.join(project, "server.mjs"),
    "export default { check: () => false, renderToStaticMarkup: async () => ({ html: '' }) };\n",
  );
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

function setup() {
  return setupAstroRenderers({
    projectRoot: project,
    renderers: [{ name: "fake-renderer", serverEntrypoint: path.join(project, "server.mjs"), clientEntrypoint: null }],
    base: "/",
    beforeHydrationScripts: [],
  });
}

test("a project without astro fails, naming the project", async () => {
  await expect(setup()).rejects.toThrow(`astro cannot be resolved from ${project}`);
  // Nothing was wired: a project without renderers still sets up.
  expect(await setupAstroRenderers({ projectRoot: project, renderers: [], base: "/", beforeHydrationScripts: [] })).toBeNull();
});

test("an astro without its prebuilt island scripts fails, naming the missing file", async () => {
  const astro = path.join(project, "node_modules", "astro");
  await fs.mkdir(astro, { recursive: true });
  await fs.writeFile(path.join(astro, "package.json"), JSON.stringify({ name: "astro", version: "0.0.0" }));
  await expect(setup()).rejects.toThrow(
    `Astro's prebuilt island script ${path.join(astro, "dist/runtime/client/load.prebuilt.js")} is missing`,
  );
});
