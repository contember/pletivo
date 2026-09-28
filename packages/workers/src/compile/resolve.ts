import { imageOutputPath } from "@pletivo/core/image";
import { projectModuleId, type ArtifactResolver } from "../artifact.ts";
import type { ProjectAssetInfo, ProjectAssetsView } from "../asset-port.ts";
import { ASSETS_DIR } from "../astro-assets.ts";
import { CONTENT_MODULE_NAME, IMAGE_MODULE_NAME } from "../generated/runtime-modules.ts";
import { HOST_ALIASES } from "../host-aliases.ts";
import { md5Hex } from "../md5.ts";
import { resolveSpecifier } from "../rewrite-imports.ts";
import {
  isTailwindStylesheetSpecifier,
  TailwindNotConfiguredError,
  type TailwindStylesheets,
} from "../tailwind.ts";
import { extensionOf } from "./module-kind.ts";
import { unresolvedImport, type ResolutionUse, type SourceModule } from "./source-module.ts";
import type { CompileWalk } from "./walk-state.ts";

const UNSUPPORTED_PACKAGE_ROOTS = new Set(["pletivo", "@pletivo/runtime", "@pletivo/core"]);

/**
 * The content API reached by relative path into pletivo's own source, as this repo's
 * fixtures write it.
 *
 * They predate the published package, so they import
 * `packages/pletivo/src/content/collection` by relative path — which
 * `resolveSpecifier` lands on the same project-root-relative key from every one of
 * them, however deep the importer sits. A path is not a package, so it can never be
 * in a virtual file map; matching it is what lets a fixture written for the Bun host
 * be previewed without being rewritten first.
 */
const PLETIVO_CONTENT_PATH = /(?:^|\/)pletivo\/src\/content\/(?:collection|index)(?:\.ts)?$/;

/** Whether a resolved specifier is the content API. */
export function isContentApi(resolved: string): boolean {
  return HOST_ALIASES.get(resolved)?.kind === "content" || PLETIVO_CONTENT_PATH.test(resolved);
}

/**
 * Vite's import suffixes, of which pletivo answers two.
 *
 * `?raw` and `?inline` both mean the file's text here, because that is what the Bun
 * host's loader makes of them (`astro-plugin.ts:571`) and the two hosts have to agree.
 * (Vite's `?inline` is a data: URI — a divergence pletivo already carries.) `?url`
 * means the URL of the emitted file, which is a different thing entirely: a string
 * the HTML spells, and a file somebody then has to serve.
 */
export function importQuery(resolved: string): { file: string; kind: "text" | "url" } | null {
  const mark = resolved.indexOf("?");
  if (mark === -1) return null;
  const query = resolved.slice(mark + 1);
  const file = resolved.slice(0, mark);
  if (/(^|&)(raw|inline)(&|=|$)/.test(query)) return { file, kind: "text" };
  if (/(^|&)url(&|=|$)/.test(query)) return { file, kind: "url" };
  return null;
}

export interface ImportResolverOptions {
  artifact: ArtifactResolver;
  tailwind?: TailwindStylesheets;
  assets?: ProjectAssetsView;
}

/**
 * Decides what one specifier of one importer names, and claims the target in the walk.
 *
 * This is the single place that decides a module has to be in the bundle, so claiming
 * it here is also how the walk discovers it. Every side effect it has on the walk —
 * content, images, `?url` assets, generated modules — is reproduced on a compile
 * cache hit, because a hit still resolves every specifier.
 */
export class ImportResolver {
  readonly #walk: CompileWalk;
  readonly #options: ImportResolverOptions;
  readonly #assetInfos = new Map<string, Promise<ProjectAssetInfo | null>>();

  constructor(walk: CompileWalk, options: ImportResolverOptions) {
    this.#walk = walk;
    this.#options = options;
  }

  async resolve(importer: SourceModule, rawSpecifier: string): Promise<ResolutionUse> {
    if (importer.origin === "project") {
      const local = await this.#resolveFromProject(importer, rawSpecifier);
      if (local !== null) return local;
    }

    const directAlias = HOST_ALIASES.get(rawSpecifier);
    if (directAlias !== undefined) return this.#externalUse(importer, rawSpecifier, rawSpecifier);

    const frozen = this.#options.artifact.resolve(importer.id, rawSpecifier);
    if (frozen !== null) {
      if (frozen.kind === "external") {
        return this.#externalUse(importer, rawSpecifier, frozen.specifier);
      }
      return moduleResolution(importer, rawSpecifier, this.#walk.artifactModule(frozen.id));
    }

    if (importer.kind === "css" && isTailwindStylesheetSpecifier(rawSpecifier)) {
      const { tailwind } = this.#options;
      if (tailwind === undefined) throw new TailwindNotConfiguredError(importer.id);
      return moduleResolution(
        importer,
        rawSpecifier,
        this.#walk.hostStylesheet(rawSpecifier, tailwind[rawSpecifier]),
      );
    }

    if (UNSUPPORTED_PACKAGE_ROOTS.has(rawSpecifier)) {
      throw unresolvedImport(importer, rawSpecifier, "unsupported package root export");
    }
    throw unresolvedImport(
      importer,
      rawSpecifier,
      "no project file, Artifact V2 resolution, or supported host alias answers it",
    );
  }

  /** What only a project importer can reach: its query imports, files, images and the content path. */
  async #resolveFromProject(
    importer: SourceModule,
    rawSpecifier: string,
  ): Promise<ResolutionUse | null> {
    const resolved = resolveSpecifier(importer.legacyKey, rawSpecifier);

    const query = importQuery(resolved);
    if (query !== null) {
      const target = this.#walk.resolveProjectFile(query.file);
      const source = target === null ? undefined : this.#walk.readProjectFile(target);
      if (target === null || source === undefined) {
        throw unresolvedImport(importer, rawSpecifier, "query target does not exist");
      }
      const value = query.kind === "text" ? source : urlAssetHref(target, source, this.#walk.urlAssets);
      const code = `export default ${JSON.stringify(value)};\n`;
      const generated = this.#walk.generatedModule(
        `generated:query:${projectModuleId(target)}:${query.kind}`,
        resolved,
        code,
      );
      return moduleResolution(importer, rawSpecifier, generated);
    }

    const local = this.#walk.resolveProjectFile(resolved);
    if (local !== null) {
      const target = this.#walk.projectModule(local);
      if (target === null) {
        throw unresolvedImport(importer, rawSpecifier, "the target kind is unsupported");
      }
      return moduleResolution(importer, rawSpecifier, target);
    }

    if (isImageSource(resolved)) {
      const info = await this.#readAssetInfo(resolved);
      if (info === null) {
        throw unresolvedImport(importer, rawSpecifier, "the image metadata is missing or unreadable");
      }
      const code = imageModule(resolved, info);
      this.#walk.markImagesUsed();
      return moduleResolution(
        importer,
        rawSpecifier,
        this.#walk.generatedModule(`generated:image:${projectModuleId(resolved)}`, resolved, code),
      );
    }

    if (PLETIVO_CONTENT_PATH.test(resolved)) {
      return this.#externalUse(importer, rawSpecifier, "pletivo/content");
    }
    return null;
  }

