import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CacheStore, canReuseFingerprint, computeConfigHash, fingerprintFile, hashFileContent, hashString } from "../../packages/pletivo/src/incremental/cache";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-cache-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("CacheStore", () => {
	it("returns an empty cache when nothing is on disk", async () => {
		const store = await CacheStore.load(tmp, "any-config-hash");
		expect(store.routeKeys()).toEqual([]);
	});

	it("round-trips a single route through persist / load", async () => {
		const s1 = await CacheStore.load(tmp, "c1");
		s1.setRoute("page::__static__", {
			outPath: "page/index.html",
			outputHash: "deadbeef",
			depFingerprints: { "/abs/page.tsx": { mtimeMs: 1, size: 10, hash: "h1" } },
			islands: [],
			hoistedHashes: [],
			renderedModules: ["page.tsx"],
			tsxStyles: [],
			fragments: [],
		});
		await s1.persist();

		const s2 = await CacheStore.load(tmp, "c1");
		const r = s2.getRoute("page::__static__");
		expect(r?.outPath).toBe("page/index.html");
		expect(r?.outputHash).toBe("deadbeef");
		expect(r?.depFingerprints["/abs/page.tsx"]?.hash).toBe("h1");
	});

	it("ignores the on-disk cache when the configHash differs", async () => {
		const s1 = await CacheStore.load(tmp, "c1");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [] });
		await s1.persist();

		const s2 = await CacheStore.load(tmp, "c2");
		expect(s2.routeKeys()).toEqual([]);
	});

	it("forceClean wipes the on-disk cache", async () => {
		const s1 = await CacheStore.load(tmp, "c1");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [] });
		await s1.persist();
		// Plant a stray file in the cache dir so we can verify forceClean
		// wipes the whole directory tree.
		await fs.mkdir(path.join(tmp, ".pletivo", "cache"), { recursive: true });
		await fs.writeFile(path.join(tmp, ".pletivo", "cache", "ghost"), "x");

		const cleaned = await CacheStore.forceClean(tmp, "c1");
		expect(cleaned.routeKeys()).toEqual([]);
		await expect(fs.stat(path.join(tmp, ".pletivo", "cache", "ghost"))).rejects.toThrow();
	});

	it("pruneRoutes drops entries whose keys aren't in the keep set", async () => {
		const s = await CacheStore.load(tmp, "c1");
		s.setRoute("a", { outPath: "a.html", outputHash: "1", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [] });
		s.setRoute("b", { outPath: "b.html", outputHash: "2", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [] });
		s.setRoute("c", { outPath: "c.html", outputHash: "3", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [] });
		s.pruneRoutes(new Set(["a", "c"]));
		expect(s.routeKeys().sort()).toEqual(["a", "c"]);
	});

});

describe("fingerprintFile / canReuseFingerprint", () => {
	it("matches an unchanged file (mtime + size + hash all equal)", async () => {
		const f = path.join(tmp, "f.txt");
		await fs.writeFile(f, "hello");
		const fp = await fingerprintFile(f);
		expect(await canReuseFingerprint(f, fp)).toBe(true);
	});

	it("detects size changes immediately (skips the hash)", async () => {
		const f = path.join(tmp, "f.txt");
		await fs.writeFile(f, "hello");
		const fp = await fingerprintFile(f);
		await fs.writeFile(f, "hello world");
		expect(await canReuseFingerprint(f, fp)).toBe(false);
	});

	it("falls back to content hash when mtime drifted but size matches", async () => {
		const f = path.join(tmp, "f.txt");
		await fs.writeFile(f, "abcde");
		const fp = await fingerprintFile(f);
		// `utimes` to bump mtime without changing bytes — mimics
		// formatter passes / git checkout that re-stamp without
		// content change.
		const newMtime = new Date(fp.mtimeMs + 5000);
		await fs.utimes(f, newMtime, newMtime);
		expect(await canReuseFingerprint(f, fp)).toBe(true);
	});

	it("detects content changes when size happens to stay the same", async () => {
		const f = path.join(tmp, "f.txt");
		await fs.writeFile(f, "abcde");
		const fp = await fingerprintFile(f);
		await fs.writeFile(f, "edcba");
		// Force mtime drift so we go through the hash fallback.
		const newMtime = new Date(fp.mtimeMs + 5000);
		await fs.utimes(f, newMtime, newMtime);
		expect(await canReuseFingerprint(f, fp)).toBe(false);
	});

	it("treats a missing file as changed", async () => {
		const f = path.join(tmp, "f.txt");
		await fs.writeFile(f, "x");
		const fp = await fingerprintFile(f);
		await fs.unlink(f);
		expect(await canReuseFingerprint(f, fp)).toBe(false);
	});

	it("fingerprintFile returns sentinel values for missing files", async () => {
		const fp = await fingerprintFile(path.join(tmp, "ghost.txt"));
		expect(fp.hash).toBe("__missing__");
		expect(fp.size).toBe(-1);
	});
});

describe("hashing helpers", () => {
	it("hashFileContent is deterministic and content-sensitive", async () => {
		const a = path.join(tmp, "a.txt");
		await fs.writeFile(a, "hello");
		const h1 = await hashFileContent(a);
		const h2 = await hashFileContent(a);
		expect(h1).toBe(h2);
		await fs.writeFile(a, "world");
		const h3 = await hashFileContent(a);
		expect(h3).not.toBe(h1);
	});

	it("hashFileContent returns the missing sentinel for absent files", async () => {
		const h = await hashFileContent(path.join(tmp, "nope.txt"));
		expect(h).toBe("__missing__");
	});

	it("computeConfigHash mixes every input part", async () => {
		const h1 = await computeConfigHash(["a", "b"]);
		const h2 = await computeConfigHash(["a", "b"]);
		const h3 = await computeConfigHash(["a", "c"]);
		expect(h1).toBe(h2);
		expect(h3).not.toBe(h1);
	});

	it("hashString is deterministic", () => {
		expect(hashString("hello")).toBe(hashString("hello"));
		expect(hashString("hello")).not.toBe(hashString("hellow"));
	});
});
