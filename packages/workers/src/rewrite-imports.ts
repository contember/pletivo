/** Syntax-aware import discovery and rewriting for Loader-bound JavaScript. */

import { parse } from "acorn";

export type ResolveImport = (resolved: string, specifier: string) => string | null;

export interface RewriteImportsOptions {
  importer: string;
  resolve: ResolveImport;
}

interface ImportOccurrence {
  specifier: string;
  start: number;
  end: number;
  quote: "\"" | "'";
  importedNames: readonly string[];
}

export class ImportOccurrenceError extends Error {
  constructor(reason: string) {
    super(`[pletivo-workers] cannot identify module imports: ${reason}`);
    this.name = "ImportOccurrenceError";
  }
}

const IMPORTED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Parse once, then retain exact source spans for deterministic rewriting. */
function importOccurrences(code: string): ImportOccurrence[] {
  let program: unknown;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    throw new ImportOccurrenceError(error instanceof Error ? error.message : String(error));
  }

  const occurrences: ImportOccurrence[] = [];
  visit(program, code, occurrences);
  return occurrences.sort((left, right) => left.start - right.start);
}

function visit(value: unknown, code: string, occurrences: ImportOccurrence[]): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const child of value) visit(child, code, occurrences);
    return;
  }

  const type = stringProperty(value, "type");
  if (type === "ImportDeclaration") {
    occurrences.push(literalOccurrence(property(value, "source"), code, importedNames(value)));
  } else if (type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") {
    const source = property(value, "source");
    if (source !== null && source !== undefined) {
      occurrences.push(literalOccurrence(source, code, []));
    }
  } else if (type === "ImportExpression") {
    const source = property(value, "source");
    if (nodeType(source) === "Literal") {
      occurrences.push(literalOccurrence(source, code, []));
    }
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "start" || key === "end" || key === "type") continue;
    visit(Reflect.get(value, key), code, occurrences);
  }
}

function literalOccurrence(
  literal: unknown,
  code: string,
  importedNames: readonly string[],
): ImportOccurrence {
  if (nodeType(literal) !== "Literal") {
    throw new ImportOccurrenceError("module specifier is not a string literal");
  }
  const specifier = property(literal, "value");
  const literalStart = property(literal, "start");
  const literalEnd = property(literal, "end");
  if (
    typeof specifier !== "string" ||
    typeof literalStart !== "number" ||
    typeof literalEnd !== "number"
  ) {
    throw new ImportOccurrenceError("module specifier has an invalid parser span");
  }
  const quote = code[literalStart];
  if ((quote !== "\"" && quote !== "'") || code[literalEnd - 1] !== quote) {
    throw new ImportOccurrenceError(`module specifier at byte ${literalStart} is not quoted`);
  }
  return {
    specifier,
    start: literalStart + 1,
    end: literalEnd - 1,
    quote,
    importedNames,
  };
}

function importedNames(declaration: object): string[] {
  const specifiers = property(declaration, "specifiers");
  if (!Array.isArray(specifiers)) {
    throw new ImportOccurrenceError("import declaration has no specifier list");
  }
  const names: string[] = [];
  for (const specifier of specifiers) {
    if (nodeType(specifier) !== "ImportSpecifier") continue;
    const imported = property(specifier, "imported");
    const type = nodeType(imported);
    const name = type === "Identifier"
      ? property(imported, "name")
      : type === "Literal"
        ? property(imported, "value")
        : undefined;
    if (typeof name === "string" && IMPORTED_NAME.test(name)) names.push(name);
  }
  return names;
}

function nodeType(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  return stringProperty(value, "type");
}

function stringProperty(value: object, key: string): string | null {
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" ? found : null;
}

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export function collectSpecifiers(code: string): string[] {
  return importOccurrences(code).map((occurrence) => occurrence.specifier);
}

export function collectImportedNames(code: string, specifier: string): string[] {
  return importOccurrences(code)
    .filter((occurrence) => occurrence.specifier === specifier)
    .flatMap((occurrence) => occurrence.importedNames);
}

export function resolveSpecifier(importer: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = importer.split("/").slice(0, -1).concat(specifier.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function rewriteImports(code: string, options: RewriteImportsOptions): string {
  const occurrences = importOccurrences(code);
  let rewritten = code;
  for (let index = occurrences.length - 1; index >= 0; index--) {
    const occurrence = occurrences[index];
    const target = options.resolve(
      resolveSpecifier(options.importer, occurrence.specifier),
      occurrence.specifier,
    );
    if (target === null) continue;
    const escaped = escapeSpecifier(target, occurrence.quote);
    rewritten = rewritten.slice(0, occurrence.start) + escaped + rewritten.slice(occurrence.end);
  }
  return rewritten;
}

function escapeSpecifier(value: string, quote: "\"" | "'"): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
