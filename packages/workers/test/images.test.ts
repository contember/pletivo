import { afterAll, describe, expect, test } from "bun:test";
import { imageContentHash, readImageDimensions } from "@pletivo/core/image";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import {
  ContentFiles,
  createProjectAssetsView,
  probeImage,
  ProjectAssetOutputAmbiguityError,
  type ProjectAssets,
} from "../src/content-files.ts";
import { serveImage, withoutCdnCgi } from "../src/images.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

/**
 * Images on the Workers host.
 *
 * `test/fixture-images` is where the rendered bytes are compared against
 * `pletivo build`. What is here is the part parity cannot show: that the image bytes
 * stay on the host, what crosses the binding instead, and that a URL a page emits
 * names something the host can actually serve.
 */

/** A 4×4 PNG, the same one `tests/fixture-image` uses. Real bytes, so the header is real. */
export const PNG_4x4 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z4A" +
      "AjEwMDAwMDAwMDAAOKgIBIfBvXQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

describe("what crosses the content binding for an image", () => {
  test("the host answers with four derived fields, not with the file", async () => {
    const files = new ContentFiles();
    const handle = files.open(new Map(), new Map([["src/assets/logo.png", PNG_4x4]]));

    const info = await files.image(handle.ref, "src/assets/logo.png");
    expect(info).toEqual({ width: 4, height: 4, format: "png", hash: imageContentHash(PNG_4x4) });
    // Whatever else grows on this binding, the payload stays a handful of bytes: a
    // 200-entry collection asks once per entry, per render.
    expect(JSON.stringify(info).length).toBeLessThan(80);

    handle.close();
  });

  test("a path the project has no bytes for is null, not a throw", () => {
    const files = new ContentFiles();
    const handle = files.open(new Map(), new Map());
    expect(files.image(handle.ref, "src/assets/missing.png")).toBeNull();
    handle.close();
  });

  test("a render that was handed no assets at all still opens", () => {
    const files = new ContentFiles();
    const handle = files.open(new Map([["a.md", "x"]]));
    expect(files.image(handle.ref, "src/assets/logo.png")).toBeNull();
    handle.close();
  });

  test("closing a handle drops its assets with its files", () => {
    const files = new ContentFiles();
    const handle = files.open(new Map(), new Map([["logo.png", PNG_4x4]]));
    handle.close();
    expect(() => files.image(handle.ref, "logo.png")).toThrow(/already finished/);
  });

  test("two renders in flight see their own assets", async () => {
    const other = Uint8Array.from(PNG_4x4);
    // A different last byte is a different hash and therefore a different output name.
    other[other.length - 1] ^= 0xff;
    const files = new ContentFiles();
    const first = files.open(new Map(), new Map([["logo.png", PNG_4x4]]));
    const second = files.open(new Map(), new Map([["logo.png", other]]));

    expect((await files.image(first.ref, "logo.png"))?.hash).toBe(imageContentHash(PNG_4x4));
    expect((await files.image(second.ref, "logo.png"))?.hash).toBe(imageContentHash(other));

    first.close();
    second.close();
  });

  test("two stores with the same ref keep project assets isolated", async () => {
    const leftStore = new ContentFiles();
    const rightStore = new ContentFiles();
    const left = leftStore.open(
      new Map(),
      new Map([["logo.png", { width: 1, height: 1, format: "png", hash: "11111111" }]]),
    );
    const right = rightStore.open(
      new Map(),
      new Map([["logo.png", { width: 2, height: 2, format: "png", hash: "22222222" }]]),
    );

    expect(left.ref).toBe(right.ref);
    expect((await leftStore.image(left.ref, "logo.png"))?.width).toBe(1);
    expect((await rightStore.image(right.ref, "logo.png"))?.width).toBe(2);
    left.close();
    right.close();
  });
});