  #externalUse(importer: SourceModule, rawSpecifier: string, external: string): ResolutionUse {
    const alias = HOST_ALIASES.get(external);
    if (alias === undefined) {
      throw unresolvedImport(importer, rawSpecifier, `unsupported host external ${JSON.stringify(external)}`);
    }
    if (alias.kind === "content") {
      this.#walk.useContent();
      return externalResolution(importer, rawSpecifier, external, CONTENT_MODULE_NAME);
    }
    if (alias.kind === "assets") {
      this.#walk.markImagesUsed();
      this.#walk.addAssetSources();
      const target = this.#walk.projectModule(`${ASSETS_DIR}/index.ts`);
      if (target === null) throw unresolvedImport(importer, rawSpecifier, "generated asset entry is missing");
      return moduleResolution(importer, rawSpecifier, target);
    }
    if (alias.kind === "image") {
      this.#walk.markImagesUsed();
      return externalResolution(importer, rawSpecifier, external, IMAGE_MODULE_NAME);
    }
    return externalResolution(importer, rawSpecifier, external, alias.executionName);
  }

  #readAssetInfo(source: string): Promise<ProjectAssetInfo | null> {
    let pending = this.#assetInfos.get(source);
    if (pending === undefined) {
      const { assets } = this.#options;
      pending = assets === undefined ? Promise.resolve(null) : Promise.resolve(assets.info(source));
      this.#assetInfos.set(source, pending);
    }
    return pending;
  }
}

function moduleResolution(
  importer: SourceModule,
  specifier: string,
  target: SourceModule,
): ResolutionUse {
  return {
    edge: {
      importer: importer.id,
      specifier,
      target: { kind: "module", id: target.id },
      kind: target.kind === "css" ? "style" : "execution",
    },
    rewritten: `./${target.executionName}`,
    targetLegacyKey: target.legacyKey,
  };
}

function externalResolution(
  importer: SourceModule,
  specifier: string,
  external: string,
  executionName: string,
): ResolutionUse {
  return {
    edge: {
      importer: importer.id,
      specifier,
      target: { kind: "external", specifier: external },
      kind: "execution",
    },
    rewritten: `./${executionName}`,
    targetLegacyKey: null,
  };
}

/**
 * The URL a `?url` import resolves to, and the file registered under it.
 *
 * `_astro/<base>.<md5-8><ext>`, which is what the Bun host emits (`url-asset.ts`), so
 * a project's markup spells the same href on either host. Content-hashed, so a host
 * can cache it forever and two renders of the same project agree on the name.
 */
function urlAssetHref(
  file: string,
  source: string,
  urlAssets: Map<string, string>,
): string {
  const slash = file.lastIndexOf("/");
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot);
  const href = `/_astro/${base}.${md5Hex(source).slice(0, 8)}${extension}`;
  urlAssets.set(href, source);
  return href;
}

const IMAGE_SOURCE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

function isImageSource(file: string): boolean {
  return IMAGE_SOURCE_EXTENSIONS.has(extensionOf(file));
}

/**
 * One image's module, holding what the Bun host's loader puts in the same place.
 *
 * `fsPath` is the file-map key rather than a filesystem path — it is what `getImage()`
 * tests to tell an ESM-imported image from a bare string, and what a host resolves
 * back to bytes when the browser asks for the URL. Non-enumerable, exactly as on the
 * Bun host, so it cannot leak through `JSON.stringify`.
 *
 * The view already validated `info`; a missing or unreadable image fails in `resolve` first.
 */
function imageModule(file: string, info: ProjectAssetInfo): string {
  const visible = {
    src: `/${imageOutputPath(file, info.hash)}`,
    width: info.width,
    height: info.height,
    format: info.format,
  };
  return (
    `const meta = ${JSON.stringify(visible)};\n` +
    `Object.defineProperty(meta, "fsPath", { value: ${JSON.stringify(file)}, enumerable: false });\n` +
    "export default meta;\n"
  );
}
