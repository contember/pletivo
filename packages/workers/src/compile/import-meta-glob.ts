/**
 * Vite's `import.meta.glob`, over the files one render can see.
 *
 * The compile step, cached by source, replaces each call with a placeholder and keeps its literal
 * arguments. Linking expands the placeholder against the render's file list, so a matching file
 * added or removed takes effect without a recompile. The matches become ordinary imports, which
 * resolve and rewrite like any other.
 */

import { parse } from "acorn";
import { globMatcher } from "../content-files.ts";
import { normalizeProjectPath } from "../project-path.ts";
import { UnsupportedFileError } from "./source-module.ts";

export interface ImportMetaGlob {
  /** The identifier the call was replaced with. */
  placeholder: string;
  /** As written: root-relative (`/src/…`) or importer-relative (`./…`); `!` excludes. */
  patterns: readonly string[];
  eager: boolean;
  /** The `import` option: one export of each match instead of its namespace. */
  importName: string | null;
  /** The `query` option (or the legacy `as`), appended to every match's specifier. */
  query: string | null;
}

const MENTION = /\bimport\s*\.\s*meta\s*\.\s*glob\b/;

/** Replace each `import.meta.glob(…)` call in `code` with a placeholder. */
export function extractImportMetaGlobs(
  code: string,
  file: string,
): { code: string; globs: ImportMetaGlob[] } {
  if (!MENTION.test(code)) return { code, globs: [] };
  let program: unknown;
  try {
    program = parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
  } catch {
    // Not ours to report: the import scan parses the same code and names the error.
    return { code, globs: [] };
  }
  const calls: { start: number; end: number; args: unknown[] }[] = [];
  findGlobCalls(program, calls);

  const globs: ImportMetaGlob[] = [];
  let out = code;
  calls.sort((left, right) => right.start - left.start);
  for (const [index, call] of calls.entries()) {
    const placeholder = `__pletivo_import_meta_glob_${calls.length - 1 - index}__`;
    globs.push({ placeholder, ...globArguments(call.args, file) });
    out = out.slice(0, call.start) + placeholder + out.slice(call.end);
  }
  return { code: out, globs: globs.reverse() };
}

/** Expand every placeholder into the object Vite would produce, plus the imports it needs. */
export function expandImportMetaGlobs(
  code: string,
  globs: readonly ImportMetaGlob[],
  importer: string,
  candidates: Iterable<string>,
): { code: string; specifiers: string[] } {
  const files = [...new Set(candidates)].map(normalizeProjectPath).filter((path) => path !== importer);
  const importerDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  const declarations: string[] = [];
  const specifiers: string[] = [];
  let out = code;

  for (const [globIndex, glob] of globs.entries()) {
    const matches = matchGlob(glob, files, importerDir, importer);
    const entries = matches.map(({ key, file }, matchIndex) => {
      const specifier = relativeSpecifier(importerDir, file) + (glob.query ?? "");
      specifiers.push(specifier);
      const literal = JSON.stringify(specifier);
      const pick = glob.importName === null ? "" : `[${JSON.stringify(glob.importName)}]`;
      if (glob.eager) {
        const local = `__pletivo_glob_${globIndex}_${matchIndex}`;
        declarations.push(`import * as ${local} from ${literal};`);
        return `${JSON.stringify(key)}: ${local}${pick}`;
      }
      const loaded = pick === "" ? `import(${literal})` : `import(${literal}).then((module) => module${pick})`;
      return `${JSON.stringify(key)}: () => ${loaded}`;
    });
    out = out.split(glob.placeholder).join(`{${entries.join(", ")}}`);
  }
  return { code: declarations.length === 0 ? out : `${declarations.join("\n")}\n${out}`, specifiers };
}

