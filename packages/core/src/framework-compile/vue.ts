/**
 * `.vue` single-file components, compiled as @vitejs/plugin-vue 5.2.4 compiles them in an
 * Astro production build with @astrojs/vue 5.1.4's options. `astro build` first runs content
 * sync on a dev server sharing the plugin instance, which leaves the plugin's `devServer` set:
 * production ids, but no inlined template, and the script inlined in the main module.
 * The host injects the project's `vue/compiler-sfc`; the types below are the part of its
 * API this module uses.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { FrameworkCompileInput, FrameworkCompileOutput, FrameworkCompiler } from "./types";

export interface VueCompilerError {
  message: string;
  loc?: { start: { line: number; column: number } } | null;
}

export interface VueSfcBlock {
  content: string;
  lang?: string;
  src?: string;
}

export interface VueSfcTemplateBlock extends VueSfcBlock {
  /** Opaque here; handed back to `compileTemplate`. */
  ast?: unknown;
}

export interface VueSfcScriptBlock extends VueSfcBlock {
  /** Opaque here; handed back to `compileTemplate` as `bindingMetadata`. */
  bindings?: unknown;
}

export interface VueSfcStyleBlock extends VueSfcBlock {
  scoped?: boolean;
  module?: string | boolean;
}

export interface VueSfcDescriptor {
  template: VueSfcTemplateBlock | null;
  script: VueSfcScriptBlock | null;
  scriptSetup: VueSfcScriptBlock | null;
  styles: VueSfcStyleBlock[];
  customBlocks: VueSfcBlock[];
  cssVars: string[];
  slotted: boolean;
}

/** Optional where compiler-sfc's own option types are, so its functions fit these signatures. */
export interface VueTemplateCompileOptions {
  source: string;
  filename: string;
  id: string;
  ast?: unknown;
  scoped?: boolean;
  slotted?: boolean;
  isProd?: boolean;
  ssr?: boolean;
  ssrCssVars?: string[];
  compilerOptions?: {
    scopeId?: string | null;
    comments?: boolean;
    bindingMetadata?: unknown;
    expressionPlugins?: readonly unknown[];
    sourceMap?: boolean;
  };
}

export interface VueScriptCompileOptions {
  id: string;
  isProd?: boolean;
  inlineTemplate?: boolean;
  templateOptions?: Partial<VueTemplateCompileOptions>;
  sourceMap?: boolean;
  genDefaultAs?: string;
  customElement?: boolean | ((filename: string) => boolean);
}

export interface VueStyleCompileOptions {
  source: string;
  filename: string;
  id: string;
  scoped?: boolean;
  isProd?: boolean;
}

export interface VueSfcCompiler {
  version: string;
  parse(
    source: string,
    options?: { filename?: string; sourceMap?: boolean; templateParseOptions?: { comments?: boolean } },
  ): { descriptor: VueSfcDescriptor; errors: readonly VueCompilerError[] };
  compileScript(descriptor: VueSfcDescriptor, options: VueScriptCompileOptions): { content: string; bindings?: unknown };
  compileTemplate(options: VueTemplateCompileOptions): { code: string; errors: readonly (string | VueCompilerError)[] };
  compileStyle(options: VueStyleCompileOptions): { code: string; errors: readonly VueCompilerError[] };
}

export interface VueCompilerOptions {
  /** The project root, Vite's `root` in Astro; component ids hash the file path relative to it. */
  root: string;
}

const SCRIPT_IDENTIFIER = "_sfc_main";

const EXPORT_HELPER = `const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};`;

