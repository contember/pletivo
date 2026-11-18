import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_URI_TYPES, rewriteCssAssets } from "../src/css-assets.ts";

/** Each `data:` URI in a stylesheet, in source order. */
function dataUris(css: string): string[] {
  return [...css.matchAll(/url\("?(data:[^")]+)"?\)/g)].map((match) => match[1]);
}

test("inlines every small target as the data: URI Bun.build writes", async () => {
  // Every entry, uppercase spellings, and extensions Bun has no type for.
  const extensions = [...Object.keys(DATA_URI_TYPES), ".PNG", ".Svg", ".bin", ".jxl", ""];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-data-uri-"));
  try {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    let css = "";
    for (const [index, extension] of extensions.entries()) {
      // Distinct bytes per file: Bun shares one data: URI between files with equal content.
      const bytes = new Uint8Array(new TextEncoder().encode(`file ${index}${extension} ÿ`));
      await fs.writeFile(path.join(dir, `f${index}${extension}`), bytes);
      files.set(`site/f${index}${extension}`, bytes);
      css += `.f${index} { background: url(./f${index}${extension}); }\n`;
    }
    await fs.writeFile(path.join(dir, "entry.css"), css);

    const result = await Bun.build({ entrypoints: [path.join(dir, "entry.css")], target: "browser" });
    const built = result.outputs.find((output) => output.path.endsWith(".css"));
    if (!result.success || built === undefined) throw new Error(result.logs.map(String).join("\n"));
    const workers = rewriteCssAssets("site/entry.css", css, (file) => files.get(file), new Map());

    const expected = dataUris(await built.text());
    expect(expected).toHaveLength(extensions.length);
    expect(dataUris(workers)).toEqual(expected);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
