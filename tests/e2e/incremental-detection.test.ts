import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test spawns one or two full `pletivo build` subprocesses. Under CI
// CPU contention (many e2e specs running in parallel) two cold builds can
// blow past the 5s default, so give these spawn-heavy tests generous room.
setDefaultTimeout(30_000);

/**
 * E2E coverage for change-detection edge cases the original
 * incremental implementation got wrong. Each test exercises a real
 * `pletivo build` subprocess so Bun's per-process module cache doesn't
 * mask edit→rebuild loops.
 *
 * Patterns:
 *  - `#1` getCollection deps must follow every reader, not just the
 *    first one to populate `collectionCache`.
 *  - `#2` Adding a brand-new file to a collection has to invalidate
 *    routes that materialize the collection (the glob's listing must
 *    be a tracked dep, not just the per-file fingerprints).
 *  - `#3` Editing a component imported inside an .mdx body must
 *    invalidate slugs that render that MDX entry.
 *  - `#5` Editing CSS that changes the bundle's content hash must
 *    force cached HTML pages to be re-emitted with the new <link>.
 *  - `#6` Edits to tsconfig.json or relevant package.json fields must
 *    bust the entire route cache via configHash.
 *  - `#7` CSS imported by Astro hoisted scripts must participate in
 *    incremental invalidation and cached-page stylesheet relinking.
 *  - `#8` Tailwind-mode builds must still include CSS side-effect imports
 *    from JS when those CSS files live under src/.
 *  - `#9` CSS side-effect imports from non-.astro page modules (.tsx/.ts)
 *    must land in the bundle without duplicating src CSS.
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliPath = path.resolve(repoRoot, "packages/pletivo/src/cli.ts");
const collectionAbs = path.resolve(repoRoot, "packages/pletivo/src/content/collection");

let projectRoot = "";

beforeEach(async () => {
	projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-detect-"));
});

afterEach(async () => {
	await fs.rm(projectRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(projectRoot, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

function runBuild(args: string[] = []): { stdout: string; stderr: string; status: number } {
	// Incremental is opt-in; these tests exercise the cache flow, so pass it always.
	const result = spawnSync("bun", ["run", cliPath, "build", "--incremental", ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "production" },
	});
	return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

async function readCssBundleFor(pageRel: string): Promise<{ href: string; css: string }> {
	const html = await fs.readFile(path.join(projectRoot, "dist", pageRel), "utf8");
	const href = /\/assets\/styles\.[a-f0-9]+\.css/.exec(html)?.[0];
	expect(href).toBeDefined();
	if (!href) throw new Error(`Missing CSS bundle link in ${pageRel}`);
	const css = await fs.readFile(path.join(projectRoot, "dist", href.replace(/^\//, "")), "utf8");
	return { href, css };
}

async function setupSharedCollection(): Promise<void> {
	// Two static pages that both call getCollection("posts"). Without
	// the fix, only one of them captures the .md files as deps — the
	// other serves stale HTML when a post is edited.
	await write("src/content.config.ts", `
		import { defineCollection, glob, z } from "${collectionAbs}";
		export const collections = {
			posts: defineCollection({
				loader: glob({ base: "src/content/posts", pattern: "*.md" }),
				schema: z.object({ title: z.string() }),
			}),
		};
	`);
	await write("src/content/posts/hello.md", `---\ntitle: Hello v1\n---\nHello body.`);
	await write("src/content/posts/world.md", `---\ntitle: World v1\n---\nWorld body.`);
	await write("src/pages/index.ts", `
		import { getCollection, initCollections } from "${collectionAbs}";
		export default async function Home() {
			await initCollections(process.cwd());
			const posts = await getCollection("posts");
			const list = posts.map((p) => '<li>' + p.data.title + '</li>').join("");
			return { __html: '<!DOCTYPE html><html><head><title>Home</title></head><body><ul id="home">' + list + '</ul></body></html>' };
		}
	`);
	await write("src/pages/archive.ts", `
		import { getCollection, initCollections } from "${collectionAbs}";
		export default async function Archive() {
			await initCollections(process.cwd());
			const posts = await getCollection("posts");
			const list = posts.map((p) => '<li>' + p.data.title + '</li>').join("");
			return { __html: '<!DOCTYPE html><html><head><title>Archive</title></head><body><ul id="archive">' + list + '</ul></body></html>' };
		}
	`);
}

describe("incremental detection #1 — getCollection deps follow every reader", () => {
	it("editing a collection entry invalidates ALL pages that read the collection", async () => {
		await setupSharedCollection();
		const first = runBuild();
		expect(first.status).toBe(0);

		// Bump one post — both index and archive list its title, so
		// both pages MUST re-render to reflect the new value.
		await write("src/content/posts/hello.md", `---\ntitle: Hello v2\n---\nHello body.`);

		const second = runBuild();
		expect(second.status).toBe(0);

		const indexHtml = await fs.readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
		const archiveHtml = await fs.readFile(path.join(projectRoot, "dist", "archive", "index.html"), "utf8");
		expect(indexHtml).toContain("Hello v2");
		expect(archiveHtml).toContain("Hello v2");
	});
});

describe("incremental detection #2 — adding a new collection entry", () => {
	it("dynamic route picks up a brand-new .md file added between builds", async () => {
		await write("src/content.config.ts", `
			import { defineCollection, glob, z } from "${collectionAbs}";
			export const collections = {
				posts: defineCollection({
					loader: glob({ base: "src/content/posts", pattern: "*.md" }),
					schema: z.object({ title: z.string() }),
				}),
			};
		`);
		await write("src/content/posts/first.md", `---\ntitle: First\n---\nFirst body.`);
		// Dynamic route over the collection. We avoid .astro so this
		// fixture doesn't need the astro compiler at build time.
		await write("src/pages/posts/[slug].ts", `
			import { getCollection, initCollections } from "${collectionAbs}";
			export async function getStaticPaths() {
				await initCollections(process.cwd());
				const posts = await getCollection("posts");
				return posts.map((p) => ({ params: { slug: p.id }, props: { post: p } }));
			}
			export default function Post({ post }) {
				return { __html: '<!DOCTYPE html><html><head><title>' + post.data.title + '</title></head><body><h1>' + post.data.title + '</h1></body></html>' };
			}
		`);

		const first = runBuild();
		expect(first.status).toBe(0);
		// Sanity — the initial slug was built.
		await fs.stat(path.join(projectRoot, "dist", "posts", "first", "index.html"));

		// Brand-new file. Existing entries are unchanged so per-file
		// fingerprints still match — only the directory listing differs.
		await write("src/content/posts/second.md", `---\ntitle: Second\n---\nSecond body.`);

		const second = runBuild();
		expect(second.status).toBe(0);

		// The new slug must exist on disk after the rebuild.
		const secondHtml = await fs.readFile(
			path.join(projectRoot, "dist", "posts", "second", "index.html"),
			"utf8",
		);
		expect(secondHtml).toContain("Second");
	});
});

describe("incremental detection #3 — MDX transitive imports", () => {
	it("editing a module imported inside .mdx invalidates the slug", async () => {
		await write("src/content.config.ts", `
			import { defineCollection, glob, z } from "${collectionAbs}";
			export const collections = {
				posts: defineCollection({
					loader: glob({ base: "src/content/posts", pattern: "*.mdx" }),
					schema: z.object({ title: z.string() }),
				}),
			};
		`);
		// The MDX entry imports a helper module. Editing the helper
		// must cause the slug to be re-rendered with the new value.
		await write("src/lib/greeting.ts", `export const greeting = "world v1";`);
		await write("src/content/posts/hello.mdx", `---
title: Hello
---
import { greeting } from "${path.join(projectRoot, "src/lib/greeting.ts")}";

# Hello {greeting}
`);
		await write("src/pages/posts/[slug].ts", `
			import { getCollection, initCollections, render } from "${collectionAbs}";
			export async function getStaticPaths() {
				await initCollections(process.cwd());
				const posts = await getCollection("posts");
				return posts.map((p) => ({ params: { slug: p.id }, props: { post: p } }));
			}
			export default async function Post({ post }) {
				const { Content } = await render(post);
				const body = (await Content()).__html;
				return { __html: '<!DOCTYPE html><html><head><title>' + post.data.title + '</title></head><body>' + body + '</body></html>' };
			}
		`);

		const first = runBuild();
		expect(first.status).toBe(0);
		const firstHtml = await fs.readFile(
			path.join(projectRoot, "dist", "posts", "hello", "index.html"),
			"utf8",
		);
		expect(firstHtml).toContain("world v1");

		// Bump the helper only.
		await write("src/lib/greeting.ts", `export const greeting = "world v2";`);

		const second = runBuild();
		expect(second.status).toBe(0);
		const secondHtml = await fs.readFile(
			path.join(projectRoot, "dist", "posts", "hello", "index.html"),
			"utf8",
		);
		expect(secondHtml).toContain("world v2");
	});
});

describe("incremental detection #5 — CSS bundle hash orphan", () => {
	it("editing global.css updates the <link href> in cached pages too", async () => {
		// Two pages so one will be cached on rebuild — we want to
		// prove the cached page's link tag still points at a real
		// bundle file after the CSS hash changes.
		await write("src/styles/global.css", `body { color: red; }`);
		await write("src/pages/index.ts", `
			export default function Home() {
				return { __html: '<!DOCTYPE html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>' };
			}
		`);
		await write("src/pages/about.ts", `
			export default function About() {
				return { __html: '<!DOCTYPE html><html><head><title>About</title></head><body><h1>About</h1></body></html>' };
			}
		`);

		const first = runBuild();
		expect(first.status).toBe(0);
		const firstIndexHtml = await fs.readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
		const firstLink = /\/assets\/styles\.[a-f0-9]+\.css/.exec(firstIndexHtml)?.[0];
		expect(firstLink).toBeDefined();

		// Edit the CSS — the bundle's content hash will change.
		await write("src/styles/global.css", `body { color: blue; }`);

		const second = runBuild();
		expect(second.status).toBe(0);
		const secondIndexHtml = await fs.readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
		const secondAboutHtml = await fs.readFile(path.join(projectRoot, "dist", "about", "index.html"), "utf8");

		const secondLink = /\/assets\/styles\.[a-f0-9]+\.css/.exec(secondIndexHtml)?.[0];
		const aboutLink = /\/assets\/styles\.[a-f0-9]+\.css/.exec(secondAboutHtml)?.[0];
		expect(secondLink).toBeDefined();
		expect(secondLink).not.toBe(firstLink);
		// The cached page must link the SAME new bundle. If it still
		// references the old hash, that file no longer exists in dist
		// → broken stylesheet.
		expect(aboutLink).toBe(secondLink);

		// And the new bundle file must actually be on disk.
		await fs.stat(path.join(projectRoot, "dist", secondLink!.replace(/^\//, "")));
	});
});

describe("incremental detection #6 — tsconfig/package.json in configHash", () => {
	it("editing tsconfig.json busts the cache", async () => {
		await write("tsconfig.json", `{ "compilerOptions": { "strict": true } }`);
		await write("src/pages/index.ts", `
			export default function Home() {
				return { __html: '<!DOCTYPE html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>' };
			}
		`);

		expect(runBuild().status).toBe(0);
		expect(runBuild().stdout).toMatch(/1 cached/);

		// Change tsconfig (path-affecting field). The route cache must
		// be invalidated — module resolution semantics may now differ.
		await write("tsconfig.json", `{ "compilerOptions": { "strict": true, "paths": { "@/*": ["./src/*"] } } }`);

		const after = runBuild();
		expect(after.status).toBe(0);
		expect(after.stdout).toMatch(/1 rendered \+ 0 cached/);
	});

	it("editing a relevant package.json field busts the cache", async () => {
		await write("package.json", `{ "name": "fixture", "dependencies": { "left-pad": "1.0.0" } }`);
		await write("src/pages/index.ts", `
			export default function Home() {
				return { __html: '<!DOCTYPE html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>' };
			}
		`);

		expect(runBuild().status).toBe(0);
		expect(runBuild().stdout).toMatch(/1 cached/);

		// Changing dependencies must invalidate the cache (lockfile may
		// not have been regenerated yet, but the intent has changed).
		await write("package.json", `{ "name": "fixture", "dependencies": { "left-pad": "1.0.0", "right-pad": "1.0.0" } }`);

		const after = runBuild();
		expect(after.status).toBe(0);
		expect(after.stdout).toMatch(/1 rendered \+ 0 cached/);
	});
});

describe("incremental detection #7 — Astro hoisted script CSS imports", () => {
	it("updates the global CSS bundle and cached page links when hoisted CSS changes", async () => {
		await write("vendor/hoisted-transitive.css", `.hoisted-css-v1 { color: red; }`);
		await write("src/scripts/external.js", `
			import "../../vendor/hoisted-transitive.css";
			document.documentElement.dataset.hoisted = "loaded";
		`);
		await write("src/pages/index.astro", `
---
const title = "Hoisted CSS";
---
<html>
	<head><title>{title}</title></head>
	<body><h1>Hoisted CSS</h1></body>
</html>
<script>
	import "../scripts/external.js";
</script>
`);
		await write("src/pages/about.ts", `
			export default function About() {
				return { __html: '<!DOCTYPE html><html><head><title>About</title></head><body><h1>About</h1></body></html>' };
			}
		`);

		const first = runBuild();
		expect(first.status).toBe(0);
		const firstIndex = await readCssBundleFor("index.html");
		expect(firstIndex.css).toContain(".hoisted-css-v1");

		await write("vendor/hoisted-transitive.css", `
			.hoisted-css-v1 { color: red; }
			.hoisted-css-v2 { color: blue; }
		`);

		const second = runBuild();
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("about.ts → dist/about/index.html");
		expect(second.stdout).toContain("[cached]");

		const secondIndex = await readCssBundleFor("index.html");
		const secondAbout = await readCssBundleFor("about/index.html");
		expect(secondIndex.href).not.toBe(firstIndex.href);
		expect(secondIndex.href).toBe(secondAbout.href);
		expect(secondIndex.css).toContain(".hoisted-css-v2");
	});
});

describe("incremental detection #8 — Tailwind-mode JS CSS side effects", () => {
	it("includes src CSS imported through JS when Tailwind owns the primary CSS entry", async () => {
		await write("node_modules/@tailwindcss/node/package.json", `{"type":"module","main":"index.js"}`);
		await write("node_modules/@tailwindcss/node/index.js", `
			export async function compile() {
				return {
					root: "none",
					sources: [],
					build() {
						return ".fake-tailwind-output { color: black; }";
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
		await write("src/styles/app.css", `@import "tailwindcss";`);
		await write("src/styles/local.css", `.tailwind-local-side-effect-css { color: red; }`);
		await write("src/scripts/entry.js", `import "../styles/local.css";`);
		await write("src/pages/index.astro", `
---
import "../scripts/entry.js";
---
<html>
	<head><title>Tailwind side effect</title></head>
	<body><h1 class="fake-tailwind-output">Tailwind side effect</h1></body>
</html>
`);

		const result = runBuild();
		expect(result.status).toBe(0);
		const { css } = await readCssBundleFor("index.html");
		expect(css).toContain(".fake-tailwind-output");
		expect(css).toContain(".tailwind-local-side-effect-css");
		expect(css.match(/\.tailwind-local-side-effect-css/g)?.length).toBe(1);
	});
});

describe("incremental detection #9 — non-.astro page CSS side effects", () => {
	it("bundles external CSS from a .tsx page without duplicating src CSS", async () => {
		await write("vendor/ext.css", `.tsx-external-side-effect-css { color: red; }`);
		await write("src/styles/local.css", `.tsx-local-side-effect-css { color: blue; }`);
		await write("src/pages/index.tsx", `
			import "../../vendor/ext.css";
			import "../styles/local.css";
			export default function Index() {
				return { __html: '<!DOCTYPE html><html><head><title>TSX</title></head><body><h1>TSX</h1></body></html>' };
			}
		`);

		const first = runBuild();
		expect(first.status).toBe(0);
		const firstIndex = await readCssBundleFor("index.html");
		// External CSS (outside src/) only reaches the bundle via the JS import scan.
		expect(firstIndex.css).toContain(".tsx-external-side-effect-css");
		// Source CSS is already covered by the src glob — must not be duplicated.
		expect(firstIndex.css).toContain(".tsx-local-side-effect-css");
		expect(firstIndex.css.match(/\.tsx-local-side-effect-css/g)?.length).toBe(1);

		// Rebuild with no changes must reuse the same content hash (deterministic order).
		const second = runBuild();
		expect(second.status).toBe(0);
		const secondIndex = await readCssBundleFor("index.html");
		expect(secondIndex.href).toBe(firstIndex.href);
	});
});
