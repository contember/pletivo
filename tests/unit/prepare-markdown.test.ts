import { describe, expect, test } from "bun:test";
import { PORTABLE_MODULE } from "@pletivo/core/artifact";
import { freezeMarkdown } from "../../packages/pletivo/src/prepare/markdown";

function tagged(module: string, exportName: string): () => void {
  const plugin = () => {};
  Reflect.set(plugin, PORTABLE_MODULE, { module, export: exportName });
  return plugin;
}

describe("freezeMarkdown", () => {
  test("leaves a default config out of the artifact", () => {
    expect(freezeMarkdown({ remarkPlugins: [], rehypePlugins: [], gfm: true })).toEqual({ config: null, diagnostics: [] });
    expect(freezeMarkdown(undefined)).toEqual({ config: null, diagnostics: [] });
  });

  test("keeps plugin order and the options of a [plugin, options] tuple", () => {
    const frozen = freezeMarkdown({
      remarkPlugins: [tagged("pkg/remark", "first"), [tagged("pkg/remark", "second"), { depth: 2 }]],
      gfm: false,
    });
    expect(frozen.diagnostics).toEqual([]);
    expect(frozen.config).toEqual({
      remarkPlugins: [
        { module: "pkg/remark", export: "first" },
        { module: "pkg/remark", export: "second", options: { depth: 2 } },
      ],
      rehypePlugins: [],
      gfm: false,
    });
  });

  test("refuses an untagged plugin, options that are not JSON, and a relative module", () => {
    const frozen = freezeMarkdown({
      remarkPlugins: [function untagged() {}, [tagged("pkg", "withHandler"), { handler: () => {} }]],
      rehypePlugins: [tagged("./local.js", "local")],
    });
    expect(frozen.config).toBeNull();
    expect(frozen.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual([
      expect.stringContaining("markdown.remarkPlugins[0] (untagged) is a live function"),
      expect.stringContaining("options.handler cannot be carried"),
      expect.stringContaining("must be a bare specifier"),
    ]);
  });
});
