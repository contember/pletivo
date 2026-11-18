import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

setDefaultTimeout(30_000);

/**
 * CSS chunking — the emitted stylesheet bytes, not just "the build ran".
 *
 * Before grouping, `moduleCssMap` was keyed by importer and joined with
 * no de-duplication, so a stylesheet imported by a layout was written
 * once per page that reached the layout. On a real 211-page site that
 * turned an 86 kB cascade into 23,452,896 B, 96.99% of it 38 redundant
 * copies of one chunk. These tests assert the byte account directly:
 *
 *  - each CSS module's text is emitted exactly once across the whole dist
 *  - a page links only the groups whose page-set contains it
 *  - the Tailwind entry is not also re-emitted raw (which shipped
 *    `@import "tailwindcss"` / `@theme` to the browser, last and
 *    unlayered, outranking the compiled copy)
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliPath = path.resolve(repoRoot, "packages/pletivo/src/cli.ts");

const SHARED_RULES = 400;
const PAGE_COUNT = 10;

let projectRoot = "";

beforeEach(async () => {
	projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-css-chunk-"));
});

afterEach(async () => {
	await fs.rm(projectRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(projectRoot, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

function runBuild(...args: string[]): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("bun", ["run", cliPath, "build", ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "production" },
	});
	return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

const STYLESHEET_RE = /\/assets\/styles\.(?:[a-z0-9-]+\.)?[a-f0-9]{8}\.css/g;

async function stylesheetsOf(pageRel: string): Promise<string[]> {
	const html = await fs.readFile(path.join(projectRoot, "dist", pageRel), "utf8");
	return [...html.matchAll(STYLESHEET_RE)].map((m) => m[0]);
}

async function emittedStylesheets(): Promise<Map<string, string>> {
	const dir = path.join(projectRoot, "dist", "assets");
	const out = new Map<string, string>();
	for (const name of await fs.readdir(dir)) {
		if (!name.endsWith(".css")) continue;
		out.set(`/assets/${name}`, await fs.readFile(path.join(dir, name), "utf8"));
	}
	return out;
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/**
 * A layout imported by PAGE_COUNT pages, plus one page that imports a
 * stylesheet of its own. `vendor/` sits outside src/ so the CSS reaches
 * the build only through the JS import scan — the path that duplicated.
 */
async function setupSharedLayout(): Promise<number> {
	const shared = Array.from(
		{ length: SHARED_RULES },
		(_, i) => `.shared-rule-${i} { padding-top: ${i}px; }`,
	).join("\n");
	await write("vendor/shared.css", `.shared-marker { color: rgb(1, 2, 3); }\n${shared}\n`);
	await write("vendor/solo.css", `.solo-marker { color: rgb(9, 8, 7); }\n`);

	await write(
		"src/layouts/Base.astro",
		`---\nimport "../../vendor/shared.css";\n---\n<html><head><title>Base</title></head><body><slot /></body></html>\n`,
	);
	for (let i = 0; i < PAGE_COUNT; i++) {
		await write(
			`src/pages/p${i}.astro`,
			`---\nimport Base from "../layouts/Base.astro";\n---\n<Base><h1>Page ${i}</h1></Base>\n`,
		);
	}
	await write(
		"src/pages/solo.astro",
		`---\nimport "../../vendor/solo.css";\n---\n<html><head><title>Solo</title></head><body><h1>Solo</h1></body></html>\n`,
	);

	return (await fs.stat(path.join(projectRoot, "vendor/shared.css"))).size;
}

