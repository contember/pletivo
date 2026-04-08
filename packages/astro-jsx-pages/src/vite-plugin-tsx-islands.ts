import type { Plugin } from 'vite';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { ASTRO_JSX_RENDERER } from './constants.js';

// Use require for babel packages due to ESM/CJS interop issues with TypeScript
const require = createRequire(import.meta.url);
const traverse = require('@babel/traverse').default as typeof import('@babel/traverse').default;
const generate = require('@babel/generator').default as typeof import('@babel/generator').default;

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const PAGES_PATH_PATTERN = /src\/pages\/.*\.[jt]sx$/;
const JSX_IMPORT_SOURCE = 'astro';
const ISLAND_RUNTIME_IMPORT = '@pavouk/astro-jsx-pages/react-island-runtime';

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface ImportInfo {
  defaultImport?: string;
  namedImports: Map<string, string>; // localName -> importedName
  path: string;
}

interface IslandComponentInfo {
  client: string;
  clientValue?: string;
  hasContexts: boolean;
}

interface ClientDirective {
  type: 'load' | 'idle' | 'visible' | 'media' | 'only';
  value?: string;
}

// Cache for island component detection
const islandComponentCache = new Map<string, IslandComponentInfo | null>();

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveImportPath(importPath: string, fileId: string): Promise<string> {
  if (importPath.startsWith('.')) {
    const dir = path.dirname(fileId);
    let resolved = path.resolve(dir, importPath);

    if (!path.extname(resolved)) {
      const extensions = ['.tsx', '.ts', '.jsx', '.js'];
      for (const ext of extensions) {
        if (await fileExists(resolved + ext)) {
          resolved = resolved + ext;
          break;
        }
      }
    }

    return resolved;
  }
  return importPath;
}

/**
 * Detects if a component file uses asIsland() and extracts the config.
 */
async function detectIslandComponent(filePath: string): Promise<IslandComponentInfo | null> {
  if (islandComponentCache.has(filePath)) {
    return islandComponentCache.get(filePath) || null;
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const ast = parse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    });

    let result: IslandComponentInfo | null = null;

    traverse(ast, {
      ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
        const decl = path.node.declaration;
        // Look for: export default asIsland(Component, { client: 'load', ... })
        if (t.isCallExpression(decl) && t.isIdentifier(decl.callee, { name: 'asIsland' })) {
          const configArg = decl.arguments[1];
          if (t.isObjectExpression(configArg)) {
            let client = 'load';
            let clientValue: string | undefined;
            let hasContexts = false;

            for (const prop of configArg.properties) {
              if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                if (prop.key.name === 'client' && t.isStringLiteral(prop.value)) {
                  client = prop.value.value;
                }
                if (prop.key.name === 'clientValue' && t.isStringLiteral(prop.value)) {
                  clientValue = prop.value.value;
                }
                if (prop.key.name === 'contexts') {
                  hasContexts = true;
                }
              }
            }

            result = { client, clientValue, hasContexts };
          }
        }
      },
    });

    islandComponentCache.set(filePath, result);
    return result;
  } catch {
    islandComponentCache.set(filePath, null);
    return null;
  }
}

/**
 * Parse imports from AST into a map of local names to import info.
 */
function parseImportsFromAST(ast: t.File): Map<string, ImportInfo> {
  const imports = new Map<string, ImportInfo>();

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const importPath = path.node.source.value;
      const namedImports = new Map<string, string>();
      let defaultImport: string | undefined;

      for (const specifier of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(specifier)) {
          defaultImport = specifier.local.name;
        } else if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          namedImports.set(specifier.local.name, imported);
        }
      }

      const info: ImportInfo = { namedImports, path: importPath };
      if (defaultImport) {
        info.defaultImport = defaultImport;
        imports.set(defaultImport, info);
      }
      for (const [localName] of namedImports) {
        imports.set(localName, info);
      }
    },
  });

  return imports;
}

/**
 * Extract client directive from JSX attributes.
 */
