// Port of Astro's `rehypeAnalyzeAstroMetadata` (`astro/src/jsx/rehype.ts`): a component with a
// `client:*` directive gets the `client:component-*` props the `.astro` compiler adds.
import type { Transformer } from "unified";

type Tree = Parameters<Transformer>[0];
type File = Parameters<Transformer>[1];

/** The `mdast-util-mdx-jsx` hast element fields this plugin reads and extends. */
interface MdxJsxElement {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name: string | null;
  attributes: unknown[];
}

interface ImportSpecifier {
  local: string;
  imported: string;
}

interface MatchedImport {
  name: string;
  path: string;
}

/** One component the MDX hydrates, `client:only` included. */
export interface MdxHydration {
  /** The import as written. */
  specifier: string;
  /** What `client:component-path` is set to: `resolveComponentPath`'s answer. */
  componentPath: string;
  /** `client:component-export`. */
  exportName: string;
}

export interface AstroIslandMetadataOptions {
  /** The host's `.astro` `resolvePath`: the island `uid` hashes what it returns. */
  resolveComponentPath(specifier: string, importer: string): string;
  /** Called once per hydrated element the plugin gives a `client:component-path`. */
  hydrated?(hydration: MdxHydration): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMdxJsxElement(node: unknown): node is MdxJsxElement {
  return (
    isRecord(node) &&
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    (node.name === null || typeof node.name === "string") &&
    Array.isArray(node.attributes)
  );
}

/** Names of the element's plain `name=value` attributes; spread expressions have none. */
function attributeNames(node: MdxJsxElement): string[] {
  const names: string[] = [];
  for (const attr of node.attributes) {
    if (isRecord(attr) && attr.type === "mdxJsxAttribute" && typeof attr.name === "string") names.push(attr.name);
  }
  return names;
}

function pushAttribute(node: MdxJsxElement, name: string, value: string | null): void {
  node.attributes.push({ type: "mdxJsxAttribute", name, value });
}

export function rehypeAstroIslandMetadata(options: AstroIslandMetadataOptions): Transformer {
  return (tree: Tree, file: File) => {
    const imports = parseImports(tree, file.path);
    visit(tree, (node) => {
      const tagName = node.name;
      if (!tagName || !isComponent(tagName)) return;
      const names = attributeNames(node);
      if (!names.some((name) => name.startsWith("client:"))) return;

      const matched = findMatchingImport(tagName, imports);
      if (!matched) {
        throw new Error(
          `Could not render \`${tagName}\`. No matching import has been found for \`${tagName}\`.\n` +
            "Please make sure the component is properly imported.",
        );
      }
      if (matched.path.endsWith(".astro")) {
        const directive = names.find((name) => name.startsWith("client:"));
        console.warn(
          `You are attempting to render <${tagName} ${directive} />, but ${tagName} is an Astro component. Astro components do not render in the client and should not have a hydration directive. Please use a framework component for client rendering.`,
        );
      }
      if (!file.path) throw new Error(`Cannot resolve the import of <${tagName}> without the MDX file's path`);
      const resolvedPath = options.resolveComponentPath(matched.path, file.path);

      const exported = names.includes("client:only")
        ? addClientOnlyMetadata(node, tagName, names, matched, resolvedPath)
        : addClientMetadata(node, tagName, names, matched, resolvedPath);
      if (exported !== null) options.hydrated?.({ specifier: matched.path, componentPath: resolvedPath, exportName: exported });
    });
  };
}

/** Pre-order walk over every MDX JSX element, as `unist-util-visit` does in Astro. */
function visit(node: unknown, onElement: (element: MdxJsxElement) => void): void {
  if (isMdxJsxElement(node)) onElement(node);
  if (!isRecord(node) || !Array.isArray(node.children)) return;
  for (const child of node.children) visit(child, onElement);
}

/** Import source to its specifiers, from the top-level ESM blocks, in source order. */
function parseImports(tree: Tree, filePath: string): Map<string, ImportSpecifier[]> {
  const imports = new Map<string, ImportSpecifier[]>();
  const children = "children" in tree && Array.isArray(tree.children) ? tree.children : [];
  for (const child of children) {
    if (!isRecord(child) || child.type !== "mdxjsEsm") continue;
    const estree = isRecord(child.data) ? child.data.estree : undefined;
    const body = isRecord(estree) && Array.isArray(estree.body) ? estree.body : [];
    for (const statement of body) {
      if (!isRecord(statement) || statement.type !== "ImportDeclaration") continue;
      const source = isRecord(statement.source) ? statement.source.value : undefined;
      if (typeof source !== "string" || !Array.isArray(statement.specifiers)) continue;
      let specs = imports.get(source);
      if (!specs) {
        specs = [];
        imports.set(source, specs);
      }
      for (const spec of statement.specifiers) specs.push(parseImportSpecifier(spec, filePath));
    }
  }
  return imports;
}

function parseImportSpecifier(spec: unknown, filePath: string): ImportSpecifier {
  const unknownSpecifier = () => new Error(`Unknown import declaration specifier in ${filePath}`);
  const local = isRecord(spec) && isRecord(spec.local) ? spec.local.name : undefined;
  if (!isRecord(spec) || typeof local !== "string") throw unknownSpecifier();
  switch (spec.type) {
    case "ImportDefaultSpecifier":
      return { local, imported: "default" };
    case "ImportNamespaceSpecifier":
      return { local, imported: "*" };
    case "ImportSpecifier": {
      const imported = isRecord(spec.imported) ? spec.imported : {};
      // `import { "a-b" as x }` names the export with a string literal.
      const name = imported.type === "Identifier" ? imported.name : imported.value;
      if (typeof name !== "string") throw unknownSpecifier();
      return { local, imported: name };
    }
    default:
      throw unknownSpecifier();
  }
}

function isComponent(tagName: string): boolean {
  const first = tagName[0] ?? "";
  return (first !== "" && first.toLowerCase() !== first) || tagName.includes(".") || /[^a-zA-Z]/.test(first);
}

/** `<UI.Counter />` exports `Counter` from `import * as UI`, `default.Counter` from `import UI`, `UI.Counter` from `import { UI }`. */
function findMatchingImport(tagName: string, imports: Map<string, ImportSpecifier[]>): MatchedImport | undefined {
  const tagSpecifier = tagName.split(".")[0];
  for (const [source, specs] of imports) {
    for (const { imported, local } of specs) {
      if (local !== tagSpecifier) continue;
      if (tagSpecifier === tagName) return { name: imported, path: source };
      const accessPath = tagName.slice(tagSpecifier.length + 1);
      if (imported === "*") return { name: accessPath, path: source };
      if (imported === "default") return { name: `default.${accessPath}`, path: source };
      return { name: tagName, path: source };
    }
  }
  return undefined;
}

/** A bare namespace (`<UI client:load />`) exports the member path after the first dot: empty. */
function exportName(tagName: string, matched: MatchedImport): string {
  return matched.name === "*" ? tagName.split(".").slice(1).join(".") : matched.name;
}

/** The element's `client:component-export` when the plugin wrote its `client:component-path`, else `null`. */
function addClientMetadata(
  node: MdxJsxElement,
  tagName: string,
  names: string[],
  matched: MatchedImport,
  resolvedPath: string,
): string | null {
  const writesPath = !names.includes("client:component-path");
  if (writesPath) pushAttribute(node, "client:component-path", resolvedPath);
  if (!names.includes("client:component-export")) {
    pushAttribute(node, "client:component-export", exportName(tagName, matched));
  }
  if (!names.includes("client:component-hydration")) pushAttribute(node, "client:component-hydration", null);
  return writesPath ? writtenExport(node) : null;
}

// Astro also renames the element to `astro-client-only`; pletivo keeps the component for the runtime.
function addClientOnlyMetadata(
  node: MdxJsxElement,
  tagName: string,
  names: string[],
  matched: MatchedImport,
  resolvedPath: string,
): string | null {
  if (!names.includes("client:display-name")) pushAttribute(node, "client:display-name", tagName);
  // Unconditional: Astro guards this one with a misspelt name, so a written path is always overridden.
  pushAttribute(node, "client:component-path", resolvedPath);
  if (!names.includes("client:component-export")) {
    pushAttribute(node, "client:component-export", exportName(tagName, matched));
  }
  if (!names.includes("client:component-hydration")) pushAttribute(node, "client:component-hydration", null);
  return writtenExport(node);
}

/** The element's `client:component-export` as a string; an author's expression value is not one. */
function writtenExport(node: MdxJsxElement): string | null {
  for (const attr of node.attributes) {
    if (isRecord(attr) && attr.type === "mdxJsxAttribute" && attr.name === "client:component-export") {
      return typeof attr.value === "string" ? attr.value : null;
    }
  }
  return null;
}
