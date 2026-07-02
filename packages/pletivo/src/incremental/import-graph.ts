import path from "node:path";
import fs from "node:fs/promises";
import { transform as astroTransform } from "@astrojs/compiler";

/**
 * Build the per-file static-import graph by parsing each source file's
 * own text rather than relying on Bun's loader to fire plugin hooks
 * for nested imports (which it doesn't, for transitive imports of
 * cached `.tsx` modules).
 *
 * For each visited file we:
 *   1. Read it
 *   2. Transform `.astro` to JS via @astrojs/compiler (the result is
 *      still TS, but Bun.Transpiler.scanImports handles that)
 *   3. Run `Bun.Transpiler.scanImports` to extract every static
 *      and dynamic import specifier
 *   4. Resolve each specifier against the file's directory
 *   5. Recurse on every resolved file inside the project root
 *
 * Resolution is intentionally limited to project sources — anything
 * under `node_modules` is skipped (its content is pinned by the
 * lockfile, which the cache's `configHash` already covers) and any
 * bare specifier that doesn't resolve to a project file is dropped.
 *
 * The graph is process-global and cached by absolute file path —
 * subsequent queries for the same entry reuse the previous walk.
 */

const importsCache = new Map<string, Promise<Set<string>>>();
let projectRoot: string | null = null;

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const jsTranspiler = new Bun.Transpiler({ loader: "js" });
const jsxTranspiler = new Bun.Transpiler({ loader: "jsx" });

export function configureImportGraph(rootDir: string): void {
	projectRoot = rootDir;
}

const WALKABLE_SOURCE_EXTS = new Set([".mdx", ".astro", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]);

/**
 * True for file extensions whose contents can pull in further static
 * imports — i.e. extensions `collectStaticDeps` knows how to walk
 * through. Caller sites use this to decide whether to enqueue an
 * extra-dep (a runtime-captured or per-slug-attributed file) for a
 * transitive walk on top of just fingerprinting the file itself.
 */
export function isWalkableSourceFile(p: string): boolean {
	const i = p.lastIndexOf(".");
	if (i < 0) return false;
	return WALKABLE_SOURCE_EXTS.has(p.slice(i).toLowerCase());
}

/**
 * Return the transitive closure of static + dynamic imports starting at
 * `entry`. Includes `entry` itself.
 */
export async function collectStaticDeps(entry: string): Promise<Set<string>> {
	const root = stripQuery(entry);
	const visited = new Set<string>([root]);
	const queue: string[] = [root];
	while (queue.length > 0) {
		const file = queue.shift()!;
		let imports: Set<string>;
		try {
			imports = await importsForFile(file);
		} catch {
			continue;
		}
		for (const imp of imports) {
			if (!visited.has(imp)) {
				visited.add(imp);
				queue.push(imp);
			}
		}
	}
	return visited;
}

async function importsForFile(file: string): Promise<Set<string>> {
	let promise = importsCache.get(file);
	if (!promise) {
		promise = scanImportsOf(file);
		importsCache.set(file, promise);
	}
	return await promise;
}

async function scanImportsOf(file: string): Promise<Set<string>> {
	let source: string;
	try {
		source = await fs.readFile(file, "utf8");
	} catch {
		return new Set();
	}

	const ext = path.extname(file).toLowerCase();
	let scanSource = source;

	if (ext === ".astro") {
		try {
			const result = await astroTransform(source, {
				filename: file,
				sourcemap: false,
				resolvePath: async (s) => s,
			});
			const scriptSources = result.scripts.map((script) =>
				script.type === "inline"
					? script.code
					: `import ${JSON.stringify(script.src)};`
			);
			scanSource = [result.code, ...scriptSources].join("\n");
		} catch {
			// If the compiler can't parse the file (mid-edit, syntax
			// error, etc.) we drop dep tracking for it — the cache
			// will skip on the next valid build.
			return new Set();
		}
	} else if (ext === ".mdx") {
		try {
			// Strip YAML frontmatter so it doesn't trip the MDX parser
			// (mirrors what `mdx-plugin.ts` does at load time).
			const body = stripMdxFrontmatter(source);
			const { compile } = await import("@mdx-js/mdx");
			const result = await compile(body, { jsxImportSource: "pletivo" });
			scanSource = String(result);
		} catch {
			return new Set();
		}
	}

	let raw: { path: string; kind?: string }[];
	try {
		raw = pickTranspiler(ext).scanImports(scanSource);
	} catch {
		return new Set();
	}

	const out = new Set<string>();
	for (const { path: spec } of raw) {
		const resolved = await resolveSpecifier(spec, file);
		if (resolved) out.add(resolved);
	}
	return out;
}

function pickTranspiler(ext: string): Bun.Transpiler {
	if (ext === ".tsx" || ext === ".astro" || ext === ".mdx") return tsxTranspiler;
	if (ext === ".jsx") return jsxTranspiler;
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return jsTranspiler;
	return tsTranspiler;
}

function stripMdxFrontmatter(source: string): string {
	const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	return m ? m[2] : source;
}

async function resolveSpecifier(specifier: string, importer: string): Promise<string | null> {
	const clean = stripQuery(specifier);
	if (!clean) return null;
	// node:/bun: builtins, virtual modules (`astro:content`), etc.
	if (isVirtualOrBuiltin(clean)) return null;

	const importerDir = path.dirname(importer);
	let candidate = clean;
	if (clean.startsWith(".") || clean.startsWith("/")) {
		candidate = path.isAbsolute(clean) ? clean : path.resolve(importerDir, clean);
	} else {
		try {
			candidate = Bun.resolveSync(clean, importerDir);
		} catch {
			return null;
		}
	}

	if (!path.isAbsolute(candidate)) return null;
	if (candidate.includes("/node_modules/")) return null;
	if (projectRoot && !candidate.startsWith(projectRoot)) return null;

	// Relative imports that omit the extension (`./Layout`) need to be
	// resolved to a real file. Try common extensions.
	if (await exists(candidate)) return candidate;
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".astro", ".mjs", ".cjs", ".css", ".scss", ".sass"]) {
		if (await exists(candidate + ext)) return candidate + ext;
	}
	for (const ext of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.css", "/index.scss", "/index.sass"]) {
		if (await exists(candidate + ext)) return candidate + ext;
	}
	return null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function isVirtualOrBuiltin(spec: string): boolean {
	if (spec.startsWith("node:") || spec.startsWith("bun:")) return true;
	// `astro:content`, `astro:assets`, `pletivo:hoisted:…`, etc.
	if (/^[a-z][a-z0-9-]*:/.test(spec) && !path.isAbsolute(spec)) return true;
	return false;
}

function stripQuery(p: string): string {
	const q = p.indexOf("?");
	return q === -1 ? p : p.slice(0, q);
}

/** For tests. */
export function _resetImportGraphForTests(): void {
	importsCache.clear();
}
