/**
 * The bundled assets each build emits, other than code: images, fonts, media.
 *
 * `compareOutputs` compares pages, `public/` copies and endpoint output; bundled
 * files only through the URLs pages reference them by. An asset nothing on a
 * compared page references (a font a stylesheet pulls in, an image only a script
 * uses) would go unseen. This compares the emitted set by name, hash erased:
 * `_astro/houston.Dm8K3lV8_Z1abc.webp` and `_astro/houston.d26c3520.webp` are both
 * `houston.webp`. Contents are not compared; the hash algorithms differ.
 */

import fs from "node:fs";
import path from "node:path";

export interface AssetComparison {
  astro: string[];
  pletivo: string[];
  /** Emitted by Astro, not by pletivo (a multiset difference). */
  missing: string[];
  extra: string[];
  match: boolean;
  summary: string;
}

/** Code and its maps are compared through the pages; everything else bundled is an asset. */
const CODE = /\.(css|js|mjs|cjs|map)$/i;
/** `name.<8-char hash>[_<transform>].ext` → `name.ext`. */
const HASHED = /^(.+?)\.[\w-]{8}(?:_[\w-]+)?(\.[a-z0-9]+)$/i;

function bundledAssets(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (!CODE.test(entry.name)) {
        const m = HASHED.exec(entry.name);
        out.push(m ? `${m[1]}${m[2]}` : entry.name);
      }
    }
  };
  for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out.sort();
}

function multisetMinus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

export function compareAssets(astroDir: string, pletivoDir: string): AssetComparison {
  const astro = bundledAssets(astroDir, ["_astro"]);
  const pletivo = bundledAssets(pletivoDir, ["_astro", "_islands"]);
  const missing = multisetMinus(astro, pletivo);
  const extra = multisetMinus(pletivo, astro);
  const parts: string[] = [];
  const list = (xs: string[]) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? ` (+${xs.length - 3})` : ""}`;
  if (missing.length) parts.push(`assets missing ${list(missing)}`);
  if (extra.length) parts.push(`assets extra ${list(extra)}`);
  return { astro, pletivo, missing, extra, match: missing.length === 0 && extra.length === 0, summary: parts.join("; ") };
}