describe("CSS chunking — no per-importer duplication", () => {
	it("emits a shared stylesheet's text once, however many pages import it", async () => {
		const sharedBytes = await setupSharedLayout();

		const result = runBuild();
		expect(result.status).toBe(0);

		const sheets = await emittedStylesheets();
		const totalBytes = [...sheets.values()].reduce(
			(sum, css) => sum + Buffer.byteLength(css, "utf8"),
			0,
		);
		const allCss = [...sheets.values()].join("\n");

		// The marker rule, and every rule in the file, must appear once.
		// Selectors are matched with their opening brace — the emitted CSS
		// is minified, so there is no whitespace to anchor on.
		expect(occurrences(allCss, ".shared-marker")).toBe(1);
		expect(occurrences(allCss, ".shared-rule-0{")).toBe(1);
		expect(occurrences(allCss, `.shared-rule-${SHARED_RULES - 1}{`)).toBe(1);
		expect(occurrences(allCss, ".solo-marker")).toBe(1);

		// Byte account: one copy of shared.css plus slack for solo.css and
		// scaffolding. Duplicating per importer costs PAGE_COUNT copies.
		expect(totalBytes).toBeLessThan(sharedBytes * 2);
	});

	it("links each page only to the groups whose page set contains it", async () => {
		await setupSharedLayout();

		const result = runBuild();
		expect(result.status).toBe(0);

		const sheets = await emittedStylesheets();
		const sharedHref = [...sheets].find(([, css]) => css.includes(".shared-marker"))?.[0];
		const soloHref = [...sheets].find(([, css]) => css.includes(".solo-marker"))?.[0];
		if (!sharedHref || !soloHref) throw new Error("Expected shared and page-specific stylesheets");
		expect(sharedHref).not.toBe(soloHref);

		for (let i = 0; i < PAGE_COUNT; i++) {
			const links = await stylesheetsOf(`p${i}/index.html`);
			expect(links).toContain(sharedHref);
			expect(links).not.toContain(soloHref);
		}

		const soloLinks = await stylesheetsOf("solo/index.html");
		expect(soloLinks).toContain(soloHref);
		expect(soloLinks).not.toContain(sharedHref);
	});
});

/**
 * Assets referenced from CSS. Bun inlines every `url()` target up to
 * 131,071 B as base64 and has no flag to stop it, so a webfont used to
 * ship inside the stylesheet at +33.5% base64 overhead — and unusable
 * under a `font-src 'self'` CSP, which does not cover `data:`.
 */
const ASSET_INLINE_LIMIT = 4096;

/** Deterministic incompressible bytes — a realistic font stand-in. */
function fakeFont(n: number, seed: number): Buffer {
	const buf = Buffer.alloc(n);
	let x = seed;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		buf[i] = x & 0xff;
	}
	return buf;
}

/** `fonts.css` with one `@font-face` per entry, imported by one page. */
async function setupFontProject(fonts: Array<{ name: string; bytes: number }>): Promise<void> {
	await fs.mkdir(path.join(projectRoot, "vendor/files"), { recursive: true });
	let css = "";
	for (const [i, font] of fonts.entries()) {
		await fs.writeFile(path.join(projectRoot, "vendor/files", font.name), fakeFont(font.bytes, i + 1));
		css +=
			`@font-face {\n` +
			`  font-family: "Probe${i}";\n` +
			`  src: url(./files/${font.name});\n` +
			`}\n`;
	}
	await write("vendor/fonts.css", css);
	await write(
		"src/pages/index.astro",
		`---\nimport "../../vendor/fonts.css";\n---\n<html><head><title>Fonts</title></head><body><h1>Fonts</h1></body></html>\n`,
	);
}

