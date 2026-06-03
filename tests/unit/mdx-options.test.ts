import { describe, test, expect } from "bun:test";
import {
  buildRehypePlugins,
  buildRemarkPlugins,
  captureMdxIntegrationOptions,
  MDX_INTEGRATION_OPTIONS_KEY,
  resolveMdxOptions,
} from "../../packages/pletivo/src/mdx-plugin";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

// Distinct, identifiable plugin stand-ins — resolveMdxOptions only concatenates
// them, so plain functions are enough to assert ordering.
const remarkA = () => {};
const remarkB = () => {};
const remarkC = () => {};
const rehypeA = () => {};

const emptyPletivoConfig = {} as PletivoConfig;

describe("captureMdxIntegrationOptions", () => {
  test("extracts remark/rehype plugins exposed by the @astrojs/mdx stub", () => {
    const integration = {
      name: "@astrojs/mdx",
      __pletivoMdxOptions: { remarkPlugins: [remarkA], rehypePlugins: [rehypeA] },
    } as any;
    const captured = captureMdxIntegrationOptions(integration);
    expect(captured?.remarkPlugins).toEqual([remarkA]);
    expect(captured?.rehypePlugins).toEqual([rehypeA]);
    expect(captured?.unsupportedKeys).toEqual([]);
  });

  test("reports options pletivo's native MDX can't honor", () => {
    const integration = {
      name: "@astrojs/mdx",
      __pletivoMdxOptions: { remarkPlugins: [remarkA], gfm: false, optimize: true },
    } as any;
    const captured = captureMdxIntegrationOptions(integration);
    expect(captured?.remarkPlugins).toEqual([remarkA]);
    // `gfm` is honored now, so it's not reported as unsupported.
    expect(captured?.gfm).toBe(false);
    expect(captured?.unsupportedKeys).toEqual(["optimize"]);
  });

  test("ignores nullish unsupported options", () => {
    const integration = {
      name: "@astrojs/mdx",
      __pletivoMdxOptions: { remarkPlugins: [remarkA], gfm: undefined },
    } as any;
    expect(captureMdxIntegrationOptions(integration)?.unsupportedKeys).toEqual([]);
  });

  test("returns null when the integration exposes no options", () => {
    expect(captureMdxIntegrationOptions({ name: "@astrojs/mdx" } as any)).toBeNull();
  });
});

describe("resolveMdxOptions", () => {
  test("merges astro markdown, mdx() integration, and pletivo config in pipeline order", () => {
    const astroConfig = {
      markdown: { remarkPlugins: [remarkA] },
      [MDX_INTEGRATION_OPTIONS_KEY]: { remarkPlugins: [remarkB], rehypePlugins: [] },
    };
    const pletivoConfig = { mdx: { remarkPlugins: [remarkC] } } as PletivoConfig;
    const resolved = resolveMdxOptions(pletivoConfig, astroConfig);
    // top-level markdown → mdx() integration → pletivo config
    expect(resolved.remarkPlugins).toEqual([remarkA, remarkB, remarkC]);
  });

  test("honors plugins forwarded from mdx() even without top-level markdown config", () => {
    const astroConfig = {
      [MDX_INTEGRATION_OPTIONS_KEY]: { remarkPlugins: [remarkB], rehypePlugins: [rehypeA] },
    };
    const resolved = resolveMdxOptions(emptyPletivoConfig, astroConfig);
    expect(resolved.remarkPlugins).toEqual([remarkB]);
    expect(resolved.rehypePlugins).toEqual([rehypeA]);
  });

  test("omits empty plugin arrays", () => {
    const resolved = resolveMdxOptions(emptyPletivoConfig, {});
    expect(resolved.remarkPlugins).toBeUndefined();
    expect(resolved.rehypePlugins).toBeUndefined();
  });

  test("de-duplicates a plugin listed in both markdown and mdx() (runs once)", () => {
    // A meta-framework often puts the same plugin in both markdown.* and mdx().
    const astroConfig = {
      markdown: { remarkPlugins: [remarkA, remarkB] },
      [MDX_INTEGRATION_OPTIONS_KEY]: { remarkPlugins: [remarkA], rehypePlugins: [] },
    };
    const resolved = resolveMdxOptions(emptyPletivoConfig, astroConfig);
    // remarkA appears in both sources but only once in the result, order kept.
    expect(resolved.remarkPlugins).toEqual([remarkA, remarkB]);
  });

  test("gfm defaults on, follows markdown.gfm, and mdx() overrides it", () => {
    expect(resolveMdxOptions(emptyPletivoConfig, {}).gfm).toBe(true);
    expect(resolveMdxOptions(emptyPletivoConfig, { markdown: { gfm: false } }).gfm).toBe(false);
    // mdx({ gfm }) wins over markdown.gfm (mirrors @astrojs/mdx).
    const cfg = {
      markdown: { gfm: false },
      [MDX_INTEGRATION_OPTIONS_KEY]: { remarkPlugins: [], rehypePlugins: [], gfm: true },
    };
    expect(resolveMdxOptions(emptyPletivoConfig, cfg).gfm).toBe(true);
  });
});

