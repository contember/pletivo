#!/usr/bin/env bun
import { registerAstroPlugin } from "../../packages/pletivo/src/astro-plugin";
import { renderAstroPage } from "../../packages/pletivo/src/runtime/astro-shim";

await registerAstroPlugin();

const mod = await import("./page.astro");
const html = await renderAstroPage(mod.default, {});
console.log(html);
console.log("\n--- assertions ---");

const checks = [
  { d: "Layout title", p: html.includes("<title>Blog</title>") },
  { d: "header rendered", p: html.includes("<header>Site Header</header>") },
  { d: "footer rendered", p: html.includes("<footer>Site Footer</footer>") },
  { d: "slot content: h1", p: html.includes("<h1>My Blog</h1>") },
  { d: "first post link", p: html.includes('<a href="/posts/1">First post</a>') },
  { d: "second post link", p: html.includes('<a href="/posts/2">Second post</a>') },
];

let ok = true;
for (const c of checks) {
  console.log(`${c.p ? "✓" : "✗"} ${c.d}`);
  if (!c.p) ok = false;
}
process.exit(ok ? 0 : 1);
