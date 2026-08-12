import { afterAll, describe, expect, test } from "bun:test";
import { imageContentHash, readImageDimensions } from "@pletivo/core/image";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { ContentFiles, probeImage, type ProjectAssets } from "../src/content-files.ts";
import { imageAssets, serveImage, withoutCdnCgi } from "../src/images.ts";
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
  test("the host answers with four derived fields, not with the file", () => {
    const files = new ContentFiles();
    const handle = files.open(new Map(), new Map([["src/assets/logo.png", PNG_4x4]]));

    const info = files.image(handle.ref, "src/assets/logo.png");
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

  test("two renders in flight see their own assets", () => {
    const other = Uint8Array.from(PNG_4x4);
    // A different last byte is a different hash and therefore a different output name.
    other[other.length - 1] ^= 0xff;
    const files = new ContentFiles();
    const first = files.open(new Map(), new Map([["logo.png", PNG_4x4]]));
    const second = files.open(new Map(), new Map([["logo.png", other]]));

    expect(files.image(first.ref, "logo.png")?.hash).toBe(imageContentHash(PNG_4x4));
    expect(files.image(second.ref, "logo.png")?.hash).toBe(imageContentHash(other));

    first.close();
    second.close();
  });
});

describe("probing", () => {
  test("the same bytes are read once, however many entries name them", () => {
    const first = probeImage(PNG_4x4, "logo.png");
    const second = probeImage(PNG_4x4, "logo.png");
    // Identity, not equality: the second call did not re-read or re-hash anything.
    expect(second).toBe(first);
  });

  test("the cache is keyed by the bytes, so replacing a file cannot be missed", () => {
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

function contentAccess(): { binding: ContentFiles; store: ContentFiles } {
  const files = new ContentFiles();
  return { binding: files, store: files };
}

async function render(
  files: Map<string, string>,
  assets: ProjectAssets,
  pathname = "/",
): Promise<string> {
  const page = await renderPage({
    files,
    assets,
    pathname,
    loader,
    compiler,
    content: contentAccess(),
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
    const served = serveImage(
      `/cdn-cgi/image/onerror=redirect,width=2,height=2,format=auto${OUTPUT}`,
      new Map([["src/assets/logo.png", PNG_4x4]]),
    );
    expect(served?.bytes).toBe(PNG_4x4);
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
  test("every image in the map has a URL, whether or not a page linked to it", () => {
    const routes = imageAssets(new Map([["src/assets/logo.png", PNG_4x4]]));
    expect([...routes.keys()]).toEqual([OUTPUT]);
    expect(routes.get(OUTPUT)?.source).toBe("src/assets/logo.png");
  });

  test("a manifest-backed asset still has a URL, and says the bytes are elsewhere", () => {
    const routes = imageAssets(
      new Map([["src/assets/logo.png", { width: 4, height: 4, format: "png", hash: HASH }]]),
    );
    expect(routes.get(OUTPUT)?.bytes).toBeNull();
  });

  test("a cdn-cgi URL resolves to the file it names", () => {
    expect(withoutCdnCgi(`/cdn-cgi/image/width=200,format=auto${OUTPUT}`)).toBe(OUTPUT);
    expect(withoutCdnCgi(OUTPUT)).toBe(OUTPUT);
    // Not one of ours: left alone rather than mangled into a lookup that would hit.
    expect(withoutCdnCgi("/cdn-cgi/image/")).toBe("/cdn-cgi/image/");
  });

  test("a file this host has never heard of is null, not a guess", () => {
    expect(serveImage("/_astro/other.00000000.png", new Map([["a.png", PNG_4x4]]))).toBeNull();
  });
});