describe("probing", () => {
  test("a project view probes one source once", () => {
    let probes = 0;
    const view = createProjectAssetsView(
      new Map([["logo.png", PNG_4x4]]),
      (bytes, path) => {
        probes++;
        return probeImage(bytes, path);
      },
    );
    const first = view.info("logo.png");
    const second = view.info("logo.png");
    expect(second).toBe(first);
    expect(probes).toBe(1);
  });

  test("replacing bytes produces fresh metadata", () => {
    const before = probeImage(PNG_4x4, "logo.png");
    const after = probeImage(Uint8Array.from(PNG_4x4).fill(0, 20, 24), "logo.png");
    expect(after).not.toBe(before);
    expect(after.hash).not.toBe(before.hash);
  });

  test("the hash is what names the output file", () => {
    expect(imageContentHash(PNG_4x4)).toBe(new Bun.CryptoHasher("md5").update(PNG_4x4).digest("hex").slice(0, 8));
  });

  test("a file that is not an image says so by name", () => {
    expect(() => readImageDimensions(new TextEncoder().encode("not an image"), "notes.txt")).toThrow(
      /Unsupported image format: notes\.txt/,
    );
  });
});

// ── End to end, on Bun: what a page actually renders ──────────────────

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const HASH = imageContentHash(PNG_4x4);
const OUTPUT = `/_astro/logo.${HASH}.png`;
const EXECUTION_NAMESPACE = { tenant: "image-tests", capabilityGeneration: "content-v1" };

const CONTENT_FILES = new ContentFiles();

function contentAccess(): { binding: ContentFiles; store: ContentFiles } {
  return { binding: CONTENT_FILES, store: CONTENT_FILES };
}

async function render(
  files: Map<string, string>,
  assets: ProjectAssets,
  pathname = "/",
): Promise<string> {
  const page = await renderPage({
    files,
    assets: createProjectAssetsView(assets),
    pathname,
    loader,
    compiler,
    content: contentAccess(),
    executionNamespace: EXECUTION_NAMESPACE,
  });
  return page.html;
}

