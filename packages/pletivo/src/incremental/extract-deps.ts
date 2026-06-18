import path from "node:path";

/**
 * Recursively walk an arbitrary value (typically `pathProps` from a
 * dynamic route's `getStaticPaths` entry) and collect every string
 * found under a `_filePath` or `_mdxFilePath` key.
 *
 * These markers are stamped onto collection entries by the content
 * loader so the build can tell which source file backs each entry —
 * crucial for per-slug incremental invalidation, since the .md / .mdx
 * read happens in `getStaticPaths`, outside any per-slug capture
 * scope. By walking `pathProps` we recover that information and
 * attribute the backing file as a dep of THIS slug only.
 *
 * Cycle-safe via WeakSet. Non-string `_filePath` values are ignored.
 * Only absolute paths are kept — relative ones can't be hashed
 * reliably.
 */
export function extractEntryFilePaths(value: unknown): Set<string> {
	const found = new Set<string>();
	const seen = new WeakSet<object>();

	function walk(v: unknown): void {
		if (v == null) return;
		if (typeof v !== "object") return;
		if (seen.has(v as object)) return;
		seen.add(v as object);

		if (Array.isArray(v)) {
			for (const item of v) walk(item);
			return;
		}

		// Skip walking into non-plain objects (Date, etc.) — they
		// can't carry our markers anyway and may have surprising
		// enumerable properties on their prototypes.
		const proto = Object.getPrototypeOf(v);
		if (proto !== Object.prototype && proto !== null) return;

		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if ((k === "_filePath" || k === "_mdxFilePath") && typeof val === "string" && path.isAbsolute(val)) {
				found.add(val);
			} else {
				walk(val);
			}
		}
	}

	walk(value);
	return found;
}
