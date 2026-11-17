import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Spawns full `pletivo build` subprocesses; give them room under CI load.
setDefaultTimeout(30_000);

// An incremental build keeps dist/, so it must remove what a route it no longer has wrote,
// and nothing else: public/ copies and integration output live in dist/ too.

const cliPath = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

let projectRoot = "";

const page = (title: string) => `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`;
const endpoint = (body: string) => `export function GET() {\n\treturn new Response(${JSON.stringify(body)});\n}\n`;

beforeEach(async () => {
	projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-prune-e2e-"));
	await write("astro.config.mjs", `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export default {
	integrations: [{
		name: "llms",
		hooks: {
			"astro:build:done": ({ dir }) => {
				if (process.env.FAIL_BUILD_DONE) process.exit(1);
				fs.writeFileSync(path.join(fileURLToPath(dir), "llms.txt"), "llms");
			},
		},
	}],
};
`);
	await write("src/pages/index.astro", page("Home"));
});

afterEach(async () => {
	await fs.rm(projectRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(projectRoot, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

async function rename(from: string, to: string): Promise<void> {
	await fs.rename(path.join(projectRoot, from), path.join(projectRoot, to));
}

function spawnBuild(incremental: boolean, env: Record<string, string>): { status: number | null; stderr: string } {
	return spawnSync("bun", ["run", cliPath, "build", ...(incremental ? ["--incremental"] : [])], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "production", ...env },
	});
}

function runBuild(incremental = true): void {
	const result = spawnBuild(incremental, {});
	if (result.status !== 0) throw new Error(`build exited with ${result.status}:\n${result.stderr}`);
}

async function inDist(rel: string): Promise<boolean> {
	return fs.stat(path.join(projectRoot, "dist", rel)).then(() => true, () => false);
}

describe("incremental build prunes stale route outputs", () => {
	it("removes the output of a deleted, a renamed and a _-prefixed endpoint", async () => {
		await write("src/pages/feed.xml.ts", endpoint("<feed/>"));
		await write("src/pages/old.json.ts", endpoint("{}"));
		await write("src/pages/rss.xml.ts", endpoint("<rss/>"));
		runBuild();
		for (const rel of ["feed.xml", "old.json", "rss.xml"]) expect(await inDist(rel)).toBe(true);

		await fs.rm(path.join(projectRoot, "src/pages/feed.xml.ts"));
		await rename("src/pages/old.json.ts", "src/pages/new.json.ts");
		await rename("src/pages/rss.xml.ts", "src/pages/_rss.xml.ts");
		runBuild();

		expect(await inDist("feed.xml")).toBe(false);
		expect(await inDist("old.json")).toBe(false);
		expect(await inDist("new.json")).toBe(true);
		expect(await inDist("rss.xml")).toBe(false);
		expect(await inDist("_rss.xml")).toBe(false);
		expect(await inDist("index.html")).toBe(true);
	});

	it("removes a deleted page and the directories it leaves empty", async () => {
		await write("src/pages/draft/index.astro", page("Draft"));
		await write("src/pages/blog/first.astro", page("First"));
		runBuild();
		expect(await inDist("draft/index.html")).toBe(true);
		expect(await inDist("blog/first/index.html")).toBe(true);

		await rename("src/pages/draft", "src/pages/_draft");
		await fs.rm(path.join(projectRoot, "src/pages/blog"), { recursive: true });
		runBuild();

		expect(await inDist("draft")).toBe(false);
		expect(await inDist("_draft")).toBe(false);
		expect(await inDist("blog")).toBe(false);
		expect(await inDist("index.html")).toBe(true);
	});

	it("keeps public/ copies, integration and post-build output, and a directory they still use", async () => {
		await write("public/verify.html", "public verify");
		await write("public/docs/guide.txt", "public guide");
		await write("src/pages/docs/index.astro", page("Docs"));
		await write("src/pages/robots.txt.ts", endpoint("route robots"));
		await write("src/pages/llms.txt.ts", endpoint("route llms"));
		runBuild();
		expect(await inDist("docs/index.html")).toBe(true);
		// A search indexer runs over dist/ after the build, so no build writes this.
		await write("dist/pagefind/pagefind.js", "index");

		// The docs page goes, public/ takes over the path the robots endpoint wrote,
		// and only the integration writes llms.txt now.
		await fs.rm(path.join(projectRoot, "src/pages/docs"), { recursive: true });
		await fs.rm(path.join(projectRoot, "src/pages/robots.txt.ts"));
		await fs.rm(path.join(projectRoot, "src/pages/llms.txt.ts"));
		await write("public/robots.txt", "public robots");
		runBuild();

		const read = (rel: string) => fs.readFile(path.join(projectRoot, "dist", rel), "utf8");
		expect(await inDist("docs/index.html")).toBe(false);
		expect(await read("docs/guide.txt")).toBe("public guide");
		expect(await read("verify.html")).toBe("public verify");
		expect(await read("robots.txt")).toBe("public robots");
		expect(await read("llms.txt")).toBe("llms");
		expect(await read("pagefind/pagefind.js")).toBe("index");
	});

	// A plain build discards the cache, so the incremental build after it has no record to prune by.
	for (const [label, source, content, output] of [
		["a page", "src/pages/draft/index.astro", page("Draft"), "draft/index.html"],
		["an endpoint", "src/pages/api/feed.xml.ts", endpoint("<feed/>"), "api/feed.xml"],
	]) {
		it(`removes ${label} deleted after a plain build, and the directory it leaves empty`, async () => {
			await write(source, content);
			runBuild(false);
			expect(await inDist(output)).toBe(true);

			await fs.rm(path.join(projectRoot, path.dirname(source)), { recursive: true });
			runBuild();

			expect(await inDist(path.dirname(output))).toBe(false);
			expect(await inDist("index.html")).toBe(true);
			expect(await inDist("llms.txt")).toBe(true);
		});
	}

	it("removes an output written by a build that failed after its page writes", async () => {
		runBuild();
		await write("src/pages/draft.astro", page("Draft"));
		expect(spawnBuild(true, { FAIL_BUILD_DONE: "1" }).status).not.toBe(0);
		expect(await inDist("draft/index.html")).toBe(true);

		await rename("src/pages/draft.astro", "src/pages/final.astro");
		runBuild();
		expect(await inDist("draft")).toBe(false);
		expect(await inDist("final/index.html")).toBe(true);
		runBuild();
		expect(await inDist("draft")).toBe(false);
	});

	it("does not follow a symlinked directory in dist/ out of it", async () => {
		await write("src/pages/media/sub/index.astro", page("Sub"));
		runBuild();
		await write("outside/sub/index.html", "not dist");
		await fs.rm(path.join(projectRoot, "dist/media"), { recursive: true });
		await fs.symlink(path.join(projectRoot, "outside"), path.join(projectRoot, "dist/media"));

		await fs.rm(path.join(projectRoot, "src/pages/media"), { recursive: true });
		runBuild();

		expect(await fs.readFile(path.join(projectRoot, "outside/sub/index.html"), "utf8")).toBe("not dist");
	});

	it("does not follow a symlinked directory in dist/ onto a live output", async () => {
		await write("src/pages/old/index.astro", page("Old"));
		await write("src/pages/new/index.astro", page("New"));
		runBuild();
		await fs.rm(path.join(projectRoot, "dist/old"), { recursive: true });
		await fs.symlink(path.join(projectRoot, "dist/new"), path.join(projectRoot, "dist/old"));

		await fs.rm(path.join(projectRoot, "src/pages/old"), { recursive: true });
		runBuild();

		expect(await inDist("new/index.html")).toBe(true);
	});

	it("keeps a symlinked public/ file that took over an endpoint's path", async () => {
		await write("src/pages/robots.txt.ts", endpoint("route robots"));
		runBuild();

		await fs.rm(path.join(projectRoot, "src/pages/robots.txt.ts"));
		await write("robots-source.txt", "public robots");
		await fs.mkdir(path.join(projectRoot, "public"), { recursive: true });
		await fs.symlink(path.join(projectRoot, "robots-source.txt"), path.join(projectRoot, "public/robots.txt"));
		for (let i = 0; i < 2; i++) {
			runBuild();
			expect(await fs.readFile(path.join(projectRoot, "dist/robots.txt"), "utf8")).toBe("public robots");
		}
	});

	// A pletivo-native project hashes public/ assets, so public/logo.svg is written as logo.<hash>.svg.
	it("removes an endpoint's output whose path a hashed public/ file does not take", async () => {
		await fs.rm(path.join(projectRoot, "astro.config.mjs"));
		await fs.rm(path.join(projectRoot, "src/pages/index.astro"));
		await write("src/pages/index.ts", `export default function Home() {\n\treturn { __html: ${JSON.stringify(page("Home"))} };\n}\n`);
		await write("src/pages/logo.svg.ts", endpoint("<svg/>"));
		runBuild();
		expect(await inDist("logo.svg")).toBe(true);

		await fs.rm(path.join(projectRoot, "src/pages/logo.svg.ts"));
		await write("public/logo.svg", "<svg/>");
		runBuild();

		expect(await inDist("logo.svg")).toBe(false);
		const hashed = (await fs.readdir(path.join(projectRoot, "dist"))).filter((f) => /^logo\.[0-9a-f]{8}\.svg$/.test(f));
		expect(hashed).toHaveLength(1);
	});
});
