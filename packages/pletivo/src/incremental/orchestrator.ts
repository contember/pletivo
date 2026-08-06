import path from "node:path";
import fs from "node:fs/promises";
import { runWithRuntimeDepCapture } from "./dep-tracker";
import { collectStaticDeps, isWalkableSourceFile } from "./import-graph";
import { canReuseFingerprint, fingerprintFile, hashString, type CacheStore, type CachedFragmentRef, type RouteCacheEntry } from "./cache";

/**
 * Loaded handle to @nuasite/astro-fragments — resolved once per build
 * after detecting the integration in astro.config. Null when the user
 * isn't using fragments.
 */
export interface FragmentsHelper {
	runInRenderPass: <T>(pageId: string, fn: () => T | Promise<T>) => Promise<{ value: T; fragmentIds: string[] }>;
	getFragments: () => Array<{ hash: string; moduleId: string; props: Record<string, unknown> }>;
	registerFragment: (params: { moduleId: string; props: Record<string, unknown>; pageUrl?: string }) => string;
	isRegistryEnabled: () => boolean;
}

/**
 * Optional peer: owned by the consuming project, never a pletivo dependency,
 * and not published to npm. Resolved the same way `css.ts` resolves Tailwind —
 * `require.resolve` against the project root, then import the resolved path.
 * That both keeps the specifier out of TypeScript's static resolution and
 * finds the module in non-hoisted (pnpm) layouts where pletivo's own
 * node_modules can't see it. The shape is validated below either way.
 */
const FRAGMENTS_MODULE = "@nuasite/astro-fragments";

export async function resolveFragmentsHelper(projectRoot: string): Promise<FragmentsHelper | null> {
	try {
		const resolved = require.resolve(FRAGMENTS_MODULE, { paths: [projectRoot] });
		const mod = (await import(resolved)) as unknown as Partial<FragmentsHelper>;
		if (
			typeof mod.runInRenderPass !== "function" ||
			typeof mod.getFragments !== "function" ||
			typeof mod.registerFragment !== "function" ||
			typeof mod.isRegistryEnabled !== "function"
		) {
			return null;
		}
		return {
			runInRenderPass: mod.runInRenderPass.bind(mod),
			getFragments: mod.getFragments.bind(mod),
			registerFragment: mod.registerFragment.bind(mod),
			isRegistryEnabled: mod.isRegistryEnabled.bind(mod),
		};
	} catch {
		return null;
	}
}

export interface RenderProducts {
	/** Final HTML string the page render produced. Empty when the render aborted. */
	html: string;
	renderedModules: Set<string>;
	tsxStyles: string[];
}

export interface RenderRequest {
	/** Stable cache key — e.g. "blog/[slug].astro::slug=hello". */
	routeKey: string;
	/** dist-relative output file (e.g. "blog/hello/index.html"). */
	outFile: string;
	/** Absolute path of the page module entrypoint (used as graph root). */
	pageEntryAbsPath: string;
	distDir: string;
	cache: CacheStore | null;
	fragments: FragmentsHelper | null;
	/**
	 * Pre-computed inventory of files currently in dist, relative to
	 * `distDir`. Replaces a per-slug `fs.access(outPath)` call with a
	 * single `Set.has()` — meaningful on warm builds with thousands of
	 * cached slugs.
	 */
	distFiles?: Set<string>;
	/**
	 * The actual render. Must be deterministic w.r.t. its captured deps
	 * (anything read via Bun.file / collection / image gets recorded by
	 * the dep-tracker scope set up around this call).
	 */
	doRender: () => Promise<RenderProducts>;
	/**
	 * Caller already proved the route's deps are still valid (typically:
	 * the dynamic route's parent cache entry covers every file this slug
	 * could legitimately depend on, so the per-slug fingerprint check
	 * would be redundant). When true, the only verification before
	 * returning the cached outcome is that the output file is still on
	 * disk. Saves O(n_deps) stat calls per slug — huge win on warm
	 * builds with thousands of slugs.
	 */
	assumeDepsValid?: boolean;
	/**
	 * Additional file paths that should participate in invalidation for
	 * this specific render. Pass either the resolved set directly, or a
	 * thunk — the thunk is only invoked on the fresh-render path, so
	 * the skip path doesn't pay for work it doesn't need (e.g.
	 * fetching the slug's `pathProps` purely to extract `_filePath`
	 * markers).
	 */
	extraDeps?: Iterable<string> | (() => Promise<Iterable<string>>);
}

