import { describe, expect, test } from "bun:test";
import { escapeStyleEnd } from "@pletivo/core/inline-style";

describe("escapeStyleEnd", () => {
  test("escapes every `</style`, in any case, keeping the matched case", () => {
    expect(escapeStyleEnd('a::after{content:"</style>"}/* </STYLE */b::after{content:"</StYlE"}'))
      .toBe('a::after{content:"<\\/style>"}/* <\\/STYLE */b::after{content:"<\\/StYlE"}');
  });

  test("leaves CSS without a style end tag unchanged", () => {
    for (const css of ["", ".a{color:red}", 'a::after{content:"</div></styl <style>"}', "a::after{content:'<\\/style'}"]) {
      expect(escapeStyleEnd(css)).toBe(css);
    }
  });
});
