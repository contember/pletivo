/**
 * A stylesheet a browser script imports, as the ES module the browser runs: applied when the
 * import runs, as Vite dev does. One spelling for the host serving it on its own and for
 * `pletivo prepare` bundling it, so both apply it the same way.
 */
export function browserStylesheetModule(moduleId: string, css: string): string {
  return (
    `const style = document.createElement("style");\n` +
    `style.dataset.pletivoModule = ${JSON.stringify(moduleId)};\n` +
    `style.textContent = ${JSON.stringify(css)};\n` +
    `document.head.append(style);\n`
  );
}
