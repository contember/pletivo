/**
 * The Bun host's half of content collections.
 *
 * Everything that is the same on any host — schemas, the store, the loader
 * protocol, `getCollection`, `render`, `reference` — lives in
 * `@pletivo/core/content/collection`. What is left here is the part that needs a
 * machine: `Bun.Glob` to enumerate, `Bun.file` to read, a dynamic `import()` to
 * execute `content.config.*` and `.mdx` bodies, and the image probe. It is
 * installed once, at module load, so importing this module is all a caller has to
 * do — which is what keeps `pletivo/content` and `astro:content` working unchanged.
 */

import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { Glob } from "bun";
import { z } from "zod";
import {
  setContentHost,
  type ContentHost,
  type ContentScan,
} from "@pletivo/core/content/collection";
import {
  imageUrlFor,
  makeImageMetadata,
  probeAndRegisterImage,
  type ImageMetadata,
} from "../image";
import { recordRuntimeDep } from "../incremental/dep-tracker";

const CONTENT_CONFIG_CANDIDATES = [
  "src/content.config.ts",
  "src/content.config.mts",
  "src/content.config.mjs",
  "src/content.config.js",
  "src/content/config.ts",
  "src/content/config.mts",
  "src/content/config.mjs",
  "src/content/config.js",
];

async function findContentConfigPath(projectRoot: string): Promise<string | null> {
  for (const candidate of CONTENT_CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate);
    if (await Bun.file(configPath).exists()) return configPath;
  }
  return null;
}

/**
 * Build an `image()` factory bound to a specific entry directory.
 *
 * Accepted path forms:
 *  - Relative (`./logo.png`, `../assets/foo.png`) — resolved against the
 *    entry file's directory.
 *  - Root-absolute (`/uploads/foo.png`) — rejected; use plain `z.string()`
 *    for public/ assets.
 *  - Remote URLs (`https://...`) — rejected; use `z.string().url()`.
 *
 * `entryDir` is null for entries with no on-disk source file (function
 * loaders, etc.); image() issues a validation error in that case.
 */
function makeImageSchema(entryDir: string | null): z.ZodType<ImageMetadata, unknown> {
  return z.string().transform(async (relPath: string, ctx: z.RefinementCtx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };

    if (!entryDir) {
      return fail(
        "image() schema can only be used with file-backed entries (e.g. glob() loader)",
      );
    }
    if (/^https?:\/\//i.test(relPath)) {
      return fail(
        `image() does not support remote URLs (got "${relPath}"). ` +
          `Use z.string().url() for remote images.`,
      );
    }
    if (relPath.startsWith("/")) {
      return fail(
        `image() resolves paths relative to the entry file (got "${relPath}"). ` +
          `For files in public/, use plain z.string() and reference them by absolute URL.`,
      );
    }

    const fsPath = path.resolve(entryDir, relPath);
    try {
      const probe = await probeAndRegisterImage(fsPath);
      return makeImageMetadata({
        src: imageUrlFor(fsPath, probe.outputPath),
        width: probe.width,
        height: probe.height,
        format: probe.format,
        fsPath,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return fail(`image not found: ${relPath} (resolved to ${fsPath})`);
      }
      return fail(`could not read image ${relPath}: ${err.message}`);
    }
  });
}

const bunContentHost: ContentHost = {
  async scan(projectRoot: string, base: string, pattern: string): Promise<ContentScan> {
    const dir = path.resolve(projectRoot, base);
    const root = { root: dir, rootUrl: pathToFileURL(dir + path.sep) };
    if (!fs.existsSync(dir)) return { ...root, files: [] };

    // Sort the scan. `Bun.Glob.scan()` yields in filesystem order, which on
    // ext4 is a per-volume filename hash — so an unsorted `getCollection()`
    // returns entries in a different order on a different machine, and any
    // page listing a collection renders differently. Sorting also lets a
    // second runtime enumerating from a virtual file map agree with Bun.
    const files: string[] = [];
    for await (const file of new Glob(pattern).scan(dir)) files.push(file);
    files.sort();

    return { ...root, files: files.map((entry) => ({ entry, path: path.join(dir, entry) })) };
  },

  readFile: (filePath) => Bun.file(filePath).text(),

  dirname: (filePath) => path.dirname(filePath),

  resolveDir: (projectRoot, base) => path.resolve(projectRoot, base),

  async loadConfig(projectRoot, version) {
    const configPath = await findContentConfigPath(projectRoot);
    if (!configPath) return {};
    const mod = await import(configPath + `?v=${version}`);
    return mod.collections || {};
  },

  recordDep: recordRuntimeDep,

  image: makeImageSchema,

  async renderMdx(filePath, components, version) {
    const mod = await import(filePath + `?v=${version}`);
    let rendered = mod.default(components ? { components } : {});
    if (rendered instanceof Promise) rendered = await rendered;
    return typeof rendered === "object" && rendered !== null && "__html" in rendered
      ? (rendered as { __html: string }).__html
      : String(rendered);
  },

  async loaderConfig() {
    // Provide Astro config if host is available.
    try {
      const { getHost } = await import("../astro-host");
      const host = getHost();
      if (host) return host.config as unknown as Record<string, unknown>;
    } catch {
      // No astro host — config stays empty
    }
    return {};
  },
};

setContentHost(bunContentHost);

export * from "@pletivo/core/content/collection";