export function createVueCompiler(sfc: VueSfcCompiler, options: VueCompilerOptions): FrameworkCompiler {
  return {
    framework: "Vue",
    extensions: [".vue"],
    async compile(input) {
      try {
        return compileSfc(sfc, options.root, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot compile Vue component ${input.filename}:\n${message}`, { cause: error });
      }
    },
  };
}

function compileSfc(sfc: VueSfcCompiler, root: string, input: FrameworkCompileInput): FrameworkCompileOutput {
  const { source, filename } = input;
  const ssr = input.target === "server";
  // Vue's compiler keeps template comments unless it was loaded with NODE_ENV=production, as in Astro's build.
  const { descriptor, errors } = sfc.parse(source, { filename, sourceMap: false, templateParseOptions: { comments: false } });
  if (errors.length > 0) throw new Error(errors.map(formatError).join("\n"));
  refuseUnsupported(descriptor, filename);

  const relativePath = path.relative(root, filename).replaceAll("\\", "/");
  // plugin-vue's production component id: the root-relative path plus the source.
  const id = getHash(relativePath + source);
  const hasScoped = descriptor.styles.some((style) => style.scoped);
  const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang;

  const templateOptions = (bindings: unknown): VueTemplateCompileOptions | undefined => {
    const template = descriptor.template;
    if (!template) return undefined;
    // No `transformAssetUrls`: plugin-vue 5.2.4 drops @astrojs/vue's `false`, so Vue's default rewrite applies.
    return {
      source: template.content,
      id,
      ast: canReuseAst(sfc.version) ? template.ast : undefined,
      filename,
      scoped: hasScoped,
      slotted: descriptor.slotted,
      isProd: true,
      ssr,
      ssrCssVars: descriptor.cssVars,
      compilerOptions: {
        scopeId: hasScoped ? `data-v-${id}` : undefined,
        comments: false,
        bindingMetadata: bindings,
        expressionPlugins: lang && /tsx?$/.test(lang) ? ["typescript"] : [],
        sourceMap: false,
      },
    };
  };

  let scriptCode = `const ${SCRIPT_IDENTIFIER} = {  }`;
  let bindings: unknown;
  if (descriptor.script || descriptor.scriptSetup) {
    const script = sfc.compileScript(descriptor, {
      id,
      isProd: true,
      inlineTemplate: false,
      templateOptions: templateOptions(undefined),
      sourceMap: false,
      genDefaultAs: SCRIPT_IDENTIFIER,
      customElement: false,
    });
    scriptCode = script.content;
    bindings = script.bindings;
  }

  const output = [scriptCode];
  const attachedProps: [string, string][] = [];
  const renderOptions = templateOptions(bindings);
  if (renderOptions) {
    const result = sfc.compileTemplate(renderOptions);
    if (result.errors.length > 0) throw new Error(result.errors.map(formatError).join("\n"));
    output.push(result.code.replace(/\nexport (function|const) (render|ssrRender)/, "\n$1 _sfc_$2"));
    attachedProps.push(ssr ? ["ssrRender", "_sfc_ssrRender"] : ["render", "_sfc_render"]);
  }
  if (hasScoped) attachedProps.push(["__scopeId", JSON.stringify(`data-v-${id}`)]);
  if (ssr) {
    output.push(
      `import { useSSRContext as __vite_useSSRContext } from 'vue'`,
      `const _sfc_setup = _sfc_main.setup`,
      `_sfc_main.setup = (props, ctx) => {`,
      `  const ssrContext = __vite_useSSRContext()`,
      `  ;(ssrContext.modules || (ssrContext.modules = new Set())).add(${JSON.stringify(relativePath)})`,
      `  return _sfc_setup ? _sfc_setup(props, ctx) : undefined`,
      `}`,
    );
  }
  if (attachedProps.length === 0) {
    output.push(`export default ${SCRIPT_IDENTIFIER}`);
  } else {
    const props = attachedProps.map(([key, value]) => `['${key}',${value}]`).join(",");
    output.push(EXPORT_HELPER, `export default /*#__PURE__*/_export_sfc(${SCRIPT_IDENTIFIER}, [${props}])`);
  }

  const css = descriptor.styles.map((style) => {
    const result = sfc.compileStyle({
      source: style.content,
      filename,
      id: `data-v-${id}`,
      scoped: style.scoped === true,
      isProd: true,
    });
    if (result.errors.length > 0) throw new Error(result.errors.map(formatError).join("\n"));
    return result.code;
  });

  return {
    code: output.join("\n"),
    loader: lang === "ts" ? "ts" : "js",
    css: css.length > 0 ? css.join("\n") : null,
  };
}

/** What plugin-vue hands to other Vite plugins (`src` imports, preprocessors, CSS modules, custom blocks). */
function refuseUnsupported(descriptor: VueSfcDescriptor, filename: string): void {
  const unsupported: string[] = [];
  if (filename.endsWith(".ce.vue")) unsupported.push("custom element mode (.ce.vue)");
  const blocks = [descriptor.template, descriptor.script, descriptor.scriptSetup, ...descriptor.styles];
  if (blocks.some((block) => block?.src !== undefined)) unsupported.push("a block with `src`");
  const templateLang = descriptor.template?.lang;
  if (templateLang !== undefined && templateLang !== "html") unsupported.push(`<template lang="${templateLang}">`);
  for (const script of [descriptor.script, descriptor.scriptSetup]) {
    const lang = script?.lang;
    if (lang !== undefined && lang !== "js" && lang !== "ts") unsupported.push(`<script lang="${lang}">`);
  }
  for (const style of descriptor.styles) {
    if (style.module !== undefined && style.module !== false) unsupported.push("<style module>");
    if (style.lang !== undefined && style.lang !== "css") unsupported.push(`<style lang="${style.lang}">`);
  }
  if (descriptor.customBlocks.length > 0) unsupported.push("custom blocks");
  if (unsupported.length > 0) throw new Error(`Not supported: ${unsupported.join(", ")}.`);
}

function getHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").substring(0, 8);
}

/** plugin-vue's `canReuseAST`: the parsed template AST is reusable from compiler-sfc 3.4.3. */
function canReuseAst(version: string): boolean {
  const [, minor = 0, patch = 0] = version.split(".").map(Number);
  return minor >= 4 && patch >= 3;
}

function formatError(error: string | VueCompilerError): string {
  if (typeof error === "string") return error;
  const start = error.loc?.start;
  return start ? `${start.line}:${start.column} ${error.message}` : error.message;
}
