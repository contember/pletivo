/**
 * MD5, in portable JavaScript.
 *
 * The implementation moved to `@pletivo/core/md5` when the Workers host stopped being
 * the only thing that needed it: an image's output name is `md5(bytes)` on both hosts,
 * and the Bun host reaches the same digest through `Bun.CryptoHasher`. This re-export
 * is kept because `project-css.ts` and `test/md5.test.ts` — which holds the pure-JS
 * version to `Bun.CryptoHasher` across every padding boundary — name it here.
 */

export { md5Hex } from "@pletivo/core/md5";
