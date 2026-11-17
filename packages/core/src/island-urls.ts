/**
 * Where Astro islands' client modules live: one per hydrated component export, one per
 * renderer client entrypoint and one for the `before-hydration` scripts. Pure, so every
 * host names them alike while it renders, before (or without) bundling them.
 */
import type { IslandClientUrls } from "@pletivo/runtime/astro-islands/types";
import { base64url, sha256 } from "./sha256";

const ASTRO_DIR = "_astro";

export interface IslandClientUrlsOptions {
  /** Absolute. Component entry names hash a component file's path relative to it. */
  projectRoot: string;
  /** The site's base path, e.g. `/` or `/docs`. */
  base: string;
  /** Contents of the scripts integrations injected at the `before-hydration` stage. */
  beforeHydrationScripts?: readonly string[];
}

/** `/`, `/docs` or `/docs/` → the prefix every island URL starts with. */
export function astroUrlPrefix(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? `/${ASTRO_DIR}/` : `/${trimmed}/${ASTRO_DIR}/`;
}

function shortHash(parts: readonly string[]): string {
  return base64url(sha256(parts.join("\0"))).slice(0, 8);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** A POSIX root, or a Windows drive root with either separator. */
function isAbsolutePath(file: string): boolean {
  return file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file);
}

/** `/`-separated segments without empty and `.` ones, `..` folded. */
function segments(file: string): string[] {
  const out: string[] = [];
  for (const segment of file.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out;
}

/** The drive of a Windows path, or `""`; a path on another drive has no relative form. */
function driveOf(file: string): string {
  return /^[A-Za-z]:/.test(file) ? file.slice(0, 2).toLowerCase() : "";
}

/**
 * A component file as a specifier relative to the project root, with POSIX separators, so a
 * checkout's location changes no island entry name or byte. A package specifier stays as it is.
 */
export function portableSpecifier(projectRoot: string, componentPath: string): string {
  if (!isAbsolutePath(componentPath)) return componentPath;
  if (driveOf(projectRoot) !== driveOf(componentPath)) return componentPath;
  const from = segments(projectRoot.slice(driveOf(projectRoot).length));
  const to = segments(componentPath.slice(driveOf(componentPath).length));
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  const relative = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
  return relative.startsWith("../") ? relative : `./${relative}`;
}

/** `path.basename(file, path.extname(file))` for either separator. */
function stem(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function componentFile(projectRoot: string, componentPath: string, exportName: string): string {
  const name = safeName(stem(componentPath));
  return `${name}.${shortHash(["component", portableSpecifier(projectRoot, componentPath), exportName])}.js`;
}

function rendererFile(rendererName: string): string {
  // Astro names the chunk after the entrypoint file; only Svelte's is `client.svelte.js`.
  const name = rendererName === "@astrojs/svelte" ? "client.svelte" : "client";
  return `${name}.${shortHash(["renderer", rendererName])}.js`;
}

/** Astro joins the stage's scripts into one module. */
export function beforeHydrationSource(scripts: readonly string[] | undefined): string | null {
  return scripts && scripts.length > 0 ? scripts.join("\n") : null;
}

function beforeHydrationFile(source: string): string {
  return `before-hydration.${shortHash(["before-hydration", source])}.js`;
}

export function createIslandClientUrls(options: IslandClientUrlsOptions): IslandClientUrls {
  const prefix = astroUrlPrefix(options.base);
  const beforeHydration = beforeHydrationSource(options.beforeHydrationScripts);
  return {
    component: (componentPath, exportName) => prefix + componentFile(options.projectRoot, componentPath, exportName),
    renderer: (rendererName) => prefix + rendererFile(rendererName),
    beforeHydration: beforeHydration === null ? null : prefix + beforeHydrationFile(beforeHydration),
  };
}
