/**
 * Watch the config files the dev server loaded once at startup.
 *
 * `astro.config.*` and `pletivo.config.*` are read exactly once, when the
 * process boots: integrations run their `astro:config:setup` there and never
 * again. Anything those hooks produce — a generated module, an injected route
 * — therefore reflects the config as it was at boot. Edit the config (or a
 * module it imports) under a running server and the two drift apart, usually
 * surfacing much later as "Cannot find module" in a page that imports
 * something the new config was supposed to generate.
 *
 * Neither the srcDir watcher nor the content watcher covers these files: they
 * sit at the project root. So we watch them here and let the caller restart.
 */

import fs from "fs";
import path from "path";
import { findAstroConfig } from "./astro-host/config-loader";
import { collectStaticDeps, configureImportGraph } from "./incremental/import-graph";

const PLETIVO_CONFIG_NAMES = ["pletivo.config.ts", "pletivo.config.js", "pletivo.config.mjs"];

/** Coalesce a multi-file change (a checkout, a formatter pass) into one restart. */
const DEBOUNCE_MS = 150;

function findPletivoConfig(projectRoot: string): string | null {
  for (const name of PLETIVO_CONFIG_NAMES) {
    const full = path.join(projectRoot, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Every project file the config pulls in, transitively — `astro.config.mjs`
 * plus the integrations and rehype plugins living next to it. Bare specifiers
 * and `node_modules` are out of scope (`collectStaticDeps` drops them); a
 * dependency upgrade is not something a dev server can react to anyway.
 */
export async function resolveConfigWatchFiles(projectRoot: string): Promise<string[]> {
  const entries = [findAstroConfig(projectRoot), findPletivoConfig(projectRoot)].filter(
    (f): f is string => f !== null,
  );
  if (entries.length === 0) return [];

  configureImportGraph(projectRoot);
  const files = new Set<string>();
  for (const entry of entries) {
    for (const dep of await collectStaticDeps(entry)) files.add(dep);
  }
  return [...files].sort();
}

export interface ConfigWatcher {
  close(): void;
}

/**
 * Fire `onChange` once per burst of edits to any of `files`. Watches the
 * containing directories rather than the files themselves — editors and `git
 * checkout` replace files by rename, which drops a file watch on the spot.
 */
export function watchConfigFiles(files: string[], onChange: (file: string) => void): ConfigWatcher {
  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = path.dirname(file);
    let names = byDir.get(dir);
    if (!names) byDir.set(dir, (names = new Set()));
    names.add(path.basename(file));
  }

  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  for (const [dir, names] of byDir) {
    try {
      watchers.push(
        fs.watch(dir, { recursive: false }, (_event, filename) => {
          if (!filename || !names.has(path.basename(filename))) return;
          pending = path.join(dir, path.basename(filename));
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            const file = pending;
            pending = null;
            if (file) onChange(file);
          }, DEBOUNCE_MS);
        }),
      );
    } catch {
      // Directory vanished between resolve and watch — nothing to do.
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
