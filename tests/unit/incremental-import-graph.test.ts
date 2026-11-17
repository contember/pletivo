import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FrameworkCompiler } from "../../packages/core/src/framework-compile/types";
import {
	collectStaticDeps,
	configureImportGraph,
	configureImportGraphCompilers,
	_resetImportGraphForTests,
} from "../../packages/pletivo/src/incremental/import-graph";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-graph-"));
	configureImportGraph(tmp);
	configureImportGraphCompilers([]);
	_resetImportGraphForTests();
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
	const abs = path.join(tmp, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
	return abs;
}

describe("collectStaticDeps", () => {
	it("returns just the entry when it has no imports", async () => {
		const entry = await write("a.ts", `export const x = 1;`);
		const deps = await collectStaticDeps(entry);
		expect([...deps]).toEqual([entry]);
	});

	it("walks named relative imports across .ts files", async () => {
		const helper = await write("helper.ts", `export const h = 1;`);
		const entry = await write("entry.ts", `import { h } from "./helper.ts"; export const x = h;`);
		const deps = await collectStaticDeps(entry);
		expect([...deps].sort()).toEqual([entry, helper].sort());
	});

	it("resolves extensionless relative imports against common extensions", async () => {
		const layout = await write("Layout.tsx", `export default () => null;`);
		const entry = await write("page.tsx", `import Layout from "./Layout"; export default () => Layout();`);
		const deps = await collectStaticDeps(entry);
		expect([...deps].sort()).toEqual([entry, layout].sort());
	});

	it("resolves an extensionless import to the file when a directory of that name sits beside it", async () => {
		const block = await write("blocks/Hero.ts", `export const hero = 1;`);
		const registry = await write("blocks.ts", `export { hero } from "./blocks/Hero.ts";`);
		const entry = await write("page.ts", `import { hero } from "./blocks"; export const x = hero;`);
		const deps = await collectStaticDeps(entry);
		expect([...deps].sort()).toEqual([entry, registry, block].sort());
	});

	it("resolves an extensionless import of a directory to its index file", async () => {
		const index = await write("blocks/index.ts", `export const hero = 1;`);
		const entry = await write("page.ts", `import { hero } from "./blocks"; export const x = hero;`);
		const deps = await collectStaticDeps(entry);
		expect([...deps].sort()).toEqual([entry, index].sort());
	});

	it("walks .astro files (transformed via @astrojs/compiler)", async () => {
		const dep = await write("Heading.astro", `<h1>hi</h1>`);
		const entry = await write("Page.astro", `---\nimport Heading from "./Heading.astro";\n---\n<Heading />`);
		const deps = await collectStaticDeps(entry);
		expect(deps.has(dep)).toBe(true);
	});

	it("walks transitive imports across multiple hops", async () => {
		const grandchild = await write("c.ts", `export const c = 3;`);
		const child = await write("b.ts", `import { c } from "./c.ts"; export const b = c;`);
		const entry = await write("a.ts", `import { b } from "./b.ts"; export const a = b;`);
		const deps = await collectStaticDeps(entry);
		expect([...deps].sort()).toEqual([entry, child, grandchild].sort());
	});

	it("survives cycles without infinite loops", async () => {
		const a = path.join(tmp, "a.ts");
		const b = path.join(tmp, "b.ts");
		await fs.writeFile(a, `import "./b.ts"; export const v = 1;`);
		await fs.writeFile(b, `import "./a.ts"; export const w = 2;`);
		const deps = await collectStaticDeps(a);
		expect([...deps].sort()).toEqual([a, b].sort());
	});

	it("skips node_modules entries", async () => {
		const nm = await write("node_modules/pkg/index.js", `export const x = 1;`);
		const entry = await write("page.ts", `import "pkg"; export const y = 1;`);
		// Bun.resolveSync may or may not find the package depending on env;
		// the test asserts the negative — node_modules paths are excluded
		// even if Bun does resolve them.
		const deps = await collectStaticDeps(entry);
		for (const d of deps) expect(d.includes("/node_modules/")).toBe(false);
		void nm;
	});

	it("skips virtual/built-in specifiers (astro:content, node:fs, …)", async () => {
		const entry = await write(
			"page.ts",
			`import "astro:content"; import "node:fs"; import "bun:test"; export const x = 1;`,
		);
		const deps = await collectStaticDeps(entry);
		expect([...deps]).toEqual([entry]);
	});

	it("ignores paths outside the configured project root", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-out-"));
		try {
			const external = path.join(outside, "ext.ts");
			await fs.writeFile(external, `export const e = 1;`);
			const entry = await write("page.ts", `import "${external}"; export const x = 1;`);
			const deps = await collectStaticDeps(entry);
			expect(deps.has(external)).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	describe("a file only a framework compiler reads", () => {
		// Stands in for Svelte's: its server module keeps the component's own `<script>` imports.
		const scriptCompiler: FrameworkCompiler = {
			framework: "Test",
			extensions: [".comp"],
			async compile({ source }) {
				if (source.includes("BROKEN")) throw new Error("syntax error");
				const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
				return { code: `${script}\nexport default {};`, loader: "ts", css: null };
			},
		};

		it("is walked through its compiled module", async () => {
			const css = await write("child.css", `.c{}`);
			const child = await write("Child.comp", `<script>import "./child.css";</script><p>c</p>`);
			const parent = await write("Parent.comp", `<script>import Child from "./Child.comp";</script><Child />`);
			const entry = await write("page.ts", `export const load = () => import("./Parent.comp");`);
			configureImportGraphCompilers([scriptCompiler]);
			const deps = await collectStaticDeps(entry);
			expect([...deps].sort()).toEqual([entry, parent, child, css].sort());
		});

		it("adds no dependency of its own without a compiler, or when it does not compile", async () => {
			const child = await write("Child.comp", `<script>import "./other.ts";</script>`);
			await write("other.ts", `export const o = 1;`);
			const onlyBroken = await write("only-broken.ts", `export const b = 1;`);
			const broken = await write("Broken.comp", `<script>import "./only-broken.ts"; BROKEN</script>`);
			const entry = await write("page.ts", `import "./Child.comp"; import "./Broken.comp";`);
			expect([...(await collectStaticDeps(entry))].sort()).toEqual([entry, child, broken].sort());

			_resetImportGraphForTests();
			configureImportGraphCompilers([scriptCompiler]);
			const deps = await collectStaticDeps(entry);
			expect(deps.has(path.join(tmp, "other.ts"))).toBe(true);
			expect(deps.has(broken)).toBe(true);
			expect(deps.has(onlyBroken)).toBe(false);
		});
	});

	it("returns just the entry when the file is unreadable", async () => {
		const ghost = path.join(tmp, "ghost.ts");
		// Don't create — collectStaticDeps must not throw.
		const deps = await collectStaticDeps(ghost);
		expect([...deps]).toEqual([ghost]);
	});
});
