import type { TransformResult } from "@astrojs/compiler/types";

/**
 * The fields `TransformResult` names, picked from the compiler's own result, to compare a
 * compiler isolate's answer with. An inline script also carries an empty `src` its type does not have.
 */
export function transformFields(result: TransformResult): TransformResult {
  return {
    code: result.code,
    map: result.map,
    scope: result.scope,
    styleError: result.styleError,
    diagnostics: result.diagnostics,
    css: result.css,
    scripts: result.scripts.map((script) =>
      script.type === "inline" ? { type: script.type, code: script.code, map: script.map } : { type: script.type, src: script.src },
    ),
    hydratedComponents: result.hydratedComponents,
    clientOnlyComponents: result.clientOnlyComponents,
    serverComponents: result.serverComponents,
    containsHead: result.containsHead,
    propagation: result.propagation,
  };
}