function extractClientDirective(attributes: (t.JSXAttribute | t.JSXSpreadAttribute)[]): ClientDirective | null {
  for (const attr of attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXNamespacedName(attr.name)) {
      if (attr.name.namespace.name === 'client') {
        const type = attr.name.name.name as ClientDirective['type'];
        if (['load', 'idle', 'visible', 'media', 'only'].includes(type)) {
          let value: string | undefined;
          if (t.isStringLiteral(attr.value)) {
            value = attr.value.value;
          } else if (t.isJSXExpressionContainer(attr.value) && t.isStringLiteral(attr.value.expression)) {
            value = attr.value.expression.value;
          }
          return { type, value };
        }
      }
    }
  }
  return null;
}

/**
 * Extract client:contexts value from JSX attributes.
 */
function extractClientContexts(attributes: (t.JSXAttribute | t.JSXSpreadAttribute)[]): t.Expression | null {
  for (const attr of attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXNamespacedName(attr.name)) {
      if (attr.name.namespace.name === 'client' && attr.name.name.name === 'contexts') {
        if (t.isJSXExpressionContainer(attr.value) && t.isExpression(attr.value.expression)) {
          return attr.value.expression;
        }
      }
    }
  }
  return null;
}

/**
 * Convert JSX attributes to object properties for props object.
 * Filters out client: directives.
 */
function jsxAttributesToObjectProperties(
  attributes: (t.JSXAttribute | t.JSXSpreadAttribute)[]
): (t.ObjectProperty | t.SpreadElement)[] {
  const properties: (t.ObjectProperty | t.SpreadElement)[] = [];

  for (const attr of attributes) {
    if (t.isJSXSpreadAttribute(attr)) {
      properties.push(t.spreadElement(attr.argument));
      continue;
    }

    // Skip client: directives
    if (t.isJSXNamespacedName(attr.name) && attr.name.namespace.name === 'client') {
      continue;
    }

    const key = t.isJSXIdentifier(attr.name)
      ? t.stringLiteral(attr.name.name)
      : t.stringLiteral(attr.name.name.name);

    let value: t.Expression;
    if (attr.value === null) {
      // Boolean prop: <Comp disabled /> -> disabled: true
      value = t.booleanLiteral(true);
    } else if (t.isStringLiteral(attr.value)) {
      value = attr.value;
    } else if (t.isJSXExpressionContainer(attr.value)) {
      if (t.isJSXEmptyExpression(attr.value.expression)) {
        value = t.identifier('undefined');
      } else {
        value = attr.value.expression;
      }
    } else if (t.isJSXElement(attr.value) || t.isJSXFragment(attr.value)) {
      value = attr.value;
    } else {
      continue;
    }

    properties.push(t.objectProperty(key, value));
  }

  return properties;
}

/**
 * Build an Island JSX element from component info.
 */
function buildIslandElement(
  componentName: string,
  props: t.ObjectExpression,
  componentPath: string,
  componentExport: string,
  directive: ClientDirective,
  children: t.JSXElement['children'] | null,
  contexts: t.Expression | null,
): t.JSXElement {
  const attributes: t.JSXAttribute[] = [
    t.jsxAttribute(
      t.jsxIdentifier('Component'),
      t.jsxExpressionContainer(t.identifier(componentName))
    ),
    t.jsxAttribute(
      t.jsxIdentifier('props'),
      t.jsxExpressionContainer(props)
    ),
    t.jsxAttribute(
      t.jsxIdentifier('componentPath'),
      t.stringLiteral(componentPath)
    ),
    t.jsxAttribute(
      t.jsxIdentifier('componentExport'),
      t.stringLiteral(componentExport)
    ),
    t.jsxAttribute(
      t.jsxIdentifier('client'),
      t.stringLiteral(directive.type)
    ),
  ];

  if (directive.value) {
    attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('clientValue'),
        t.stringLiteral(directive.value)
      )
    );
  }

  if (children && children.length > 0) {
    // Wrap children in a fragment if multiple, otherwise use directly
    const childrenExpr = children.length === 1 && t.isJSXExpressionContainer(children[0])
      ? children[0].expression
      : t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), children);

    if (!t.isJSXEmptyExpression(childrenExpr)) {
      attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier('children'),
          t.jsxExpressionContainer(childrenExpr as t.Expression)
        )
      );
    }
  }

  if (contexts) {
    attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('__contexts'),
        t.jsxExpressionContainer(contexts)
      )
    );
  }

  return t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier('_$$Island'), attributes, true),
    null,
    [],
    true
  );
}

