/**
 * Shared island-bundling primitives used by both the static build (build.ts)
 * and the dev server (dev.ts), so the two stay in lockstep: identical
 * preact-dedupe resolution and identical hydrate-or-render mount semantics.
 * Previously these were duplicated and drifted apart.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source for a per-island wrapper module.
 *
 * When the server pre-rendered island markup, hydrate it (preserves SSR DOM,
 * attaches listeners). When it didn't (e.g. a Preact/Radix island whose SSR was
 * skipped or produced nothing), hydrate() would walk a mismatched/empty tree and
 * crash — render() fresh instead.
 *
 * We branch on `firstElementChild`, not `firstChild`, so a leading comment or
 * whitespace text node emitted by SSR (Fragment/Suspense placeholders) doesn't
 * force the crashing hydrate path on what is effectively empty content.
 */
export function islandWrapperSource(sourcePath: string): string {
  return (
    `import { hydrate, render, h } from "preact";\n` +
    `import Component from "${sourcePath}";\n` +
    `export function mount(el, props) {\n` +
    `  if (el && el.firstElementChild) hydrate(h(Component, props), el);\n` +
    `  else render(h(Component, props), el);\n` +
    `}\n`
  );
}

/**
 * Conditions tried, in order, when reading a package `exports` entry for the
 * client bundle. `import` first because that is what a bare specifier resolves
 * to with nothing mapped, and the island bundle is ESM.
 */
const CLIENT_EXPORT_CONDITIONS = ["import", "module", "browser", "default", "require"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Nearest ancestor of `file` that is a package root — the first directory with
 * a `package.json` that names a package. Skips the `{"type": "module"}` marker
 * files some packages drop next to their builds.
 */
function packageRootOf(file: string): { dir: string; manifest: Record<string, unknown> } | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = readJson(path.join(dir, "package.json"));
    if (isRecord(manifest) && typeof manifest.name === "string") return { dir, manifest };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Walk an `exports` value down its condition objects to a relative file target. */
function pickExportTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return undefined;
  for (const condition of CLIENT_EXPORT_CONDITIONS) {
    const target = pickExportTarget(entry[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * Bun plugin that redirects server-side imports to Preact for island bundles.
 * - pletivo/jsx-runtime → preact/jsx-runtime (DOM-based JSX)
 * - pletivo/hooks → preact/hooks (real reactive hooks)
 * - bare preact specifiers → the project's single copy (dedupe)
 * - react / react-dom → preact/compat (for Radix UI, lucide, uic-style libs)
 */
export function islandPlugin(projectRoot?: string) {
  // CRITICAL: resolve preact from the PROJECT's node_modules, not pletivo's.
  // Radix UI (and the island wrapper's bare `import ... from "preact"`) resolve
  // preact relative to the project; if `react`→preact/compat resolved to
  // pletivo's own copy instead, the bundle would contain TWO preact instances
  // → two React-context registries → Radix throws "X must be used within Y".
  //
  // preact is a peerDependency, so a project install puts it at the project's
  // root for `paths: [projectRoot]` to find. Fall back to a pletivo-relative
  // resolve for the cases where it's only reachable there (this monorepo's
  // devDependency, or an unusual hoist layout) — a single preact is still
  // guaranteed since the fallback is consistent across every specifier.
  const resolveFrom = projectRoot ? [projectRoot] : undefined;
  const resolve = (spec: string) => {
    if (resolveFrom) {
      try {
        return require.resolve(spec, { paths: resolveFrom });
      } catch {
        // fall through to pletivo's own copy
      }
    }
    return require.resolve(spec);
  };
  const preactMain = resolve("preact");

  // Subpaths must NOT go through `resolve()`. Bun applies tsconfig `paths` at
  // runtime, and this repo — plus every project that copies its tsconfig — maps
  // `preact/hooks` onto the SSR no-op stub. A bare resolve therefore pinned the
  // *client* bundle to the stub: `useState` returned a dead setter, `useEffect`
  // never ran, and the build stayed green (see docs/todos/013). Re-rooting the
  // resolve does not escape it either — Bun walks up from the resolve base for a
  // tsconfig, and node_modules sits under the project root. Only a relative
  // specifier escapes `paths`, and that one lands on the CJS `require` build.
  //
  // So go through preact's own `exports` map and take the `import` condition,
  // which is what the bare specifier means when nothing is mapped. This applies
  // to every subpath, not just the one mapped today: a user's tsconfig can map
  // any of them and the failure is silent either way.
  const preactPkg = packageRootOf(preactMain);
  const resolveSubpath = (subpath: string) => {
    if (preactPkg) {
      const exportsField = preactPkg.manifest.exports;
      const target = isRecord(exportsField)
        ? pickExportTarget(exportsField[`./${subpath}`])
        : undefined;
      if (target?.startsWith(".")) return path.join(preactPkg.dir, target);
      // No exports map, or nothing declared for this subpath: a relative
      // specifier still escapes `paths`, it just may land on the CJS build.
      try {
        return Bun.resolveSync(`./${subpath}`, preactPkg.dir);
      } catch {
        // fall through to the bare resolve
      }
    }
    return resolve(`preact/${subpath}`);
  };

  const preactJsx = resolveSubpath("jsx-runtime");
  const preactJsxDev = resolveSubpath("jsx-dev-runtime");
  const preactHooks = resolveSubpath("hooks");
  const preactCompat = resolveSubpath("compat");

  return {
    name: "pletivo-island",
    setup(build: any) {
      build.onResolve({ filter: /^pletivo\/jsx-runtime$/ }, () => ({ path: preactJsx }));
      build.onResolve({ filter: /^pletivo\/jsx-dev-runtime$/ }, () => ({ path: preactJsxDev }));
      build.onResolve({ filter: /^pletivo\/hooks$/ }, () => ({ path: preactHooks }));
      // Pin bare preact specifiers to the project copy too (dedupe).
      build.onResolve({ filter: /^preact$/ }, () => ({ path: preactMain }));
      build.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: preactHooks }));
      build.onResolve({ filter: /^preact\/compat$/ }, () => ({ path: preactCompat }));
      build.onResolve({ filter: /^preact\/jsx-runtime$/ }, () => ({ path: preactJsx }));
      build.onResolve({ filter: /^preact\/jsx-dev-runtime$/ }, () => ({ path: preactJsxDev }));
      // --- react → preact/compat (for Radix UI, lucide, uic-style libs) ---
      build.onResolve({ filter: /^react$/ }, () => ({ path: preactCompat }));
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: preactCompat }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: preactCompat }));
      build.onResolve({ filter: /^react-dom\/test-utils$/ }, () => ({ path: preactCompat }));
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: preactJsx }));
      build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: preactJsxDev }));
    },
  };
}