export type RenderSource = "cached" | "rendered";

export interface RenderOutcome {
	source: RenderSource;
	html: string;
	renderedModules: Set<string>;
	tsxStyles: string[];
	/**
	 * Island names + hoisted-script hashes referenced from this page.
	 * Populated from cache on the `cached` path (no HTML read needed)
	 * and from a fresh scan of the rendered HTML on the `rendered` path.
	 */
	islands: string[];
	hoistedHashes: string[];
	/**
	 * Byte size of the output file. Cached path returns the persisted
	 * value (no stat); rendered path returns the freshly-emitted size
	 * once `writeHtml` runs (populated downstream — the orchestrator
	 * only knows it for the cached path).
	 */
	size: number;
}

export async function runIncrementalRender(req: RenderRequest): Promise<RenderOutcome> {
	const cached = req.cache?.getRoute(req.routeKey);
	const depsValid = cached && (req.assumeDepsValid || (await canReuse(cached)));
	if (cached && depsValid) {
		// Persistent-dist mode: the cached HTML file is already on
		// disk from the previous build. We don't even read it — the
		// next build pass needs only metadata (island/hoisted lists,
		// renderedModules for CSS, fragment refs for replay), all of
		// which we persisted last time. Existence check is either a
		// O(1) lookup against the prebuilt inventory or a stat fallback.
		const exists = req.distFiles
			? req.distFiles.has(cached.outPath)
			: await fileExists(path.join(req.distDir, cached.outPath));
		if (exists) {
			if (req.fragments && cached.fragments.length > 0) {
				replayFragments(req.fragments, cached.fragments, normalizeUsedBy(cached.outPath));
			}
			return {
				source: "cached",
				html: "",
				renderedModules: new Set(cached.renderedModules),
				tsxStyles: cached.tsxStyles,
				islands: cached.islands ?? [],
				hoistedHashes: cached.hoistedHashes ?? [],
				size: cached.size ?? 0,
			};
		}
		// File was deleted out from under us (manual rm, race) — fall
		// through to a fresh render.
	}

	return await freshRender(req, cached);
}

async function freshRender(req: RenderRequest, prior: RouteCacheEntry | undefined): Promise<RenderOutcome> {
	const { value, runtimeDeps, fragmentIds } = await renderWithCapture(req);
	const islands = scanIslands(value.html);
	const hoistedHashes = scanHoistedHashes(value.html);

	if (req.cache) {
		const staticDeps = await collectStaticDeps(req.pageEntryAbsPath);
		const allDeps = new Set<string>();
		for (const d of staticDeps) allDeps.add(d);
		for (const d of runtimeDeps) allDeps.add(d);
		if (req.extraDeps) {
			const extra = typeof req.extraDeps === "function" ? await req.extraDeps() : req.extraDeps;
			// extraDeps that are source files (.mdx, .astro, .tsx, …)
			// can themselves import other modules — walk their static
			// graphs so an edit to e.g. a component imported inside an
			// MDX entry invalidates the slug. Without the walk we'd
			// only fingerprint the MDX file itself and miss its
			// transitive deps.
			const walks = await Promise.all(
				[...extra].map(async (d) => {
					allDeps.add(d);
					return isWalkableSourceFile(d) ? await collectStaticDeps(d) : null;
				}),
			);
			for (const w of walks) {
				if (w) for (const d of w) allDeps.add(d);
			}
		}

		const depFingerprints: Record<string, import("./cache").DepFingerprint> = {};
		await Promise.all([...allDeps].map(async (d) => {
			depFingerprints[d] = await fingerprintFile(d);
		}));

		const fragmentsList: CachedFragmentRef[] = [];
		if (req.fragments && fragmentIds.length > 0) {
			const all = req.fragments.getFragments();
			const byHash = new Map(all.map((e) => [e.hash, e] as const));
			for (const id of fragmentIds) {
				const entry = byHash.get(id);
				if (entry) {
					fragmentsList.push({ hash: entry.hash, moduleId: entry.moduleId, props: entry.props });
				}
			}
		}

		const entry: RouteCacheEntry = {
			outPath: req.outFile,
			outputHash: hashString(value.html),
			depFingerprints,
			renderedModules: [...value.renderedModules],
			tsxStyles: value.tsxStyles,
			fragments: fragmentsList,
			islands,
			hoistedHashes,
			// Populated downstream after writeHtml — we don't know the
			// final byte length yet (CSS/script injection happens there).
			size: 0,
		};
		req.cache.setRoute(req.routeKey, entry);
	} else {
		// `prior` is held only to suppress an unused warning when caching
		// is off; we still want symmetric signatures across paths.
		void prior;
	}

	return {
		source: "rendered",
		html: value.html,
		renderedModules: value.renderedModules,
		tsxStyles: value.tsxStyles,
		islands,
		hoistedHashes,
		size: 0,
	};
}

