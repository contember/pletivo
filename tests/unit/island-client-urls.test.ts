import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createIslandClientUrls, portableSpecifier } from "../../packages/core/src/island-urls";
import { base64url, sha256 } from "../../packages/core/src/sha256";

describe("sha256", () => {
  test("agrees with node:crypto on every padding boundary and on multi-byte text", () => {
    const inputs = ["", "abc", "Ünïcode \0 name", "x".repeat(10_000)];
    for (let length = 50; length <= 130; length++) inputs.push("a".repeat(length));
    for (const input of inputs) {
      expect(Buffer.from(sha256(input)).toString("hex")).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });

  test("base64url matches node's for every length remainder", () => {
    for (const input of ["a", "ab", "abc", "abcd"]) {
      const bytes = new TextEncoder().encode(input);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });
});

describe("createIslandClientUrls", () => {
  // Pinned to the names the Bun host wrote before the function moved to @pletivo/core:
  // a changed name strands every deployed page that links the old one.
  test("names island files as the Bun host always has", () => {
    const urls = createIslandClientUrls({ projectRoot: "/srv/site", base: "/docs", beforeHydrationScripts: ["a()", "b()"] });
    expect(urls.component("/srv/site/src/Counter.jsx", "default")).toBe("/docs/_astro/Counter.Vedf7V_v.js");
    expect(urls.component("/srv/site/src/components/Ünïcode Name.vue", "react.Counter")).toBe(
      "/docs/_astro/_n_code_Name.gUizn5a3.js",
    );
    expect(urls.component("/other/x/.hidden", "default")).toBe("/docs/_astro/.hidden.OWql_iom.js");
    expect(urls.component("@scope/pkg/Button.svelte", "Button")).toBe("/docs/_astro/Button.qZ5XLAN8.js");
    expect(urls.component("/srv/site/src/Counter", "default")).toBe("/docs/_astro/Counter.53rlYpUb.js");
    expect(urls.renderer("@astrojs/react")).toBe("/docs/_astro/client.i0iyvY7u.js");
    expect(urls.renderer("@astrojs/svelte")).toBe("/docs/_astro/client.svelte.LfsQ-rWT.js");
    expect(urls.beforeHydration).toBe("/docs/_astro/before-hydration.gXREYdZX.js");
  });
});

describe("portableSpecifier", () => {
  test("is relative to the root with POSIX separators, and leaves a package specifier alone", () => {
    expect(portableSpecifier("/srv/site", "/srv/site/src/A.vue")).toBe("./src/A.vue");
    expect(portableSpecifier("/srv/site/", "/srv/other/A.vue")).toBe("../other/A.vue");
    expect(portableSpecifier("C:\\work\\site", "C:/work/site/src/A.vue")).toBe("./src/A.vue");
    expect(portableSpecifier("C:\\work\\site", "D:/elsewhere/A.vue")).toBe("D:/elsewhere/A.vue");
    expect(portableSpecifier("/srv/site", "some-package/A.vue")).toBe("some-package/A.vue");
  });
});
