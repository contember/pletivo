/**
 * Dev-mode cache-bust rewrite: `applyDevCacheBust` appends `?v=<version>`
 * to `.astro` and `.scss`/`.sass` import specifiers so Bun's ESM cache
 * releases transitive imports after their source files change.
 */

import { describe, expect, test } from "bun:test";
import { applyDevCacheBust } from "../../packages/pletivo/src/dev-cache";

describe("applyDevCacheBust", () => {
  test("is a no-op when version is 0", () => {
    const code = `import Header from "./Header.astro";`;
    expect(applyDevCacheBust(code, 0)).toBe(code);
  });

  test("is a no-op for negative versions", () => {
    const code = `import Header from "./Header.astro";`;
    expect(applyDevCacheBust(code, -1)).toBe(code);
  });

  test("cache-busts `.astro` imports", () => {
    const code = `import Header from "./Header.astro";`;
    expect(applyDevCacheBust(code, 3))
      .toBe(`import Header from "./Header.astro?v=3";`);
  });

  test("cache-busts `.scss`/`.sass` side-effect imports", () => {
    const code = `import "../styles/base.scss";\nimport "../styles/layout.sass";`;
    expect(applyDevCacheBust(code, 7))
      .toBe(`import "../styles/base.scss?v=7";\nimport "../styles/layout.sass?v=7";`);
  });

  test("leaves unrelated imports alone", () => {
    const code = [
      `import { foo } from "./util";`,
      `import React from "react";`,
      `import data from "./data.yaml";`,
    ].join("\n");
    expect(applyDevCacheBust(code, 4)).toBe(code);
  });
});
