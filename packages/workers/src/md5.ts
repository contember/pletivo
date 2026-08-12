/**
 * MD5, in portable JavaScript.
 *
 * Not a security choice — it is the name of a file. The Bun host derives the
 * project stylesheet's filename from `new Bun.CryptoHasher("md5")` over the bundle
 * text (`css.ts`), so `/assets/styles.<hash>.css` only agrees between the two hosts
 * if the same digest comes out here.
 *
 * Neither host's WebCrypto can be used for it. Bun's `crypto.subtle` rejects `"MD5"`
 * outright ("Unrecognized algorithm name"); workerd accepts it as a non-standard
 * extension. One implementation that runs the same on both is worth more than two
 * code paths, and `test/md5.test.ts` holds it to `Bun.CryptoHasher` byte for byte.
 */

/** Per-round left-rotation amounts. */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** `floor(abs(sin(i + 1)) * 2**32)`, the constants RFC 1321 defines by that formula. */
const SINE = new Uint32Array(64);
for (let i = 0; i < 64; i++) SINE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);

/**
 * The message padded to a whole number of 64-byte blocks: a `0x80` byte, zeroes, and
 * the original bit length as a little-endian 64-bit integer in the last 8 bytes.
 */
function padded(bytes: Uint8Array): DataView {
  const length = ((bytes.length + 8) >> 6 << 6) + 64;
  const block = new Uint8Array(length);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const view = new DataView(block.buffer);
  const bits = bytes.length * 8;
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);
  return view;
}

/** MD5 of a UTF-8 string, lowercase hex. */
export function md5Hex(text: string): string {
  const view = padded(new TextEncoder().encode(text));
  const words = new Uint32Array(16);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let mixed: number;
      let word: number;
      if (i < 16) {
        mixed = (b & c) | (~b & d);
        word = i;
      } else if (i < 32) {
        mixed = (d & b) | (~d & c);
        word = (5 * i + 1) % 16;
      } else if (i < 48) {
        mixed = b ^ c ^ d;
        word = (3 * i + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        word = (7 * i) % 16;
      }
      const sum = (mixed + a + SINE[i] + words[word]) >>> 0;
      const shift = SHIFTS[i];
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(littleEndianHex).join("");
}

/** One state word as the four hex bytes MD5 prints it as, least significant first. */
function littleEndianHex(word: number): string {
  let out = "";
  for (let byte = 0; byte < 4; byte++) {
    out += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}