/**
 * Patch the freshly-rendered size onto an existing cache entry. Build
 * pipeline calls this after `writeHtml` returns the actual byte count
 * — cheaper than re-stat'ing every cached file on the next warm build.
 */
export function recordRenderedSize(cache: CacheStore, routeKey: string, size: number): void {
	const entry = cache.getRoute(routeKey);
	if (!entry) return;
	if (entry.size === size) return;
	cache.setRoute(routeKey, { ...entry, size });
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}


const ISLAND_RE = /data-component="([^"]+)"/g;
const HOISTED_RE = /\/_astro\/hoisted-([a-f0-9]+)\.js/g;

function scanIslands(html: string): string[] {
	const out = new Set<string>();
	ISLAND_RE.lastIndex = 0;
	let m;
	while ((m = ISLAND_RE.exec(html)) !== null) out.add(m[1]);
	return [...out];
}

function scanHoistedHashes(html: string): string[] {
	const out = new Set<string>();
	HOISTED_RE.lastIndex = 0;
	let m;
	while ((m = HOISTED_RE.exec(html)) !== null) out.add(m[1]);
	return [...out];
}

async function renderWithCapture(req: RenderRequest): Promise<{
	value: RenderProducts;
	runtimeDeps: Set<string>;
	fragmentIds: string[];
}> {
	if (!req.fragments) {
		const { value, runtimeDeps } = await runWithRuntimeDepCapture(req.doRender);
		return { value, runtimeDeps, fragmentIds: [] };
	}
	// Nest the fragments render-pass scope inside the runtime-dep scope
	// so fragment registrations made during the render are attributed
	// to this page and runtime file reads land in the right capture set.
	const { value: passResult, runtimeDeps } = await runWithRuntimeDepCapture(async () => {
		return await req.fragments!.runInRenderPass(req.routeKey, req.doRender);
	});
	return { value: passResult.value, runtimeDeps, fragmentIds: passResult.fragmentIds };
}

async function canReuse(cached: RouteCacheEntry): Promise<boolean> {
	const entries = Object.entries(cached.depFingerprints);
	// Parallel stat — each call is sub-ms and there are typically 5-15
	// deps per route. Fan-out beats fail-fast: in the common path
	// (nothing changed) we do every stat anyway, and the overhead of
	// one extra stat in the rare mismatch case is negligible.
	const checks = await Promise.all(entries.map(([file, prev]) => canReuseFingerprint(file, prev)));
	return checks.every(Boolean);
}

function replayFragments(
	fragments: FragmentsHelper,
	cached: CachedFragmentRef[],
	pageUrl: string,
): void {
	if (!fragments.isRegistryEnabled()) return;
	for (const f of cached) {
		try {
			fragments.registerFragment({ moduleId: f.moduleId, props: f.props, pageUrl });
		} catch (e) {
			// Replay failures are non-fatal — the integration's strict
			// check will surface dangling placeholders if any.
			console.warn(`  [incremental] replay of fragment ${f.hash} failed: ${(e as Error).message}`);
		}
	}
}

/**
 * Convert "blog/hello/index.html" → "blog/hello/index.html". The
 * fragments integration accepts arbitrary strings as `pageUrl` (used
 * only in the manifest's `usedBy` field), but we standardize on the
 * dist-relative path to match what the post-build scan finds in dist.
 */
function normalizeUsedBy(outPath: string): string {
	return outPath.split(path.sep).join("/");
}