function matchGlob(
  glob: ImportMetaGlob,
  files: readonly string[],
  importerDir: string,
  importer: string,
): { key: string; file: string }[] {
  const include: ((file: string) => boolean)[] = [];
  const exclude: ((file: string) => boolean)[] = [];
  let relative: boolean | null = null;
  for (const written of glob.patterns) {
    const negated = written.startsWith("!");
    const pattern = negated ? written.slice(1) : written;
    let projectPattern: string;
    if (pattern.startsWith("/")) {
      projectPattern = pattern.slice(1);
      if (!negated) relative ??= false;
    } else if (pattern.startsWith("./") || pattern.startsWith("../")) {
      projectPattern = normalizeProjectPath(importerDir === "" ? pattern : `${importerDir}/${pattern}`);
      if (!negated) relative ??= true;
    } else {
      throw new UnsupportedFileError(
        importer,
        `import.meta.glob pattern ${JSON.stringify(written)} must start with "/", "./" or "../"`,
      );
    }
    (negated ? exclude : include).push(globMatcher(projectPattern));
  }
  return files
    .filter((file) => include.some((match) => match(file)) && !exclude.some((match) => match(file)))
    .map((file) => ({ key: relative === true ? relativeSpecifier(importerDir, file) : `/${file}`, file }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/** `./x` or `../x` from `fromDir` to `file`, both project paths. */
function relativeSpecifier(fromDir: string, file: string): string {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = file.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

function findGlobCalls(node: unknown, calls: { start: number; end: number; args: unknown[] }[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const child of node) findGlobCalls(child, calls);
    return;
  }
  if (nodeType(node) === "CallExpression" && isImportMetaGlob(property(node, "callee"))) {
    const args = property(node, "arguments");
    calls.push({ start: numberProperty(node, "start"), end: numberProperty(node, "end"), args: Array.isArray(args) ? args : [] });
    return;
  }
  for (const key of Reflect.ownKeys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    findGlobCalls(Reflect.get(node, key), calls);
  }
}

function isImportMetaGlob(callee: unknown): boolean {
  if (nodeType(callee) !== "MemberExpression" || property(callee, "computed") === true) return false;
  const object = property(callee, "object");
  return (
    nodeType(object) === "MetaProperty" &&
    identifierName(property(object, "meta")) === "import" &&
    identifierName(property(object, "property")) === "meta" &&
    identifierName(property(callee, "property")) === "glob"
  );
}

function globArguments(args: unknown[], file: string): Omit<ImportMetaGlob, "placeholder"> {
  const unsupported = (reason: string) => new UnsupportedFileError(file, `import.meta.glob: ${reason}`);
  const [patternsNode, optionsNode, ...rest] = args;
  if (rest.length > 0) throw unsupported("takes at most two arguments");
  const single = stringLiteral(patternsNode);
  let patterns: string[];
  if (single !== null) {
    patterns = [single];
  } else if (nodeType(patternsNode) === "ArrayExpression") {
    const elements = property(patternsNode, "elements");
    patterns = (Array.isArray(elements) ? elements : []).map((element) => {
      const value = stringLiteral(element);
      if (value === null) throw unsupported("every pattern must be a string literal");
      return value;
    });
  } else {
    throw unsupported("the pattern must be a string literal or an array of them");
  }

  let eager = false;
  let importName: string | null = null;
  let query: string | null = null;
  if (optionsNode !== undefined) {
    if (nodeType(optionsNode) !== "ObjectExpression") throw unsupported("the options must be an object literal");
    const properties = property(optionsNode, "properties");
    for (const option of Array.isArray(properties) ? properties : []) {
      const key = nodeType(option) === "Property" && property(option, "computed") !== true
        ? (identifierName(property(option, "key")) ?? stringLiteral(property(option, "key")))
        : null;
      const value = property(option, "value");
      if (key === "eager" && typeof literalValue(value) === "boolean") {
        eager = literalValue(value) === true;
      } else if (key === "import" && stringLiteral(value) !== null) {
        importName = stringLiteral(value);
      } else if (key === "query" && stringLiteral(value) !== null) {
        const written = stringLiteral(value) ?? "";
        query = written.startsWith("?") ? written : `?${written}`;
      } else if (key === "as" && stringLiteral(value) !== null) {
        query = `?${stringLiteral(value)}`;
      } else if (key === "exhaustive" && literalValue(value) === false) {
        // The default; node_modules and dotfiles are never listed here anyway.
      } else {
        throw unsupported(`option ${key === null ? "(computed)" : JSON.stringify(key)} must be a supported literal (eager, import, query, as)`);
      }
    }
  }
  return { patterns, eager, importName, query };
}

function stringLiteral(node: unknown): string | null {
  if (nodeType(node) === "Literal") {
    const value = property(node, "value");
    return typeof value === "string" ? value : null;
  }
  if (nodeType(node) === "TemplateLiteral") {
    const expressions = property(node, "expressions");
    const quasis = property(node, "quasis");
    if (!Array.isArray(expressions) || expressions.length > 0 || !Array.isArray(quasis) || quasis.length !== 1) return null;
    const cooked = property(property(quasis[0], "value"), "cooked");
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

function literalValue(node: unknown): unknown {
  return nodeType(node) === "Literal" ? property(node, "value") : undefined;
}

function identifierName(node: unknown): string | null {
  if (nodeType(node) !== "Identifier") return null;
  const name = property(node, "name");
  return typeof name === "string" ? name : null;
}

function nodeType(node: unknown): string | null {
  const type = property(node, "type");
  return typeof type === "string" ? type : null;
}

function numberProperty(node: unknown, key: string): number {
  const value = property(node, key);
  if (typeof value !== "number") throw new Error(`[pletivo-workers] acorn node without a numeric ${key}`);
  return value;
}

function property(node: unknown, key: string): unknown {
  return typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;
}
