import { describe, test, expect } from "bun:test";
import {
  defineStyleVars,
  defineScriptVars,
  addAttribute,
} from "../../packages/pletivo/src/runtime/astro-shim";

describe("defineStyleVars", () => {
  test("single object generates CSS custom properties", () => {
    const result = defineStyleVars([{ color: "red", size: "10px" }]);
    expect(result.__html).toBe("--color: red;--size: 10px;");
  });

  test("multiple objects are merged", () => {
    const result = defineStyleVars([{ a: "1" }, { b: "2" }]);
    expect(result.__html).toBe("--a: 1;--b: 2;");
  });

  test("non-array input is wrapped", () => {
    const result = defineStyleVars({ color: "blue" });
    expect(result.__html).toBe("--color: blue;");
  });

  test("null and undefined values are skipped", () => {
    const result = defineStyleVars([{ a: "1", b: null, c: undefined, d: "4" }]);
    expect(result.__html).toBe("--a: 1;--d: 4;");
  });

  test("false is skipped", () => {
    const result = defineStyleVars([{ a: false as unknown as string }]);
    expect(result.__html).toBe("");
  });

  test("zero is preserved", () => {
    const result = defineStyleVars([{ gap: 0 as unknown as string }]);
    expect(result.__html).toBe("--gap: 0;");
  });

  test("empty string is skipped", () => {
    const result = defineStyleVars([{ a: "" }]);
    expect(result.__html).toBe("");
  });

  test("result works as style attribute via addAttribute", () => {
    const vars = defineStyleVars([{ color: "red" }]);
    const attr = addAttribute(vars, "style");
    expect(attr.__html).toBe(' style="--color: red;"');
  });
});

describe("defineScriptVars", () => {
  test("generates const declarations", () => {
    const result = defineScriptVars({ name: "world", count: 42 });
    expect(result.__html).toContain('const name = "world";\n');
    expect(result.__html).toContain("const count = 42;\n");
  });

  test("escapes </script> in values", () => {
    const result = defineScriptVars({ html: "</script>" });
    expect(result.__html).toContain("\\x3C/script>");
    expect(result.__html).not.toContain("</script>");
  });

  test("handles objects and arrays", () => {
    const result = defineScriptVars({ items: [1, 2, 3], config: { a: true } });
    expect(result.__html).toContain("const items = [1,2,3];\n");
    expect(result.__html).toContain('const config = {"a":true};\n');
  });

  test("handles null values", () => {
    const result = defineScriptVars({ x: null });
    expect(result.__html).toBe("const x = null;\n");
  });
});