describe("CSS chunking — assets referenced from CSS", () => {
	it("emits a webfont as a hashed file instead of a base64 data: URI", async () => {
		const fontBytes = 40_000;
		await setupFontProject([{ name: "big-font.woff2", bytes: fontBytes }]);

		const result = runBuild();
		expect(result.status).toBe(0);

		const sheets = await emittedStylesheets();
		const allCss = [...sheets.values()].join("\n");

		// The regression this locks: a base64 font in the stylesheet.
		expect(allCss).not.toContain("data:font");
		expect(allCss).not.toContain("base64");

		// The font is a file, content-hashed, and the URL resolves.
		const href = allCss.match(/url\(["']?(\/assets\/big-font\.[a-f0-9]{8}\.woff2)["']?\)/);
		expect(href).not.toBeNull();
		const onDisk = path.join(projectRoot, "dist", href![1].replace(/^\//, ""));
		const written = await fs.readFile(onDisk);
		const source = await fs.readFile(path.join(projectRoot, "vendor/files/big-font.woff2"));
		expect(written.byteLength).toBe(fontBytes);
		expect(written.equals(source)).toBe(true);

		// A stylesheet carrying the font inline would be at least 4/3 of it.
		const totalCssBytes = [...sheets.values()].reduce(
			(sum, css) => sum + Buffer.byteLength(css, "utf8"),
			0,
		);
		expect(totalCssBytes).toBeLessThan(fontBytes);
	});

	it("keeps assets below the 4096-byte inline limit as data: URIs", async () => {
		await setupFontProject([
			{ name: "big-font.woff2", bytes: ASSET_INLINE_LIMIT },
			{ name: "small-font.woff", bytes: ASSET_INLINE_LIMIT - 1 },
		]);

		const result = runBuild();
		expect(result.status).toBe(0);

		const allCss = [...(await emittedStylesheets()).values()].join("\n");
		// Vite's `build.assetsInlineLimit` default, which Astro never
		// overrides: inline strictly below it, a file at or above it.
		expect(allCss).toContain("data:font/woff;base64,");
		expect(allCss).toMatch(/url\(["']?\/assets\/big-font\.[a-f0-9]{8}\.woff2["']?\)/);
		const assets = await fs.readdir(path.join(projectRoot, "dist", "assets"));
		expect(assets.some((f) => f.startsWith("small-font."))).toBe(false);
	});
});

describe("CSS chunking — the emitted stylesheet is minified", () => {
	it("strips whitespace and shortens values", async () => {
		await write("vendor/minify.css", `.minify-marker {\n  color: rgb(255, 0, 0);\n  margin: 0px 0px 0px 0px;\n}\n`);
		await write(
			"src/pages/index.astro",
			`---\nimport "../../vendor/minify.css";\n---\n<html><head><title>Min</title></head><body><h1>Min</h1></body></html>\n`,
		);

		const result = runBuild();
		expect(result.status).toBe(0);

		const allCss = [...(await emittedStylesheets()).values()].join("\n");
		expect(allCss).toContain(".minify-marker{color:red;margin:0}");
	});
});

describe("CSS chunking — the Tailwind entry ships once", () => {
	it("does not re-emit the Tailwind entry raw alongside its compiled output", async () => {
		await write("node_modules/@tailwindcss/node/package.json", `{"type":"module","main":"index.js"}`);
		await write("node_modules/@tailwindcss/node/index.js", `
			export async function compile() {
				return {
					root: "none",
					sources: [],
					build() {
						return "@layer base { .fake-tailwind-output { color: black; } }";
					},
				};
			}
		`);
		await write("node_modules/@tailwindcss/oxide/package.json", `{"type":"module","main":"index.js"}`);
		await write("node_modules/@tailwindcss/oxide/index.js", `
			export class Scanner {
				scan() {
					return [];
				}
			}
		`);
		await write(
			"src/styles/global.css",
			`@import "tailwindcss";\n@theme { --pletivo-probe: 1px; }\n.raw-entry-marker { color: red; }\n`,
		);
		await write(
			"src/pages/index.astro",
			`---\nimport "../styles/global.css";\n---\n<html><head><title>TW</title></head><body><h1 class="fake-tailwind-output">TW</h1></body></html>\n`,
		);

		const result = runBuild();
		expect(result.status).toBe(0);

		const allCss = [...(await emittedStylesheets()).values()].join("\n");
		expect(allCss).toContain(".fake-tailwind-output");
		// The raw copy is emitted last and unlayered, so it outranks the
		// compiled one — and browsers cannot use these at-rules anyway.
		expect(allCss).not.toContain(`@import "tailwindcss"`);
		expect(allCss).not.toContain("@theme");
		expect(occurrences(allCss, ".raw-entry-marker")).toBe(0);
	});
});

/**
 * `Astro.rewrite` writes the target's HTML at the rewriting page's path, so
 * the output has to link the target's CSS groups. Linking the rewriting
 * page's own groups ships the target's markup with none of its stylesheets.
 */
async function setupRewrite(): Promise<void> {
	await write("vendor/target.css", `.target-marker { color: rgb(9, 8, 7); }\n`);
	await write("vendor/other.css", `.other-marker { color: rgb(1, 2, 3); }\n`);
	await write(
		"src/pages/target.astro",
		`---\nimport "../../vendor/target.css";\n---\n<html><head><title>Target</title></head><body><h1 class="target-marker">Target</h1></body></html>\n`,
	);
	await write("src/pages/rewritten.astro", `---\nreturn Astro.rewrite("/target");\n---\n`);
	await write(
		"src/pages/other.astro",
		`---\nimport "../../vendor/other.css";\n---\n<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`,
	);
}

describe("CSS chunking: a rewritten page links the target's CSS", () => {
	async function expectTargetSheets(): Promise<void> {
		const sheets = await emittedStylesheets();
		const targetHref = [...sheets].find(([, css]) => css.includes(".target-marker"))?.[0];
		const otherHref = [...sheets].find(([, css]) => css.includes(".other-marker"))?.[0];
		if (!targetHref || !otherHref) throw new Error("Expected a stylesheet per page group");
		const links = await stylesheetsOf("rewritten/index.html");
		expect(links).toContain(targetHref);
		expect(links).not.toContain(otherHref);
		expect(links).toEqual(await stylesheetsOf("target/index.html"));
	}

	it("in a full build", async () => {
		await setupRewrite();
		const result = runBuild();
		expect(result.status).toBe(0);
		await expectTargetSheets();
	});

	it("when the rewriting page is restored from the incremental cache", async () => {
		await setupRewrite();
		expect(runBuild("--incremental").status).toBe(0);
		const warm = runBuild("--incremental");
		expect(warm.status).toBe(0);
		expect(warm.stdout).toContain("0 rendered");
		await expectTargetSheets();
	});
});

/**
 * A page whose render imports a component dynamically: the component's CSS
 * reaches the build only when that import runs, and a page restored from the
 * incremental cache does not render. Its cache entry must keep that CSS.
 */
const DYNAMIC_LAYOUTS = [
	{ name: "a loader outside src/", loader: "vendor/load.js", component: "vendor/Dyn.astro", css: "vendor/dyn.css" },
	{ name: "a loader and component inside src/", loader: "src/lib/load.ts", component: "src/components/Dyn.astro", css: "vendor/dyn.css" },
];

async function setupDynamicImport(layout: (typeof DYNAMIC_LAYOUTS)[number]): Promise<void> {
	const rel = (from: string, to: string) => {
		const out = path.relative(path.dirname(from), to);
		return out.startsWith(".") ? out : `./${out}`;
	};
	await write(layout.css, `@import "./dyn-inner.css";\n.dyn-marker { color: rgb(4, 5, 6); }\n`);
	await write(path.join(path.dirname(layout.css), "dyn-inner.css"), `.dyn-inner-marker { color: rgb(7, 8, 9); }\n`);
	await write(layout.component, `---\nimport "${rel(layout.component, layout.css)}";\n---\n<p>dyn</p>\n`);
	await write(
		layout.loader,
		`export async function load() {\n\tawait import("${rel(layout.loader, layout.component)}");\n\treturn "loaded";\n}\n`,
	);
	await write("vendor/static.css", `.static-marker { color: rgb(1, 1, 1); }\n`);
	await write(
		"src/pages/index.astro",
		`---\nimport "../../vendor/static.css";\nimport { load } from "${rel("src/pages/index.astro", layout.loader)}";\nconst v = await load();\n---\n<html><head><title>Dyn</title></head><body><h1 class="dyn-marker">{v}</h1></body></html>\n`,
	);
	await write("src/pages/other.astro", `<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`);
}

/** The stylesheets in the graph modules each page's cache entry kept, as project-relative paths. */
async function cachedDynamicCss(): Promise<Record<string, string[]>> {
	const raw = await fs.readFile(path.join(projectRoot, "node_modules/.pletivo/cache/cache.json"), "utf8");
	const cache: {
		routes: Record<string, { dynamicModules: string[] }>;
		dynamicNodes: Record<string, Array<{ type: string; file: string }>>;
	} = JSON.parse(raw);
	const out: Record<string, string[]> = {};
	for (const [key, entry] of Object.entries(cache.routes)) {
		out[key] = entry.dynamicModules.flatMap((module) =>
			(cache.dynamicNodes[module] ?? []).filter((item) => item.type === "css").map((item) => path.relative(projectRoot, item.file)),
		);
	}
	return out;
}

/** The CSS each page links, by page: what a browser applies, whatever the chunking. */
async function linkedCss(pages = ["index.html", "other/index.html"]): Promise<Record<string, string>> {
	const sheets = await emittedStylesheets();
	const out: Record<string, string> = {};
	for (const page of pages) {
		out[page] = (await stylesheetsOf(page)).map((href) => sheets.get(href) ?? `missing ${href}`).join("\n");
	}
	return out;
}

/** A full build of the same sources, which the warm build must equal. */
async function fullBuildCss(pages?: string[]): Promise<Record<string, string>> {
	expect(runBuild().status).toBe(0);
	return await linkedCss(pages);
}

/** A cold `--incremental` build, then a no-change one that must restore every page and equal a full build. */
async function expectWarmEqualsFull(pages: string[]): Promise<void> {
	expect(runBuild("--incremental").status).toBe(0);
	const warm = runBuild("--incremental");
	expect(warm.status).toBe(0);
	expect(warm.stdout).toContain(`0 rendered + ${pages.length} cached`);
	const css = await linkedCss(pages);
	expect(css).toEqual(await fullBuildCss(pages));
}

describe("CSS chunking: a cached page keeps CSS its render imported dynamically", () => {
	for (const layout of DYNAMIC_LAYOUTS) {
		it(`on a no-change warm build, with ${layout.name}`, async () => {
			await setupDynamicImport(layout);
			expect(runBuild("--incremental").status).toBe(0);
			const warm = runBuild("--incremental");
			expect(warm.status).toBe(0);
			expect(warm.stdout).toContain("0 rendered + 2 cached");

			const css = await linkedCss();
			expect(css["index.html"]).toContain(".dyn-marker{");
			expect(css["index.html"]).toContain(".dyn-inner-marker{");
			expect(css["index.html"]).toContain(".static-marker{");
			// The statically imported sheet loads with the page module on every build: not kept.
			expect(await cachedDynamicCss()).toEqual({
				"index.astro::__static__": [layout.css],
				"other.astro::__static__": [],
			});
			expect(css).toEqual(await fullBuildCss());
		});
	}

	it("picks up a changed stylesheet, whether the page renders again or stays cached", async () => {
		const layout = DYNAMIC_LAYOUTS[0];
		await setupDynamicImport(layout);
		expect(runBuild("--incremental").status).toBe(0);

		// The component's own stylesheet is a dependency of the page: the page renders again.
		await write(layout.css, `@import "./dyn-inner.css";\n.dyn-marker-v2 { color: rgb(4, 5, 6); }\n`);
		const changed = runBuild("--incremental");
		expect(changed.status).toBe(0);
		expect(changed.stdout).toContain("1 rendered + 1 cached");
		let css = await linkedCss();
		expect(css["index.html"]).toContain(".dyn-marker-v2{");
		expect(css["index.html"]).not.toContain(".dyn-marker{");

		// A stylesheet it `@import`s is not: the page stays cached and its CSS is bundled fresh.
		await write("vendor/dyn-inner.css", `.dyn-inner-marker-v2 { color: rgb(7, 8, 9); }\n`);
		const cached = runBuild("--incremental");
		expect(cached.status).toBe(0);
		expect(cached.stdout).toContain("0 rendered + 2 cached");
		css = await linkedCss();
		expect(css["index.html"]).toContain(".dyn-inner-marker-v2{");
		expect(css["index.html"]).not.toContain(".dyn-inner-marker{");
		expect(css).toEqual(await fullBuildCss());
	});
});

/**
 * The CSS graph follows `import()` with a string specifier as it follows a static import,
 * so a full build attributes that CSS to the page that reaches it.
 */
describe("CSS chunking: CSS reached through a dynamic import", () => {
	it("ships a stylesheet a module outside src/ imports dynamically, in the page's group", async () => {
		await write("vendor/x.css", `.x-marker { color: rgb(1, 2, 3); }\n`);
		await write("vendor/mod.css", `.mod-marker { color: rgb(3, 2, 1); }\n`);
		await write("vendor/mod.js", `import "./mod.css";\nexport const mod = "mod";\n`);
		await write(
			"vendor/x.js",
			`export async function load() {\n\tawait import("./x.css");\n\treturn (await import("./mod.js")).mod;\n}\n`,
		);
		await write(
			"src/pages/index.astro",
			`---\nimport { load } from "../../vendor/x.js";\nconst v = await load();\n---\n<html><head><title>X</title></head><body><h1>{v}</h1></body></html>\n`,
		);
		await write("src/pages/other.astro", `<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`);

		expect(runBuild().status).toBe(0);
		const css = await linkedCss();
		expect(css["index.html"]).toContain(".x-marker{");
		expect(css["index.html"]).toContain(".mod-marker{");
		expect(css["other/index.html"]).toBe("");

		await expectWarmEqualsFull(["index.html", "other/index.html"]);
	});

	it("links a component's CSS on a page that imports it dynamically when another imports it statically", async () => {
		await write("vendor/c.css", `.c-marker { color: rgb(3, 2, 1); }\n`);
		await write("src/components/C.astro", `---\nimport "../../vendor/c.css";\n---\n<p class="c-marker">c</p>\n`);
		await write(
			"src/pages/dynamic.astro",
			`---\nconst { default: C } = await import("../components/C.astro");\n---\n<html><head><title>D</title></head><body><C /></body></html>\n`,
		);
		await write(
			"src/pages/static.astro",
			`---\nimport C from "../components/C.astro";\n---\n<html><head><title>S</title></head><body><C /></body></html>\n`,
		);
		await write("src/pages/other.astro", `<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`);
		const pages = ["dynamic/index.html", "static/index.html", "other/index.html"];

		expect(runBuild().status).toBe(0);
		const css = await linkedCss(pages);
		expect(css["dynamic/index.html"]).toContain(".c-marker{");
		expect(css["static/index.html"]).toBe(css["dynamic/index.html"]);
		expect(css["other/index.html"]).toBe("");

		await expectWarmEqualsFull(pages);
	});

	it("equals a full build when a rendered page imports a module statically and a cached one through import()", async () => {
		await write("vendor/c.css", `.c-marker { color: rgb(3, 2, 1); }\n`);
		await write("vendor/inner.css", `.inner-marker { color: rgb(5, 5, 5); }\n`);
		await write("src/components/Inner.astro", `---\nimport "../../vendor/inner.css";\n---\n<p class="inner-marker">inner</p>\n`);
		await write("src/components/C.astro", `---\nimport "../../vendor/c.css";\nimport Inner from "./Inner.astro";\n---\n<p class="c-marker">c</p><Inner />\n`);
		await write(
			"src/pages/dynamic.astro",
			`---\nconst { default: C } = await import("../components/C.astro");\n---\n<html><head><title>D</title></head><body><C /></body></html>\n`,
		);
		const staticPage = (text: string) =>
			`---\nimport C from "../components/C.astro";\n---\n<html><head><title>S</title></head><body><h1>${text}</h1><C /></body></html>\n`;
		await write("src/pages/static.astro", staticPage("v1"));
		await write("src/pages/other.astro", `<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`);
		const pages = ["dynamic/index.html", "static/index.html", "other/index.html"];
		const html = async (): Promise<string[]> =>
			await Promise.all(pages.map((page) => fs.readFile(path.join(projectRoot, "dist", page), "utf8")));

		expect(runBuild("--incremental").status).toBe(0);
		await write("src/pages/static.astro", staticPage("v2"));
		const warm = runBuild("--incremental");
		expect(warm.status).toBe(0);
		expect(warm.stdout).toContain("1 rendered + 2 cached");
		const warmCss = await linkedCss(pages);
		const warmHtml = await html();
		expect(warmCss["dynamic/index.html"]).toContain(".inner-marker{");
		expect(warmHtml[1]).toContain("v2");

		expect(warmCss).toEqual(await fullBuildCss(pages));
		expect(warmHtml).toEqual(await html());
	});

	it("keeps a cached page's import order when its dynamic import sits between static ones", async () => {
		// Conflicting rules: the order decides which colour wins. Inner.astro is reached only
		// through Dyn.astro, which a cached page does not load.
		// The minifier may drop overridden `.t` rules, so each file also carries a marker the order is read from.
		await write("vendor/a.css", `.t { color: rgb(1, 0, 0); }\n.a-marker { order: 1; }\n`);
		await write("vendor/dyn.css", `.t { color: rgb(0, 2, 0); }\n.dyn-marker { order: 2; }\n`);
		await write("vendor/z.css", `.t { color: rgb(0, 0, 3); }\n.z-marker { order: 3; }\n`);
		await write("vendor/Inner.astro", `---\nimport "./dyn.css";\n---\n<p>inner</p>\n`);
		await write("vendor/Dyn.astro", `---\nimport Inner from "./Inner.astro";\n---\n<Inner />\n`);
		await write("vendor/load.js", `export async function load() {\n\treturn (await import("./Dyn.astro")).default;\n}\n`);
		await write(
			"src/pages/index.astro",
			`---\nimport "../../vendor/a.css";\nimport { load } from "../../vendor/load.js";\nimport "../../vendor/z.css";\nconst D = await load();\n---\n<html><head><title>I</title></head><body><D /></body></html>\n`,
		);
		await write("src/pages/other.astro", `<html><head><title>Other</title></head><body><h1>Other</h1></body></html>\n`);

		expect(runBuild().status).toBe(0);
		const css = await linkedCss();
		const sheet = css["index.html"];
		expect(sheet.match(/\.(?:a|dyn|z)-marker\{/g)).toEqual([".a-marker{", ".dyn-marker{", ".z-marker{"]);
		expect(sheet.match(/\.t\{color:#[0-9a-f]{6}\}/g)?.at(-1)).toBe(".t{color:#000003}");

		await expectWarmEqualsFull(["index.html", "other/index.html"]);
	});
});

/**
 * Without a Tailwind entry every `src/**\/*.css` ships in the shared sheet. Astro emits
 * the imported ones in import-graph order, depth-first post-order from the page module;
 * the expected orders below are what Astro 5.16 emits for the same sources.
 */
describe("CSS chunking: source CSS without Tailwind follows the import graph", () => {
	async function sheetOf(page: string): Promise<string> {
		return (await linkedCss([page]))[page].trim();
	}

	async function setupNested(): Promise<void> {
		await write(
			"src/pages/index.astro",
			`---\nimport A from "../components/A.astro";\nimport "../styles/mid.css";\nimport { lib } from "../components/lib.js";\nimport "../styles/shared.css";\n---\n<html><head><title>order</title></head><body><A />{lib}</body></html>\n`,
		);
		await write(
			"src/components/A.astro",
			`---\nimport "../styles/a.css";\nimport B from "./B.astro";\nimport "../styles/a2.css";\n---\n<div class="a"><B /></div>\n`,
		);
		await write("src/components/B.astro", `---\nimport "../styles/b.css";\n---\n<p class="b">b</p>\n`);
		await write("src/components/lib.js", `import "../styles/l.css";\nimport { label } from "./J.jsx";\nexport const lib = label;\n`);
		await write("src/components/J.jsx", `import "../styles/j.css";\nimport "../styles/shared.css";\nexport const label = "j";\n`);
		const zIndex = { a: 1, b: 2, a2: 3, mid: 4, l: 5, j: 6, shared: 7 };
		for (const [name, z] of Object.entries(zIndex)) await write(`src/styles/${name}.css`, `.${name} { z-index: ${z}; }\n`);
	}

	it("puts a page's own import before the CSS of a component it imports next", async () => {
		await write("src/pages/index.astro", `---\nimport "../styles/z.css";\nimport C from "../components/C.astro";\n---\n<html><head><title>za</title></head><body><C /></body></html>\n`);
		await write("src/components/C.astro", `---\nimport "../styles/a.css";\n---\n<p class="a">c</p>\n`);
		await write("src/styles/z.css", `.z { z-index: 1; }\n`);
		await write("src/styles/a.css", `.a { z-index: 2; }\n`);
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(".z{z-index:1}.a{z-index:2}");
	});

	it("follows nested imports, a stylesheet between module imports, one reached twice, and .js/.jsx importers", async () => {
		await setupNested();
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(
			".a{z-index:1}.b{z-index:2}.a2{z-index:3}.mid{z-index:4}.l{z-index:5}.j{z-index:6}.shared{z-index:7}",
		);
	});

	it("still ships a stylesheet no page imports, ahead of the imported ones", async () => {
		await write("src/pages/index.astro", `---\nimport "../styles/z.css";\nimport "../styles/a.css";\n---\n<html><head><title>u</title></head><body>u</body></html>\n`);
		await write("src/styles/z.css", `.z { z-index: 1; }\n`);
		await write("src/styles/a.css", `.a { z-index: 2; }\n`);
		await write("src/styles/m.css", `.m { z-index: 3; }\n`);
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(".m{z-index:3}.z{z-index:1}.a{z-index:2}");
	});

	it("keeps the order on a warm incremental build, with a restored dynamic route walked first", async () => {
		await setupNested();
		// `blog/[slug].astro` sorts before `index.astro`, so its CSS leads the merged walk.
		await write(
			"src/pages/blog/[slug].astro",
			`---\nimport "../../styles/post.css";\nimport B from "../../components/B.astro";\nexport function getStaticPaths() {\n\treturn [{ params: { slug: "one" } }];\n}\n---\n<html><head><title>post</title></head><body><B /></body></html>\n`,
		);
		await write("src/styles/post.css", `.post { z-index: 8; }\n`);
		const pages = ["index.html", "blog/one/index.html"];
		// Both pages keep their own order: `.b` waits for `.a`, which index reaches before it.
		const expected = ".post{z-index:8}.a{z-index:1}.b{z-index:2}.a2{z-index:3}.mid{z-index:4}.l{z-index:5}.j{z-index:6}.shared{z-index:7}";

		await expectWarmEqualsFull(pages);
		expect(await sheetOf("index.html")).toBe(expected);
		expect(await sheetOf("blog/one/index.html")).toBe(expected);
	});

	it("keeps a page's order when an earlier page reaches only part of it", async () => {
		// `about` sorts first and reaches `components` alone; index still gets `base` first.
		await write("src/pages/about.astro", `---\nimport "../styles/components.css";\n---\n<html><head><title>a</title></head><body>a</body></html>\n`);
		await write("src/pages/index.astro", `---\nimport "../styles/base.css";\nimport "../styles/components.css";\n---\n<html><head><title>i</title></head><body>i</body></html>\n`);
		await write("src/styles/components.css", `.components { z-index: 1; }\n`);
		await write("src/styles/base.css", `.base { z-index: 2; }\n`);
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(".base{z-index:2}.components{z-index:1}");
		expect(await sheetOf("about/index.html")).toBe(".base{z-index:2}.components{z-index:1}");
	});

	it("falls back to first-seen order for stylesheets two pages order differently", async () => {
		// index: y c. post: z c y. One shared sheet cannot give both; y and c keep index's order, which saw them first.
		await write("src/pages/index.astro", `---\nimport "../styles/y.css";\nimport "../styles/c.css";\n---\n<html><head><title>i</title></head><body>i</body></html>\n`);
		await write(
			"src/pages/post.astro",
			`---\nimport "../styles/z.css";\nimport C from "../components/C.astro";\nimport "../styles/y.css";\n---\n<html><head><title>p</title></head><body><C /></body></html>\n`,
		);
		await write("src/components/C.astro", `---\nimport "../styles/c.css";\n---\n<p class="c">c</p>\n`);
		await write("src/styles/z.css", `.z { z-index: 1; }\n`);
		await write("src/styles/c.css", `.c { z-index: 2; }\n`);
		await write("src/styles/y.css", `.y { z-index: 3; }\n`);
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(".z{z-index:1}.y{z-index:3}.c{z-index:2}");
	});

	it("emits a stylesheet's `@import`ed source files depth-first just before it", async () => {
		await write("src/pages/index.astro", `---\nimport "../styles/x.css";\nimport "../styles/g.css";\n---\n<html><head><title>i</title></head><body>i</body></html>\n`);
		await write("src/styles/x.css", `.x { z-index: 1; }\n`);
		await write("src/styles/g.css", `@import "./v.css";\n@import "./r.css";\n.g { z-index: 4; }\n`);
		await write("src/styles/v.css", `.v { z-index: 2; }\n`);
		await write("src/styles/r.css", `.r { z-index: 3; }\n`);
		expect(runBuild().status).toBe(0);
		expect(await sheetOf("index.html")).toBe(".x{z-index:1}.v{z-index:2}.r{z-index:3}.g{z-index:4}");
	});

	it("inlines an `@import`ed reset before its importer instead of shipping an invalid `@import`", async () => {
		await write("src/pages/index.astro", `---\nimport "../styles/global.css";\n---\n<html><head><title>i</title></head><body>i</body></html>\n`);
		await write("src/styles/global.css", `@import "./reset.css";\n.g { z-index: 1; }\n`);
		await write("src/styles/reset.css", `.r { z-index: 2; }\n`);
		const result = runBuild();
		expect(result.status).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("CSS minification failed");
		expect(await sheetOf("index.html")).toBe(".r{z-index:2}.g{z-index:1}");
	});

	it("keeps a URL `@import` at the top of the sheet, ahead of a stylesheet no page imports", async () => {
		await write("src/pages/index.astro", `---\nimport "../styles/global.css";\n---\n<html><head><title>i</title></head><body>i</body></html>\n`);
		await write("src/styles/global.css", `@import url("https://fonts.googleapis.com/css2?family=Inter");\nbody { font-family: Inter; }\n`);
		await write("src/styles/legacy.css", `.legacy { z-index: 2; }\n`);
		const result = runBuild();
		expect(result.status).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("CSS minification failed");
		expect(await sheetOf("index.html")).toBe(
			`@import "https://fonts.googleapis.com/css2?family=Inter";.legacy{z-index:2}body{font-family:Inter}`,
		);
	});
});
