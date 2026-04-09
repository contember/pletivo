import path from "path";
import fs from "fs/promises";

/**
 * Public asset hashing.
 *
 * Files in `public/` are copied into `dist/`. For a curated list of extensions
 * (css, js, images, fonts, media) we also rename each file to include an 8-char
 * content hash so the result can be served with aggressive `Cache-Control`.
 *
 * CSS and JS files are text-assets: they may reference other hashed files
 * (e.g. `url(/logo.png)` or `import "./foo.js"`), so we:
 *   1. Hash media/font/binary assets first (they have no outgoing refs).
 *   2. Read each text-asset, rewrite refs using the manifest so far,
 *      then hash the rewritten content.
 *   3. Non-hashable files (html, xml, txt, json, webmanifest) are copied as-is.
 *
 * The returned manifest maps original absolute paths (`/style.css`) to their
 * hashed counterparts (`/style.abcd1234.css`). Call-sites use it to rewrite
 * references inside rendered HTML.
 */

/** Binary / media assets — hash with no content rewriting. */
const MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".webm", ".mp3", ".ogg", ".wav", ".flac",
  ".pdf", ".zip", ".gz",
]);

/** Text assets — rewrite internal refs, then hash. */
const TEXT_ASSET_EXTS = new Set([".css", ".js", ".mjs", ".svg", ".map"]);

/** Extensions that should NOT be hashed (stable entry points). */
const SKIP_HASH_EXTS = new Set([
  ".html", ".htm", ".xml", ".txt", ".json", ".webmanifest",
]);

interface FileEntry {
  absPath: string;
  relPath: string; // POSIX, relative to publicRoot
}

export async function hashPublicAssets(
  publicDir: string,
  distDir: string,
): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();

  try {
    await fs.access(publicDir);
  } catch {
    return manifest;
  }

  const all: FileEntry[] = [];
  await walk(publicDir, publicDir, all);

  // Bucket files by category.
  const media: FileEntry[] = [];
  const text: FileEntry[] = [];
  const skip: FileEntry[] = [];
  for (const entry of all) {
    const ext = path.extname(entry.relPath).toLowerCase();
    if (MEDIA_EXTS.has(ext)) media.push(entry);
    else if (TEXT_ASSET_EXTS.has(ext)) text.push(entry);
    else skip.push(entry);
  }

  // 1. Media assets first — they have no outgoing references.
  for (const entry of media) {
    const content = await fs.readFile(entry.absPath);
    await writeHashed(entry, content, distDir, manifest);
  }

  // 2. Text assets — rewrite refs against current manifest, then hash.
  //    Note: if text assets reference each other, a single pass may miss
  //    forward refs. Good enough for typical projects; upgrade to
  //    topological order when it becomes a problem.
  for (const entry of text) {
    let content = await fs.readFile(entry.absPath, "utf-8");
    content = rewriteRefs(content, manifest);
    await writeHashed(entry, Buffer.from(content, "utf-8"), distDir, manifest);
  }

  // 3. Non-hashable files — copy as-is.
  for (const entry of skip) {
    const outPath = path.join(distDir, entry.relPath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.copyFile(entry.absPath, outPath);
  }

  // Defensive: anything unknown ext that isn't in either set falls through
  // to skip above (we classified unknown as skip).
  void SKIP_HASH_EXTS;

  return manifest;
}

async function walk(current: string, root: string, out: FileEntry[]) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, out);
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    out.push({ absPath: abs, relPath: rel });
  }
}

async function writeHashed(
  entry: FileEntry,
  content: Buffer,
  distDir: string,
  manifest: Map<string, string>,
): Promise<void> {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(content);
  const hash = hasher.digest("hex").slice(0, 8);

  const ext = path.extname(entry.relPath);
  const dir = path.dirname(entry.relPath);
  const base = path.basename(entry.relPath, ext);
  const hashedRel = (dir === "." ? "" : dir + "/") + `${base}.${hash}${ext}`;

  const outPath = path.join(distDir, hashedRel);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content);

  manifest.set("/" + entry.relPath, "/" + hashedRel);
}

/**
 * Rewrite asset references inside a text blob. Replaces any occurrence of
 * an original path (as a whole token) with its hashed counterpart.
 *
 * Matches on delimiter boundaries so `/foo.css` is not replaced inside
 * `/foo.css.bak`. Delimiters are anything in [`"'()\s=<>]; lookbehind +
 * lookahead preserve the surrounding characters.
 */
export function rewriteRefs(content: string, manifest: Map<string, string>): string {
  if (manifest.size === 0) return content;
  for (const [orig, hashed] of manifest) {
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Look-behind: start of string or a delimiter.
    // Look-ahead: end of string, a delimiter, or query/hash fragment.
    const re = new RegExp(
      `(^|[\\s"'(<>=,;])${escaped}(?=$|[\\s"')<>?#,;])`,
      "g",
    );
    content = content.replace(re, (_m, pre) => pre + hashed);
  }
  return content;
}
