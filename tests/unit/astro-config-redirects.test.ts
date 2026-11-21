import { describe, expect, test } from "bun:test";
import { configRedirects, findConfigRedirect } from "@pletivo/core/astro-host/redirects";
import { parseRoute } from "@pletivo/core/router";

const routes = ["index.astro", "about.astro", "blog/[slug].astro"].map(parseRoute);

describe("configRedirects, as Astro's renderRedirect answers a GET", () => {
  test("a destination naming a route keeps the configured status; any other is a 301", () => {
    const { redirects, dynamic } = configRedirects(
      {
        trailingSlash: "ignore",
        redirects: {
          "/a": "/about",
          "/b": { status: 302, destination: "/about" },
          "/c": { status: 302, destination: "/nowhere" },
          "/d/e": "https://example.com/ü",
          "/f/[x]": "/",
        },
      },
      routes,
    );
    expect(redirects).toEqual([
      { source: "/a", parts: ["a"], status: 301, location: "/about" },
      { source: "/b", parts: ["b"], status: 302, location: "/about" },
      { source: "/c", parts: ["c"], status: 301, location: "/nowhere" },
      { source: "/d/e", parts: ["d", "e"], status: 301, location: "https://example.com/%C3%BC" },
    ]);
    expect(dynamic).toEqual(["/f/[x]"]);
    expect(findConfigRedirect(redirects, "/d/e")?.source).toBe("/d/e");
    expect(findConfigRedirect(redirects, "/d")).toBeUndefined();
  });

  test("under trailingSlash always, a named route's URL ends with a slash", () => {
    const { redirects } = configRedirects({ trailingSlash: "always", redirects: { "/a": "/about", "/b": "/", "/c": "/nowhere" } }, routes);
    expect(redirects.map((redirect) => redirect.location)).toEqual(["/about/", "/", "/nowhere"]);
  });
});