// remark-gfm is pletivo's dep, not the root workspace's — recover the reference
// from the plugin buildRemarkPlugins prepends.
const pluginHeadR = (entry: unknown) => (Array.isArray(entry) ? entry[0] : entry);
const remarkGfm = pluginHeadR(buildRemarkPlugins(undefined, true)[0]);

describe("buildRemarkPlugins", () => {
  test("prepends remark-gfm when gfm is enabled", () => {
    const user = () => {};
    const plugins = buildRemarkPlugins([user], true);
    expect(plugins[0]).toBe(remarkGfm);
    expect(plugins[1]).toBe(user);
  });

  test("omits remark-gfm when gfm is disabled", () => {
    const user = () => {};
    const plugins = buildRemarkPlugins([user], false);
    expect(plugins).toEqual([user]);
    expect(plugins).not.toContain(remarkGfm);
  });

  test("does not add a second remark-gfm when the user already configured one", () => {
    // User passes their own remark-gfm (with options) — keep theirs, no double.
    const userGfm: [unknown, Record<string, unknown>] = [remarkGfm, { singleTilde: false }];
    const plugins = buildRemarkPlugins([userGfm as any], true);
    expect(plugins.filter((p) => pluginHeadR(p) === remarkGfm)).toHaveLength(1);
    // The surviving copy is the user's (its options are preserved).
    expect((plugins[0] as [unknown, Record<string, unknown>])[1]).toEqual({ singleTilde: false });
  });
});

// rehype-raw fed to the MDX compiler bare throws on MDX's JSX nodes
// (`mdxJsxFlowElement`). buildRehypePlugins mirrors @astrojs/mdx: a managed
// rehype-raw with `passThrough` runs first, and any bare copy is stripped.
const pluginHead = (entry: unknown) => (Array.isArray(entry) ? entry[0] : entry);
// rehype-raw is pletivo's dep, not the root workspace's, so we can't import it
// here — recover the reference from the managed plugin buildRehypePlugins adds.
const rehypeRaw = pluginHead(buildRehypePlugins(undefined)[0]);

describe("buildRehypePlugins", () => {
  test("always prepends a passThrough-configured rehype-raw", () => {
    const first = buildRehypePlugins(undefined)[0] as [unknown, Record<string, unknown>];
    expect(first[0]).toBe(rehypeRaw);
    expect(first[1].passThrough).toBeDefined();
  });

  test("strips a bare rehype-raw the user forwarded (would crash on MDX)", () => {
    const other = () => {};
    const plugins = buildRehypePlugins([rehypeRaw as any, other]);
    // Exactly one rehype-raw — our managed copy, with passThrough — plus `other`.
    expect(plugins.filter((p) => pluginHead(p) === rehypeRaw)).toHaveLength(1);
    expect((plugins[0] as [unknown, Record<string, unknown>])[1].passThrough).toBeDefined();
    expect(plugins).toContain(other);
  });

  test("strips rehype-raw even when passed with options", () => {
    const plugins = buildRehypePlugins([[rehypeRaw as any, { foo: 1 }]]);
    expect(plugins.filter((p) => pluginHead(p) === rehypeRaw)).toHaveLength(1);
    // The surviving one is the managed copy (passThrough), not the user's {foo:1}.
    expect((plugins[0] as [unknown, Record<string, unknown>])[1].passThrough).toBeDefined();
  });

  test("keeps non-raw user plugins after the managed rehype-raw", () => {
    const a = () => {};
    const b = () => {};
    const plugins = buildRehypePlugins([a, b]);
    expect(plugins.slice(1)).toEqual([a, b]);
  });
});