describe("astro:assets in the isolate", () => {
  test("an ESM-imported image resolves to the metadata the Bun host's loader produces", async () => {
    const html = await render(
      new Map([
        [
          "src/pages/index.astro",
          `---
import logo from "../assets/logo.png";
---
<img src={logo.src} width={logo.width} height={logo.height} data-format={logo.format} />
`,
        ],
      ]),
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(html).toContain(`src="${OUTPUT}"`);
    expect(html).toContain('width="4"');
    expect(html).toContain('data-format="png"');
  });

  test("<Image> emits a URL that names the transform instead of faking it", async () => {
    const html = await render(
      new Map([
        [
          "src/pages/index.astro",
          `---
import { Image } from "astro:assets";
import logo from "../assets/logo.png";
---
<Image src={logo} alt="a logo" width={2} />
`,
        ],
      ]),
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    // The Cloudflare service: the options are named, the source is the real file.
    expect(html).toContain(
      `<img src="/cdn-cgi/image/onerror=redirect,width=2,height=2,format=auto${OUTPUT}"`,
    );
    expect(html).toContain('alt="a logo"');
    // …and that URL leads back to bytes this host holds.
    const served = await serveImage(
      `/cdn-cgi/image/onerror=redirect,width=2,height=2,format=auto${OUTPUT}`,
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(served?.bytes).toEqual(PNG_4x4);
    expect(served?.bytes).not.toBe(PNG_4x4);
    expect(served?.contentType).toBe("image/png");
  });

  test("<Image> with widths emits a srcset, which the sharp service silently drops", async () => {
    const html = await render(
      new Map([
        [
          "src/pages/index.astro",
          `---
import { Image } from "astro:assets";
import logo from "../assets/logo.png";
---
<Image src={logo} alt="" widths={[2, 4]} />
`,
        ],
      ]),
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(html).toContain(`srcset="/cdn-cgi/image/onerror=redirect,width=2,format=auto${OUTPUT} 2w`);
    expect(html).toContain(`width=4,format=auto${OUTPUT} 4w"`);
  });

  test("<Picture> emits one <source> per format, and a fallback <img>", async () => {
    const html = await render(
      new Map([
        [
          "src/pages/index.astro",
          `---
import { Picture } from "astro:assets";
import logo from "../assets/logo.png";
---
<Picture src={logo} alt="a logo" formats={["webp"]} width={2} />
`,
        ],
      ]),
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(html).toContain("<picture>");
    expect(html).toContain('type="image/webp"');
    // The fallback is Astro's own default for a PNG source, and it names that format
    // in the URL rather than pretending a conversion happened.
    expect(html).toContain(`format=png${OUTPUT}"`);
    expect(html).toContain('alt="a logo"');
  });

  test("a missing alt fails the page rather than rendering a nameless image", async () => {
    const files = new Map([
      [
        "src/pages/index.astro",
        `---
import { Image } from "astro:assets";
import logo from "../assets/logo.png";
---
<Image src={logo} />
`,
      ],
    ]);
    expect(render(files, new Map([["src/assets/logo.png", PNG_4x4]]))).rejects.toThrow(
      /alt/,
    );
  });

  test("a project that never names astro:assets carries none of it", async () => {
    const html = await render(new Map([["src/pages/index.astro", "<p>hi</p>\n"]]), new Map());
    expect(html).toContain("<p>hi</p>");
  });
});

describe("image() in a collection schema", () => {
  const CONFIG = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  items: defineCollection({
    loader: glob({ base: "src/content/items", pattern: "**/*.md" }),
    schema: ({ image }) => z.object({ title: z.string(), logo: image() }),
  }),
};
`;
  const INDEX = `---
import { getCollection } from "astro:content";
const items = await getCollection("items");
---
<ul>{items.map((item) => <li data-src={item.data.logo.src} data-w={item.data.logo.width}>{item.data.title}</li>)}</ul>
`;

  test("an entry's image resolves through the binding, against the entry's own directory", async () => {
    const html = await render(
      new Map([
        ["src/content.config.ts", CONFIG],
        ["src/pages/index.astro", INDEX],
        ["src/content/items/one.md", "---\ntitle: One\nlogo: ../../assets/logo.png\n---\n\nbody\n"],
      ]),
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(html).toContain(`data-src="${OUTPUT}"`);
    expect(html).toContain('data-w="4"');
    expect(html).toContain("One");
  });

  test("a host holding a manifest instead of the file answers the same", async () => {
    const html = await render(
      new Map([
        ["src/content.config.ts", CONFIG],
        ["src/pages/index.astro", INDEX],
        ["src/content/items/one.md", "---\ntitle: One\nlogo: ../../assets/logo.png\n---\n\nbody\n"],
      ]),
      // What a real host keeps: a row per file, not 200 MiB of photographs.
      new Map([["src/assets/logo.png", { width: 4, height: 4, format: "png", hash: HASH }]]),
    );
    expect(html).toContain(`data-src="${OUTPUT}"`);
  });

  test("an image the host has no bytes for fails validation, and drops its entry", async () => {
    const html = await render(
      new Map([
        ["src/content.config.ts", CONFIG],
        ["src/pages/index.astro", INDEX],
        ["src/content/items/one.md", "---\ntitle: One\nlogo: ./nope.png\n---\n\nbody\n"],
      ]),
      new Map(),
    );
    expect(html).not.toContain("One");
  });
});

describe("what the host has to serve", () => {
  test("owns byte values after view creation", async () => {
    const callerBytes = Uint8Array.from(PNG_4x4);
    const ownedBytes = Uint8Array.from(callerBytes);
    const hash = imageContentHash(ownedBytes);
    const output = `/_astro/logo.${hash}.png`;
    const view = createProjectAssetsView(new Map([["src/assets/logo.png", callerBytes]]));

    callerBytes.fill(0);

    expect(await view.info("src/assets/logo.png")).toEqual({
      width: 4,
      height: 4,
      format: "png",
      hash,
    });
    const served = await view.resolveOutput(output);
    expect(served?.bytes).toEqual(ownedBytes);
    expect(served?.bytes).not.toBe(callerBytes);
  });

  test("a page-like unmatched pathname probes no images", async () => {
    const probed: string[] = [];
    const view = createProjectAssetsView(
      new Map([
        ["src/assets/logo.png", PNG_4x4],
        ["src/assets/other.png", Uint8Array.from(PNG_4x4)],
      ]),
      (bytes, path) => {
        probed.push(path);
        return probeImage(bytes, path);
      },
    );

    expect(await view.resolveOutput("/docs/page/")).toBeNull();
    expect(probed).toEqual([]);
  });

  test("one image pathname probes only its candidate and caches the result", async () => {
    const probed: string[] = [];
    const view = createProjectAssetsView(
      new Map([
        ["src/assets/logo.png", PNG_4x4],
        ["src/assets/other.png", Uint8Array.from(PNG_4x4)],
      ]),
      (bytes, path) => {
        probed.push(path);
        return probeImage(bytes, path);
      },
    );

    const first = await view.resolveOutput(OUTPUT);
    const second = await view.resolveOutput(OUTPUT);
    expect(first?.source).toBe("src/assets/logo.png");
    expect(second).toBe(first);
    expect(probed).toEqual(["src/assets/logo.png"]);
  });

  test("probes one same-basename bucket and distinguishes hashes", async () => {
    const firstBytes = Uint8Array.from(PNG_4x4);
    const secondBytes = Uint8Array.from(PNG_4x4);
    secondBytes[secondBytes.length - 1] ^= 0xff;
    const firstOutput = `/_astro/logo.${imageContentHash(firstBytes)}.png`;
    const secondOutput = `/_astro/logo.${imageContentHash(secondBytes)}.png`;
    const probed: string[] = [];
    const view = createProjectAssetsView(
      new Map([
        ["a/logo.png", firstBytes],
        ["b/logo.png", secondBytes],
        ["c/other.png", PNG_4x4],
      ]),
      (bytes, path) => {
        probed.push(path);
        return probeImage(bytes, path);
      },
    );

    expect((await view.resolveOutput(firstOutput))?.source).toBe("a/logo.png");
    expect(probed).toEqual(["a/logo.png", "b/logo.png"]);
    expect((await view.resolveOutput(secondOutput))?.source).toBe("b/logo.png");
    expect(probed).toEqual(["a/logo.png", "b/logo.png"]);
    expect(await view.resolveOutput("/_astro/logo.00000000.png")).toBeNull();
    expect(await view.resolveOutput("/_astro/logo.00000000.png")).toBeNull();
    expect(probed).toEqual(["a/logo.png", "b/logo.png"]);
  });

  test("rejects and caches an exact output collision", () => {
    const probed: string[] = [];
    const view = createProjectAssetsView(
      new Map([
        ["b/logo.png", Uint8Array.from(PNG_4x4)],
        ["a/logo.png", Uint8Array.from(PNG_4x4)],
      ]),
      (bytes, path) => {
        probed.push(path);
        return probeImage(bytes, path);
      },
    );

    expectAssetAmbiguity(() => view.resolveOutput(OUTPUT), ["a/logo.png", "b/logo.png"]);
    expectAssetAmbiguity(() => view.resolveOutput(OUTPUT), ["a/logo.png", "b/logo.png"]);
    expect(probed).toEqual(["a/logo.png", "b/logo.png"]);
  });

  test("rejects an exact metadata-only output collision", () => {
    const metadata = { width: 4, height: 4, format: "png", hash: HASH };
    const view = createProjectAssetsView(
      new Map([
        ["a/logo.png", metadata],
        ["b/logo.png", { ...metadata }],
      ]),
    );

    expectAssetAmbiguity(() => view.resolveOutput(OUTPUT), ["a/logo.png", "b/logo.png"]);
  });

  test("a manifest-backed result preserves metadata without pretending to have bytes", async () => {
    const view = createProjectAssetsView(
      new Map([["src/assets/logo.png", { width: 4, height: 4, format: "png", hash: HASH }]]),
    );
    const served = await view.resolveOutput(OUTPUT);
    expect(served?.source).toBe("src/assets/logo.png");
    expect(served?.bytes).toBeNull();
  });

  test("a cdn-cgi URL resolves to the file it names", () => {
    expect(withoutCdnCgi(`/cdn-cgi/image/width=200,format=auto${OUTPUT}`)).toBe(OUTPUT);
    expect(withoutCdnCgi(OUTPUT)).toBe(OUTPUT);
    // Not one of ours: left alone rather than mangled into a lookup that would hit.
    expect(withoutCdnCgi("/cdn-cgi/image/")).toBe("/cdn-cgi/image/");
  });

  test("a file this host has never heard of is null, not a guess", async () => {
    expect(
      await serveImage("/_astro/other.00000000.png", new Map([["a.png", PNG_4x4]])),
    ).toBeNull();
  });
});

function expectAssetAmbiguity(resolve: () => unknown, sources: readonly string[]): void {
  try {
    resolve();
    throw new Error("expected an asset ambiguity");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectAssetOutputAmbiguityError);
    if (!(error instanceof ProjectAssetOutputAmbiguityError)) throw error;
    expect(error.sources).toEqual(sources);
  }
}
