#!/usr/bin/env bun
import { registerAstroPlugin } from "../../packages/pavouk/src/astro-plugin";
import { renderAstroPage, isAstroComponent } from "../../packages/pavouk/src/runtime/astro-shim";

await registerAstroPlugin();

const mod = await import("./hello.astro");

if (!isAstroComponent(mod.default)) {
  console.error("FAIL: default export is not an Astro component");
  console.error("got:", mod.default);
  process.exit(1);
}

const html = await renderAstroPage(mod.default, { name: "pavouk" });
console.log(html);
console.log("\n--- assertions ---");

const expectations = [
  { desc: "title contains name", pass: html.includes("<title>Hello pavouk</title>") },
  { desc: "h1 contains greeting", pass: html.includes("<h1>Hello, pavouk!</h1>") },
  { desc: "ul has 3 li", pass: (html.match(/<li>/g) || []).length === 3 },
  { desc: "first li is apple", pass: html.includes("<li>apple</li>") },
  { desc: "Fragment set:html renders raw", pass: html.includes("<p>raw <em>html</em></p>") },
];

let allPass = true;
for (const e of expectations) {
  console.log(`${e.pass ? "✓" : "✗"} ${e.desc}`);
  if (!e.pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
