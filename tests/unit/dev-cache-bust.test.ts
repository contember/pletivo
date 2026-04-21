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

  test("cache-busts `.json` imports", () => {
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

  test("cache-busts extensionless relative imports", () => {
    const code = `import { t } from "../i18n";`;
    expect(applyDevCacheBust(code, 5))
      .toBe(`import { t } from "../i18n?v=5";`);
  });

  test("cache-busts .ts/.tsx/.js/.jsx relative imports", () => {
    const code = [
      `import a from "./a.ts";`,
      `import b from "./b.tsx";`,
      `import c from "./c.js";`,
      `import d from "./d.jsx";`,
    ].join("\n");

    expect(applyDevCacheBust(code, 2)).toBe(
      [
        `import a from "./a.ts?v=2";`,
        `import b from "./b.tsx?v=2";`,
        `import c from "./c.js?v=2";`,
        `import d from "./d.jsx?v=2";`,
      ].join("\n"),
    );
  });

  test("leaves bare specifiers alone", () => {
    const code = [
      `import React from "react";`,
      `import { describe } from "bun:test";`,
      `import { h } from "pletivo/jsx-runtime";`,
    ].join("\n");
    expect(applyDevCacheBust(code, 4)).toBe(code);
  });

  test("cache-busts re-exports", () => {
    const code = `export { t } from "./i18n";\nexport * from "./util";`;
    expect(applyDevCacheBust(code, 8)).toBe(
      `export { t } from "./i18n?v=8";\nexport * from "./util?v=8";`,
    );
  });

  test("cache-busts dynamic imports with a literal specifier", () => {
    const code = [
      `const mod = await import("./lazy.ts");`,
      `import( '../data/big.json' ).then(use);`,
    ].join("\n");

    expect(applyDevCacheBust(code, 6)).toBe(
      [
        `const mod = await import("./lazy.ts?v=6");`,
        `import( '../data/big.json?v=6' ).then(use);`,
      ].join("\n"),
    );
  });

  test("leaves dynamic imports with non-literal arguments alone", () => {
    const code = [
      "const a = await import(`./${name}.ts`);",
      `const b = await import(modulePath);`,
    ].join("\n");
    expect(applyDevCacheBust(code, 3)).toBe(code);
  });

  test("does not rewrite specifiers that already carry a query string", () => {
    const already = `import cs from "../i18n/cs.json?v=2";`;
    expect(applyDevCacheBust(already, 5)).toBe(already);
  });

  test("combines all rewrites in a single pass", () => {
    const code = [
      `import Header from "../components/Header.astro";`,
      `import cs from "../i18n/cs.json";`,
      `import "../styles/base.scss";`,
      `import { helper } from "./helper";`,
      `import React from "react";`,
    ].join("\n");

    expect(applyDevCacheBust(code, 9)).toBe(
      [
        `import Header from "../components/Header.astro?v=9";`,
        `import cs from "../i18n/cs.json?v=9";`,
        `import "../styles/base.scss?v=9";`,
        `import { helper } from "./helper?v=9";`,
        `import React from "react";`,
      ].join("\n"),
    );
  });
});
