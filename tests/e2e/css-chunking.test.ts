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

function runBuild(): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("bun", ["run", cliPath, "build"], {
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
