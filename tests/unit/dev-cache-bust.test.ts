/**
 * Dev-mode cache-bust rewrite: `applyDevCacheBust` appends `?v=<version>`
 * to `.astro`, `.scss`/`.sass`, and `.json` import specifiers so Bun's
 * ESM cache releases transitive imports after their source files change.
 *
 * The `.json` rule exists for translation dictionaries (and other data
 * files) imported from `.astro` pages — without the cache-bust, Bun keeps
 * the first-parsed JSON in memory and edits to the dictionary never
 * show up in the rendered HTML.
 */

import { describe, expect, test } from "bun:test";
import { applyDevCacheBust } from "../../packages/pletivo/src/dev-cache";

describe("applyDevCacheBust", () => {
  test("is a no-op when version is 0", () => {
    const code = `import cs from "../i18n/cs.json";\nimport Header from "./Header.astro";`;
    expect(applyDevCacheBust(code, 0)).toBe(code);
  });

  test("is a no-op for negative versions", () => {
    const code = `import cs from "../i18n/cs.json";`;
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

  test("cache-busts `.json` imports (the translation-dictionary case)", () => {
    const code = [
      `import cs from "../i18n/cs.json";`,
      `import en from '../i18n/en.json';`,
    ].join("\n");

    expect(applyDevCacheBust(code, 12)).toBe(
      [
        `import cs from "../i18n/cs.json?v=12";`,
        `import en from '../i18n/en.json?v=12';`,
      ].join("\n"),
    );
  });

  test("leaves unrelated imports alone", () => {
    const code = [
      `import { foo } from "./util";`,
      `import React from "react";`,
      `import data from "./data.yaml";`,
    ].join("\n");
    expect(applyDevCacheBust(code, 4)).toBe(code);
  });

  test("combines all rewrites in a single pass", () => {
    const code = [
      `import Header from "../components/Header.astro";`,
      `import cs from "../i18n/cs.json";`,
      `import "../styles/base.scss";`,
      `import { helper } from "./helper";`,
    ].join("\n");

    expect(applyDevCacheBust(code, 9)).toBe(
      [
        `import Header from "../components/Header.astro?v=9";`,
        `import cs from "../i18n/cs.json?v=9";`,
        `import "../styles/base.scss?v=9";`,
        `import { helper } from "./helper";`,
      ].join("\n"),
    );
  });

  test("does not rewrite specifiers that already carry a query string", () => {
    // The plugin runs once per transform, so a specifier that's already
    // been rewritten on an earlier pass shouldn't grow a second suffix.
    const already = `import cs from "../i18n/cs.json?v=2";`;
    expect(applyDevCacheBust(already, 5)).toBe(already);
  });
});
