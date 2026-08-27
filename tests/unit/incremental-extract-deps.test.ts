import { describe, expect, it } from "bun:test";

import { extractEntryFilePaths } from "@pletivo/core/incremental/extract-deps";

describe("extractEntryFilePaths", () => {
	it("returns empty for primitives and null", () => {
		expect(extractEntryFilePaths(null).size).toBe(0);
		expect(extractEntryFilePaths(undefined).size).toBe(0);
		expect(extractEntryFilePaths(42).size).toBe(0);
		expect(extractEntryFilePaths("x").size).toBe(0);
	});

	it("picks up _filePath at the top level", () => {
		const out = extractEntryFilePaths({ _filePath: "/abs/post.md" });
		expect([...out]).toEqual(["/abs/post.md"]);
	});

	it("picks up _mdxFilePath", () => {
		const out = extractEntryFilePaths({ _mdxFilePath: "/abs/post.mdx" });
		expect([...out]).toEqual(["/abs/post.mdx"]);
	});

	it("walks into nested objects", () => {
		const out = extractEntryFilePaths({
			post: { id: "p", data: { title: "t" }, _filePath: "/abs/p.md" },
		});
		expect([...out]).toEqual(["/abs/p.md"]);
	});

	it("walks into arrays and de-dupes", () => {
		const out = extractEntryFilePaths({
			related: [
				{ id: "a", _filePath: "/abs/a.md" },
				{ id: "b", _filePath: "/abs/b.md" },
				{ id: "a", _filePath: "/abs/a.md" },
			],
		});
		expect([...out].sort()).toEqual(["/abs/a.md", "/abs/b.md"]);
	});

	it("ignores relative _filePath strings", () => {
		const out = extractEntryFilePaths({ _filePath: "./relative.md" });
		expect(out.size).toBe(0);
	});

	it("ignores non-string _filePath values", () => {
		const out = extractEntryFilePaths({ _filePath: 123 });
		expect(out.size).toBe(0);
	});

	it("survives circular references", () => {
		const a: Record<string, unknown> = { _filePath: "/abs/a.md" };
		const b: Record<string, unknown> = { ref: a };
		a.ref = b;
		const out = extractEntryFilePaths(a);
		expect([...out]).toEqual(["/abs/a.md"]);
	});

	it("doesn't walk into class instances or Date/Map/Set", () => {
		class Custom {
			_filePath = "/abs/from-class.md";
		}
		expect(extractEntryFilePaths(new Custom()).size).toBe(0);
		expect(extractEntryFilePaths(new Date()).size).toBe(0);
		expect(extractEntryFilePaths(new Map()).size).toBe(0);
	});
});
