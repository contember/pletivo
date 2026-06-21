/**
 * Shared island-bundling primitives used by both the static build (build.ts)
 * and the dev server (dev.ts), so the two stay in lockstep: identical
 * preact-dedupe resolution and identical hydrate-or-render mount semantics.
 * Previously these were duplicated and drifted apart.
 */

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
  const preactJsx = resolve("preact/jsx-runtime");
  const preactJsxDev = resolve("preact/jsx-dev-runtime");
  const preactHooks = resolve("preact/hooks");
  const preactCompat = resolve("preact/compat");

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
