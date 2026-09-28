import { describe, expect, test } from "bun:test";
import { md5Hex } from "../src/md5.ts";

/** The digest the Bun host names the stylesheet from. */
function bunMd5(text: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(text);
  return hasher.digest("hex");
}

describe("md5Hex", () => {
  test("matches the RFC 1321 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))
      .toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  test("agrees with Bun.CryptoHasher across every padding boundary", () => {
    // 55/56 and 63/64 are where the length field stops fitting in the last block.
    for (let length = 0; length <= 130; length++) {
      const text = "x".repeat(length);
      expect(md5Hex(text)).toBe(bunMd5(text));
    }
  });

  test("agrees with Bun.CryptoHasher on multi-byte text and real stylesheet bytes", () => {
    const samples = [
      "příliš žluťoučký kůň\n",
      "\u{1f600}\u{1f680}",
      "/* styles/local.css */\n.local-side-effect-css {\n  color: rgb(4, 5, 6);\n}\n",
      ".a{color:red}\n".repeat(500),
    ];
    for (const sample of samples) expect(md5Hex(sample)).toBe(bunMd5(sample));
  });
});
