import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureCssAssets, rewriteCssAssetUrls } from "../../packages/pletivo/src/css-assets";

afterEach(() => configureCssAssets(null));

describe("rewriteCssAssetUrls", () => {
  test("rewrites a real url() and writes no file for one in a comment or a string", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-css-assets-"));
    try {
      const big = "x".repeat(5000);
      await fs.writeFile(path.join(dir, "big.svg"), big);
      await fs.writeFile(path.join(dir, "commented.svg"), big);
      await fs.writeFile(path.join(dir, "quoted.svg"), big);
      const outDir = path.join(dir, "out");
      const options = { outDir, publicPath: "/assets/" };
      configureCssAssets(options);

      const css =
        "/* was url(./commented.svg) */\n" +
        '.a { background: url(./big.svg); content: "url(./quoted.svg)"; }\n';
      const rewritten = await rewriteCssAssetUrls(path.join(dir, "site.css"), css, options);

      const hasher = new Bun.CryptoHasher("md5");
      hasher.update(big);
      const name = `big.${hasher.digest("hex").slice(0, 8)}.svg`;
      expect(rewritten).toBe(
        "/* was url(./commented.svg) */\n" +
          `.a { background: url("https://pletivo-asset-placeholder.invalid/assets/${name}"); content: "url(./quoted.svg)"; }\n`,
      );
      expect(await fs.readdir(outDir)).toEqual([name]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
