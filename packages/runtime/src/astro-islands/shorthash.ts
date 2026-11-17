/**
 * Astro's island uid hash (`runtime/server/shorthash.ts`), itself node-shorthash by
 * Bibig (MIT): a Java-style 32-bit string hash written in base 61, `Z`-prefixed when
 * negative. The uid must match Astro's byte for byte, so this is a literal port.
 */
const dictionary = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXY";
const binary = dictionary.length;

function bitwise(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

export function shorthash(text: string): string {
  let integer = bitwise(text);
  const sign = integer < 0 ? "Z" : "";
  integer = Math.abs(integer);
  let result = "";
  while (integer >= binary) {
    result = dictionary[integer % binary] + result;
    integer = Math.floor(integer / binary);
  }
  if (integer > 0) result = dictionary[integer] + result;
  return sign + result;
}
