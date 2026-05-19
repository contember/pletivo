import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	collectStaticDeps,
	configureImportGraph,
	_resetImportGraphForTests,
} from "../../packages/pletivo/src/incremental/import-graph";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-graph-"));
	configureImportGraph(tmp);
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

	it("returns just the entry when the file is unreadable", async () => {
		const ghost = path.join(tmp, "ghost.ts");
		// Don't create — collectStaticDeps must not throw.
		const deps = await collectStaticDeps(ghost);
		expect([...deps]).toEqual([ghost]);
	});
});
