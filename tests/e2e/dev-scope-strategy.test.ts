import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

// The dev server compiles an Astro project's `.astro` with Astro's default
// `attribute` strategy too, and still finds each component's scoped CSS.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-scope-strategy");

let server: DevServer | undefined;
let BASE: string;

beforeAll(async () => {
  server = await startDevServer({ cwd: fixtureRoot, args: ["--no-restart"] });
  BASE = server.url;
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

describe("dev server - scoped style strategy", () => {
  test("serves data-astro-cid markup with its attribute-scoped CSS", async () => {
    const html = await (await fetch(BASE + "/")).text();
    const cardScope = html.match(/<p class="card" data-astro-cid-([a-z0-9]+)>/)?.[1];
    expect(cardScope).toBeDefined();
    expect(html).toContain(`.card[data-astro-cid-${cardScope}]`);
    expect(html).not.toContain(":where(");
  });
});

describe("dev server - doctype", () => {
  test("gives a page Astro's doctype under the default compressHTML", async () => {
    expect(await (await fetch(BASE + "/")).text()).toStartWith("<!DOCTYPE html><");
  });

  test("gives a partial none", async () => {
    expect(await (await fetch(BASE + "/partial")).text()).toStartWith("<p>part</p>");
  });
});
