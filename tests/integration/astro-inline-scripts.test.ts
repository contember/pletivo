import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

interface BuiltScripts {
  html: string;
  /** Bodies of inline module scripts. */
  inline: string[];
  /** Contents of linked hoisted bundles, read from dist. */
  linked: string[];
}

async function readScripts(distDir: string, page: string): Promise<BuiltScripts> {
  const html = await Bun.file(path.join(distDir, page)).text();
  const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const linked: string[] = [];
  for (const m of html.matchAll(/<script type="module" src="\/_astro\/(hoisted-[a-f0-9]+\.js)"><\/script>/g)) {
    linked.push(await Bun.file(path.join(distDir, "_astro", m[1])).text());
  }
  return { html, inline, linked };
}

function useFixture(name: string): { distDir: string; scripts: () => BuiltScripts } {
  const fixtureRoot = path.join(import.meta.dir, "..", name);
  const distDir = path.join(fixtureRoot, "dist");
  let built: BuiltScripts | undefined;
  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    built = await readScripts(distDir, "index.html");
  });
  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });
  return {
    distDir,
    scripts: () => {
      if (!built) throw new Error(`${name} was not built`);
      return built;
    },
  };
}

function withMarker(codes: string[], marker: string): string[] {
  return codes.filter((code) => code.includes(marker));
}

/** Astro inlines a processed script whose bundle imports nothing and passes `assetsInlineLimit` (4096 B). */
describe("astro <script> inlining", () => {
  const { distDir, scripts } = useFixture("fixture-astro-inline-scripts");

  test("a small script with no imports is inlined, bundled and TS-stripped", () => {
    const small = withMarker(scripts().inline, "small-script-marker");
    expect(small).toHaveLength(1);
    expect(small[0]).not.toContain(": string");
  });

  test("an inlined script leaves no file behind", async () => {
    const files = await fs.readdir(path.join(distDir, "_astro"));
    const contents = await Promise.all(files.map((file) => Bun.file(path.join(distDir, "_astro", file)).text()));
    expect(contents.some((code) => code.includes("small-script-marker"))).toBe(false);
  });

  test("a script of 4096 B or more stays linked", () => {
    expect(withMarker(scripts().inline, "large-script-marker")).toHaveLength(0);
    expect(withMarker(scripts().linked, "large-script-marker")).toHaveLength(1);
  });

  test("a script whose bundle still imports stays linked", () => {
    expect(withMarker(scripts().inline, "remote-script-marker")).toHaveLength(0);
    expect(withMarker(scripts().linked, "remote-script-marker")).toHaveLength(1);
  });

  test("a component rendered twice on a page emits its script once", () => {
    expect(withMarker(scripts().inline, "counter-script-marker")).toHaveLength(1);
    expect(withMarker(scripts().linked, "counter-script-marker")).toHaveLength(0);
  });

  test("a slot probed with Astro.slots.render() and rendered again keeps its script", () => {
    expect(withMarker(scripts().inline, "slot-probe-marker")).toHaveLength(1);
  });

  test("a bundle holding </script stays linked", () => {
    expect(withMarker(scripts().inline, "close-tag-marker")).toHaveLength(0);
    const linked = withMarker(scripts().linked, "close-tag-marker");
    expect(linked).toHaveLength(1);
    expect(linked[0]).toContain("</script>");
  });

  test("a bundle holding <!-- stays linked", () => {
    expect(withMarker(scripts().inline, "comment-marker")).toHaveLength(0);
    expect(withMarker(scripts().linked, "comment-marker")).toHaveLength(1);
  });

  test("a bundle that mentions import.meta stays linked", () => {
    expect(withMarker(scripts().inline, "import-meta-marker")).toHaveLength(0);
    expect(withMarker(scripts().linked, "import-meta-marker")).toHaveLength(1);
  });

  test("an empty bundle drops its tag", () => {
    const markers = [
      "small-script-marker",
      "large-script-marker",
      "remote-script-marker",
      "counter-script-marker",
      "slot-probe-marker",
      "endpoint-widget-marker",
      "close-tag-marker",
      "comment-marker",
      "import-meta-marker",
    ];
    const all = [...scripts().inline, ...scripts().linked];
    expect(all).toHaveLength(markers.length);
    for (const code of all) {
      expect(markers.some((marker) => code.includes(marker))).toBe(true);
    }
  });

  test("a script an endpoint links keeps its file, and pages still inline it", async () => {
    expect(withMarker(scripts().inline, "endpoint-widget-marker")).toHaveLength(1);
    const endpoint = await readScripts(distDir, "widget.html");
    expect(endpoint.inline).toHaveLength(0);
    expect(withMarker(endpoint.linked, "endpoint-widget-marker")).toHaveLength(1);
  });
});

describe("astro <script> inlining with vite.build.assetsInlineLimit: 0", () => {
  const { scripts } = useFixture("fixture-astro-inline-scripts-limit-zero");

  test("a small script stays linked", () => {
    expect(scripts().inline).toHaveLength(0);
    expect(withMarker(scripts().linked, "limit-zero-marker")).toHaveLength(1);
  });
});

describe("astro <script> inlining with a function vite.build.assetsInlineLimit", () => {
  const { scripts } = useFixture("fixture-astro-inline-scripts-limit-fn");

  test("false keeps a small script linked", () => {
    expect(withMarker(scripts().inline, "fn-linked-marker")).toHaveLength(0);
    expect(withMarker(scripts().linked, "fn-linked-marker")).toHaveLength(1);
  });

  test("true inlines a script over 4096 B", () => {
    expect(withMarker(scripts().inline, "fn-inlined-marker")).toHaveLength(1);
  });

  test("undefined falls back to 4096 B", () => {
    expect(withMarker(scripts().inline, "fn-default-marker")).toHaveLength(1);
  });
});
