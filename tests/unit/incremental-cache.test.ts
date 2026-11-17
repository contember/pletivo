import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CacheStore, canReuseFingerprint, computeConfigHash, fingerprintFile, hashFileContent, hashString, paramsToKey } from "../../packages/pletivo/src/incremental/cache";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-cache-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("CacheStore", () => {
	it("returns an empty cache when nothing is on disk", async () => {
		const store = await CacheStore.load(tmp, "any-config-hash", "dist");
		expect(store.routeKeys()).toEqual([]);
	});

	it("round-trips a single route through persist / load", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("page::__static__", {
			outPath: "page/index.html",
			outputHash: "deadbeef",
			depFingerprints: { "/abs/page.tsx": { mtimeMs: 1, size: 10, hash: "h1" } },
			islands: [],
			hoistedHashes: [],
			astroIslands: [{ componentPath: "/abs/Counter.vue", exportName: "default" }],
			renderedModules: ["page.tsx"],
			tsxStyles: [],
			fragments: [],
			cssHead: { fragment: "<style>.a{}</style>\n", pageCss: "" },
			dynamicCss: ["/abs/dyn.css", "/abs/Dyn.svelte.pletivo-style.css"],
			size: 0,
		});
		s1.setVirtualCss("/abs/Dyn.svelte.pletivo-style.css", ".d{}");
		s1.setRouteOutputs(["page/index.html"]);
		await s1.persist();

		const s2 = await CacheStore.load(tmp, "c1", "dist");
		const r = s2.getRoute("page::__static__");
		expect(r?.outPath).toBe("page/index.html");
		expect(r?.outputHash).toBe("deadbeef");
		expect(r?.depFingerprints["/abs/page.tsx"]?.hash).toBe("h1");
		expect(r?.astroIslands).toEqual([{ componentPath: "/abs/Counter.vue", exportName: "default" }]);
		expect(r?.cssHead).toEqual({ fragment: "<style>.a{}</style>\n", pageCss: "" });
		expect(r?.dynamicCss).toEqual(["/abs/dyn.css", "/abs/Dyn.svelte.pletivo-style.css"]);
		expect(s2.virtualCss("/abs/Dyn.svelte.pletivo-style.css")).toBe(".d{}");
	});

	it("ignores the on-disk cache when the configHash differs", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s1.setRouteOutputs(["k.html"]);
		await s1.persist();
		expect((await CacheStore.load(tmp, "c1", "dist")).routeKeys()).toEqual(["k"]);

		const s2 = await CacheStore.load(tmp, "c2", "dist");
		expect(s2.routeKeys()).toEqual([]);
	});

	it("forceClean wipes the on-disk cache", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		await s1.persist();
		// Plant a stray file in the cache dir so we can verify forceClean
		// wipes the whole directory tree.
		await fs.mkdir(path.join(tmp, "node_modules", ".pletivo", "cache"), { recursive: true });
		await fs.writeFile(path.join(tmp, "node_modules", ".pletivo", "cache", "ghost"), "x");

		const cleaned = await CacheStore.forceClean(tmp, "c1", "dist");
		expect(cleaned.routeKeys()).toEqual([]);
		await expect(fs.stat(path.join(tmp, "node_modules", ".pletivo", "cache", "ghost"))).rejects.toThrow();
	});

	it("pruneRoutes drops entries whose keys aren't in the keep set", async () => {
		const s = await CacheStore.load(tmp, "c1", "dist");
		s.setRoute("a", { outPath: "a.html", outputHash: "1", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s.setRoute("b", { outPath: "b.html", outputHash: "2", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s.setRoute("c", { outPath: "c.html", outputHash: "3", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s.pruneRoutes(new Set(["a", "c"]));
		expect(s.routeKeys().sort()).toEqual(["a", "c"]);
	});

	it("pruneRoutes keeps in-memory stylesheet text only while a kept route lists it", async () => {
		const s = await CacheStore.load(tmp, "c1", "dist");
		s.setRoute("a", { outPath: "a.html", outputHash: "1", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: ["/abs/A.css"], size: 0 });
		s.setRoute("b", { outPath: "b.html", outputHash: "2", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: ["/abs/B.css"], size: 0 });
		s.setVirtualCss("/abs/A.css", ".a{}");
		s.setVirtualCss("/abs/B.css", ".b{}");
		s.pruneRoutes(new Set(["a"]));
		expect(s.virtualCss("/abs/A.css")).toBe(".a{}");
		expect(s.virtualCss("/abs/B.css")).toBeUndefined();
	});

	it("keeps the route output record when the render cache is invalidated", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s1.setRouteOutputs(["feed.xml", "about/index.html"]);
		await s1.persist();

		const s2 = await CacheStore.load(tmp, "c2", "dist");
		expect(s2.routeKeys()).toEqual([]);
		expect(s2.routeOutputs()).toEqual(["about/index.html", "feed.xml"]);

		// A build that did not persist leaves the marker; dist/ still holds what was recorded.
		await s2.markWriting(["feed.xml"]);
		const marked = await CacheStore.load(tmp, "c1", "dist");
		expect(marked.routeKeys()).toEqual([]);
		expect(marked.routeOutputs()).toEqual(["about/index.html", "feed.xml"]);
	});

	it("markWriting records the outputs a build is about to write, before it persists", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s1.setRouteOutputs(["k.html"]);
		await s1.persist();
		const cacheJson = path.join(tmp, "node_modules", ".pletivo", "cache", "cache.json");
		// Nothing new to write: no JSON write. The trailing newline marks the file as not rewritten.
		const persisted = (await fs.readFile(cacheJson, "utf8")) + "\n";
		await fs.writeFile(cacheJson, persisted);
		const s2 = await CacheStore.load(tmp, "c1", "dist");
		await s2.markWriting(["k.html"]);
		expect(await fs.readFile(cacheJson, "utf8")).toBe(persisted);

		// A new output is on disk before any page is written; the build then crashes.
		const s3 = await CacheStore.load(tmp, "c1", "dist");
		await s3.markWriting(["draft/index.html"]);
		const crashed = await CacheStore.load(tmp, "c1", "dist");
		expect(crashed.routeOutputs()).toEqual(["draft/index.html", "k.html"]);
		expect(crashed.routeKeys()).toEqual([]);

		// A cold build records what it writes too.
		const cold = await CacheStore.forceClean(tmp, "c1", "dist");
		await cold.markWriting(["a.html"]);
		expect((await CacheStore.load(tmp, "c1", "dist")).routeOutputs()).toEqual(["a.html"]);
	});

	it("loads cold, without routes or a record, when there is no record for the output directory", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		expect(s1.routeOutputs()).toBeNull();
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s1.setRouteOutputs(["k.html"]);
		await s1.persist();
		expect((await CacheStore.load(tmp, "c1", "dist")).routeKeys()).toEqual(["k"]);

		const otherDir = await CacheStore.load(tmp, "c1", "build");
		expect(otherDir.routeKeys()).toEqual([]);
		expect(otherDir.routeOutputs()).toBeNull();

		const cleaned = await CacheStore.forceClean(tmp, "c1", "dist");
		expect(cleaned.routeOutputs()).toBeNull();

		// A cache written before the record existed.
		cleaned.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		cleaned.setRouteOutputs(["k.html"]);
		await cleaned.persist();
		const cacheJson = path.join(tmp, "node_modules", ".pletivo", "cache", "cache.json");
		const { routeOutputs, ...withoutRecord } = JSON.parse(await fs.readFile(cacheJson, "utf8"));
		expect(routeOutputs).toEqual({ outDir: "dist", files: ["k.html"] });
		await fs.writeFile(cacheJson, JSON.stringify(withoutRecord));
		const old = await CacheStore.load(tmp, "c1", "dist");
		expect(old.routeKeys()).toEqual([]);
		expect(old.routeOutputs()).toBeNull();
	});

	it("voids a route output record naming a path outside the output directory, and loads cold", async () => {
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setRoute("k", { outPath: "k.html", outputHash: "x", depFingerprints: {}, renderedModules: [], tsxStyles: [], fragments: [], islands: [], hoistedHashes: [], astroIslands: [], cssHead: null, dynamicCss: [], size: 0 });
		s1.setRouteOutputs(["ok.html"]);
		await s1.persist();
		const cacheJson = path.join(tmp, "node_modules", ".pletivo", "cache", "cache.json");
		const valid = JSON.parse(await fs.readFile(cacheJson, "utf8"));
		const loadWith = async (files: string[]) => {
			await fs.writeFile(cacheJson, JSON.stringify({ ...valid, routeOutputs: { outDir: "dist", files } }));
			return await CacheStore.load(tmp, "c1", "dist");
		};
		const ok = await loadWith(["ok.html", "blog/a/index.html"]);
		expect(ok.routeOutputs()).toEqual(["ok.html", "blog/a/index.html"]);
		expect(ok.routeKeys()).toEqual(["k"]);
		for (const bad of ["../src/index.ts", "/etc/passwd", "a/../../b", ".", ""]) {
			const voided = await loadWith(["ok.html", bad]);
			expect(voided.routeOutputs()).toBeNull();
			expect(voided.routeKeys()).toEqual([]);
		}
	});

});

describe("paramsToKey", () => {
	it("treats an undefined, a missing and an empty param as the same param set", () => {
		expect(paramsToKey({ page: undefined })).toBe(paramsToKey({}));
		expect(paramsToKey({ page: "" })).toBe(paramsToKey({}));
		expect(paramsToKey({ lang: "en", page: undefined })).toBe(paramsToKey({ lang: "en" }));
	});

	it("keeps param sets with different values or names apart", () => {
		const keys = [
			paramsToKey({}),
			paramsToKey({ page: "2" }),
			paramsToKey({ page: "3" }),
			paramsToKey({ slug: "2" }),
			paramsToKey({ lang: "en" }),
			paramsToKey({ lang: "en", page: "2" }),
			paramsToKey({ lang: "de", page: "2" }),
			paramsToKey({ page: "a/b" }),
		];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("ignores param order", () => {
		expect(paramsToKey({ lang: "en", page: "2" })).toBe(paramsToKey({ page: "2", lang: "en" }));
	});

	it("matches every cached param set to its fresh getStaticPaths entry after persist / load", async () => {
		const fresh: Array<{ params: Record<string, string | undefined> }> = [
			{ params: { page: undefined } },
			{ params: { page: "2" } },
			{ params: { lang: "en", page: undefined } },
			{ params: { lang: "en", page: "2" } },
			{ params: { slug: "" } },
		];
		const s1 = await CacheStore.load(tmp, "c1", "dist");
		s1.setDynamicRoute("blog/[...page].astro", { paramSets: fresh, depFingerprints: {} });
		s1.setRouteOutputs([]);
		await s1.persist();

		const restored = (await CacheStore.load(tmp, "c1", "dist")).getDynamicRoute("blog/[...page].astro");
		expect(restored?.paramSets.map((p) => paramsToKey(p.params))).toEqual(fresh.map((p) => paramsToKey(p.params)));
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