// ═══════════════════════════════════════════════════════════
// PLUGIN OPTIONS
// ═══════════════════════════════════════════════════════════

export interface PluginOptions {
  jsxRuntime?: 'astro' | 'react';
}

// ═══════════════════════════════════════════════════════════
// PRE-PLUGIN: JSX Pragma & Client Directive Injection
// ═══════════════════════════════════════════════════════════

export function vitePluginTsxIslandsPre(options: PluginOptions = {}): Plugin {
  const jsxRuntime = options.jsxRuntime ?? 'astro';

  return {
    name: 'astro:tsx-islands-pre',
    enforce: 'pre',

    async transform(code: string, id: string) {
      if (!PAGES_PATH_PATTERN.test(id)) {
        return null;
      }

      const isReactPage = jsxRuntime === 'react' || code.includes('@jsxImportSource react');
      const hasClientDirectives = code.includes('client:');

      // Parse the code into AST
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });

      const imports = parseImportsFromAST(ast);
      const hydratedComponents: Array<{
        exportName: string;
        localName: string;
        specifier: string;
        resolvedPath: string;
      }> = [];

      let needsIslandImport = false;
      const processedComponents = new Set<string>();

      // Transform client: directives
      if (hasClientDirectives) {
        traverse(ast, {
          JSXElement: {
            enter: (nodePath: NodePath<t.JSXElement>) => {
              const openingElement = nodePath.node.openingElement;

              // Only process component elements (uppercase first letter)
              if (!t.isJSXIdentifier(openingElement.name)) return;
              const componentName = openingElement.name.name;
              if (!/^[A-Z]/.test(componentName)) return;

              const directive = extractClientDirective(openingElement.attributes);
              if (!directive) return;

              const importInfo = imports.get(componentName);
              if (!importInfo) {
                console.warn(`Could not resolve import for: ${componentName}`);
                return;
              }

              // This is async but we need sync - we'll handle this differently
              // For now, store the path and resolve later
              nodePath.setData('pendingTransform', {
                componentName,
                importInfo,
                directive,
              });
            },
          },
        });

        // Second pass: resolve paths and transform (async)
        const pendingTransforms: Array<{
          nodePath: NodePath<t.JSXElement>;
          componentName: string;
          importInfo: ImportInfo;
          directive: ClientDirective;
        }> = [];

        traverse(ast, {
          JSXElement(nodePath: NodePath<t.JSXElement>) {
            const data = nodePath.getData('pendingTransform');
            if (data) {
              pendingTransforms.push({ nodePath, ...data });
            }
          },
        });

        for (const { nodePath, componentName, importInfo, directive } of pendingTransforms) {
          try {
            const resolvedPath = await resolveImportPath(importInfo.path, id);
            const exportName = importInfo.defaultImport === componentName
              ? 'default'
              : importInfo.namedImports.get(componentName) || 'default';

            hydratedComponents.push({
              exportName: '*',
              localName: '',
              specifier: componentName,
              resolvedPath,
            });
            processedComponents.add(componentName);

            if (isReactPage) {
              // Transform to Island component
              needsIslandImport = true;

              const attributes = nodePath.node.openingElement.attributes;
              const contexts = extractClientContexts(attributes);
              const propsProperties = jsxAttributesToObjectProperties(attributes);
              const propsObject = t.objectExpression(propsProperties);

              const children = nodePath.node.children.length > 0 ? nodePath.node.children : null;

              const islandElement = buildIslandElement(
                componentName,
                propsObject,
                resolvedPath,
                exportName,
                directive,
                children,
                contexts,
              );

              nodePath.replaceWith(islandElement);
            } else {
              // For Astro pages: add metadata attributes
              const openingElement = nodePath.node.openingElement;
              openingElement.attributes.push(
                t.jsxAttribute(
                  t.jsxNamespacedName(t.jsxIdentifier('client'), t.jsxIdentifier('component-path')),
                  t.stringLiteral(resolvedPath)
                ),
                t.jsxAttribute(
                  t.jsxNamespacedName(t.jsxIdentifier('client'), t.jsxIdentifier('component-export')),
                  t.stringLiteral(exportName)
                ),
                t.jsxAttribute(
                  t.jsxNamespacedName(t.jsxIdentifier('client'), t.jsxIdentifier('component-hydration')),
                  null
                ),
              );
            }
          } catch (error) {
            console.warn(`Error resolving import path for ${componentName}: ${error}`);
          }
        }
      }

      // For React pages, detect and transform asIsland() components
      if (isReactPage) {
        const islandComponents = new Map<string, { info: IslandComponentInfo; resolvedPath: string }>();

        for (const [componentName, importInfo] of imports) {
          if (!/^[A-Z]/.test(componentName)) continue;
          if (processedComponents.has(componentName)) continue;

          try {
            const resolvedPath = await resolveImportPath(importInfo.path, id);
            const islandInfo = await detectIslandComponent(resolvedPath);

            if (islandInfo) {
              islandComponents.set(componentName, { info: islandInfo, resolvedPath });
            }
          } catch {
            // Ignore resolution errors
          }
        }

        if (islandComponents.size > 0) {
          needsIslandImport = true;

          traverse(ast, {
            JSXElement(nodePath: NodePath<t.JSXElement>) {
              const openingElement = nodePath.node.openingElement;
              if (!t.isJSXIdentifier(openingElement.name)) return;

              const componentName = openingElement.name.name;
              const islandData = islandComponents.get(componentName);
              if (!islandData) return;

              const { info, resolvedPath } = islandData;
              const importInfo = imports.get(componentName);
              const exportName = importInfo?.defaultImport === componentName
                ? 'default'
                : importInfo?.namedImports.get(componentName) || 'default';

              const attributes = openingElement.attributes;
              const contexts = extractClientContexts(attributes);
              const propsProperties = jsxAttributesToObjectProperties(attributes);
              const propsObject = t.objectExpression(propsProperties);

              const children = nodePath.node.children.length > 0 ? nodePath.node.children : null;

              const directive: ClientDirective = {
                type: info.client as ClientDirective['type'],
                value: info.clientValue,
              };

              const islandElement = buildIslandElement(
                componentName,
                propsObject,
                resolvedPath,
                exportName,
                directive,
                children,
                contexts,
              );

              nodePath.replaceWith(islandElement);

              if (!hydratedComponents.some(c => c.resolvedPath === resolvedPath)) {
                hydratedComponents.push({
                  exportName: '*',
                  localName: '',
                  specifier: componentName,
                  resolvedPath,
                });
              }
            },
          });
        }
      }

      // Add Island import if needed
      if (needsIslandImport) {
        const importDecl = t.importDeclaration(
          [t.importSpecifier(t.identifier('_$$Island'), t.identifier('Island'))],
          t.stringLiteral(ISLAND_RUNTIME_IMPORT)
        );
        ast.program.body.unshift(importDecl);
      }

      // Add jsxImportSource pragma if not present
      const hasJsxPragma = ast.comments?.some(c => c.value.includes('@jsxImportSource'));
      if (!hasJsxPragma) {
        const importSource = jsxRuntime === 'react' ? 'react' : JSX_IMPORT_SOURCE;
        const comment: t.Comment = {
          type: 'CommentBlock',
          value: `* @jsxImportSource ${importSource} `,
        };
        if (!ast.program.body[0].leadingComments) {
          ast.program.body[0].leadingComments = [];
        }
        ast.program.body[0].leadingComments.unshift(comment);
      }

      const output = generate(ast, { retainLines: true }, code);

      return {
        code: output.code,
        map: output.map,
        meta: {
          astro: {
            hydratedComponents,
            clientOnlyComponents: [],
            serverComponents: [],
            scripts: [],
            propagation: 'none',
            containsHead: false,
            pageOptions: {},
          },
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════
// POST-PLUGIN: Component Tagging
// ═══════════════════════════════════════════════════════════

export function vitePluginTsxIslandsPost(options: PluginOptions = {}): Plugin {
  const configuredRuntime = options.jsxRuntime ?? 'astro';

  return {
    name: 'astro:tsx-islands-post',

    transform(code: string, id: string, opts) {
      if (!PAGES_PATH_PATTERN.test(id) || !opts?.ssr) {
        return null;
      }

      // After JSX transform, check for react-jsx imports
      const isReactPage = configuredRuntime === 'react' ||
        code.includes('react/jsx-runtime') || code.includes('react/jsx-dev-runtime');

      if (!code.includes('export default')) {
        return null;
      }

      // Parse the transformed code
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });

      let exportName: string | null = null;

      traverse(ast, {
        ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
          const decl = path.node.declaration;

          if (t.isFunctionDeclaration(decl) && decl.id) {
            exportName = decl.id.name;
          } else if (t.isIdentifier(decl)) {
            exportName = decl.name;
          } else if (t.isFunctionExpression(decl) || t.isArrowFunctionExpression(decl)) {
            // Anonymous function - need to wrap it
            exportName = '_$$TsxPageComponent';

            // Replace: export default () => ... with: const _$$TsxPageComponent = () => ...; export default _$$TsxPageComponent;
            const varDecl = t.variableDeclaration('const', [
              t.variableDeclarator(t.identifier(exportName), decl),
            ]);
            const newExport = t.exportDefaultDeclaration(t.identifier(exportName));

            path.replaceWithMultiple([varDecl, newExport]);
          }
        },
      });

      if (!exportName) {
        return null;
      }

      // Add tagging code at the end
      const tagImport = t.importDeclaration(
        [t.importSpecifier(t.identifier('__astro_tag_component__'), t.identifier('__astro_tag_component__'))],
        t.stringLiteral('astro/runtime/server/index.js')
      );

      // Check if import already exists
      let hasTagImport = false;
      traverse(ast, {
        ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
          if (path.node.source.value === 'astro/runtime/server/index.js') {
            hasTagImport = true;
          }
        },
      });

      if (!hasTagImport) {
        ast.program.body.unshift(tagImport);
      }

      // Add tagging statements at the end
      const tagCall = t.expressionStatement(
        t.callExpression(t.identifier('__astro_tag_component__'), [
          t.identifier(exportName),
          t.stringLiteral(ASTRO_JSX_RENDERER),
        ])
      );

      const moduleIdAssignment = t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(t.identifier(exportName), t.identifier('moduleId')),
          t.stringLiteral(id)
        )
      );

      const needsHeadRendering = t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            t.identifier(exportName),
            t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('for')), [
              t.stringLiteral('astro.needsHeadRendering'),
            ]),
            true // computed
          ),
          t.booleanLiteral(true)
        )
      );

      ast.program.body.push(tagCall, moduleIdAssignment, needsHeadRendering);

      // For React pages, add additional marker
      if (isReactPage) {
        const reactMarker = t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(
              t.identifier(exportName),
              t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('for')), [
                t.stringLiteral('astro-jsx-pages.react'),
              ]),
              true
            ),
            t.booleanLiteral(true)
          )
        );
        ast.program.body.push(reactMarker);
      }

      const output = generate(ast, { retainLines: true }, code);

      return {
        code: output.code,
        map: output.map,
      };
    },
  };
}
