import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-process test: each `pletivo build` invocation is a fresh Bun
 * process, which is the only way to exercise the actual incremental
 * flow end-to-end. Tests that call `build()` directly in-process can't
 * verify "edit file → re-render with new content" because Bun's
 * module cache hangs on to the first-loaded page module.
 */

const cliPath = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

let projectRoot = "";

beforeEach(async () => {
	projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-inc-e2e-"));
	// Minimal project — plain function components returning {__html},
	// avoids needing a tsconfig with the pletivo JSX paths.
	await write("src/components/Layout.ts", `
		export default function Layout(opts: { title: string; body: string }) {
			return { __html: '<!DOCTYPE html><html><head><title>' + opts.title + '</title></head><body><main>' + opts.body + '</main></body></html>' };
		}
	`);
	await write("src/pages/index.ts", `
		import Layout from "../components/Layout";
		export default function Home() {
			return Layout({ title: "Home", body: "<h1>Home v1</h1>" });
		}
	`);
	await write("src/pages/about.ts", `
		import Layout from "../components/Layout";
		export default function About() {
			return Layout({ title: "About", body: "<h1>About v1</h1>" });
		}
	`);
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
	const result = spawnSync("bun", ["run", cliPath, "build", ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "production" },
	});
	return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

describe("e2e incremental rebuild", () => {
	it("second build skips every cached page", async () => {
		const first = runBuild();
		expect(first.status).toBe(0);
		expect(first.stdout).toContain("0 cached");

		const second = runBuild();
		expect(second.status).toBe(0);
		// Two static pages — both should be cached on the second run.
		expect(second.stdout).toMatch(/2 cached/);
	});

	it("rebuilds only the changed page", async () => {
		expect(runBuild().status).toBe(0);

		await write("src/pages/index.ts", `
			import Layout from "../components/Layout";
			export default function Home() {
				return Layout({ title: "Home", body: "<h1>Home v2</h1>" });
			}
		`);

		const second = runBuild();
		expect(second.status).toBe(0);
		// index.ts changed (1 rendered) + about.ts cached (1 cached).
		expect(second.stdout).toMatch(/1 rendered \+ 1 cached/);

		const indexHtml = await fs.readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
		const aboutHtml = await fs.readFile(path.join(projectRoot, "dist", "about", "index.html"), "utf8");
		expect(indexHtml).toContain("Home v2");
		expect(aboutHtml).toContain("About v1");
	});

	it("invalidates every page when a shared component changes", async () => {
		expect(runBuild().status).toBe(0);

		await write("src/components/Layout.ts", `
			export default function Layout(opts: { title: string; body: string }) {
				return { __html: '<!DOCTYPE html><html><head><title>' + opts.title + '</title></head><body><main data-layout="v2">' + opts.body + '</main></body></html>' };
			}
		`);

		const second = runBuild();
		expect(second.status).toBe(0);
		expect(second.stdout).toMatch(/2 rendered \+ 0 cached/);

		for (const rel of ["index.html", "about/index.html"]) {
			const html = await fs.readFile(path.join(projectRoot, "dist", rel), "utf8");
			expect(html).toContain('data-layout="v2"');
		}
	});

	it("--clean wipes the cache and forces every page to re-render", async () => {
		expect(runBuild().status).toBe(0);
		expect(runBuild().stdout).toMatch(/2 cached/);

		const cleaned = runBuild(["--clean"]);
		expect(cleaned.status).toBe(0);
		expect(cleaned.stdout).toMatch(/2 rendered \+ 0 cached/);
	});
});
