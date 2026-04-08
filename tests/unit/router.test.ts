import { describe, test, expect } from "bun:test";
import { parseRoute, matchRoute, routeToOutputPath, findRoute } from "../../packages/pavouk/src/router";

describe("parseRoute", () => {
  test("static index page", () => {
    const route = parseRoute("index.tsx");
    expect(route.file).toBe("index.tsx");
    expect(route.segments).toEqual([]);
    expect(route.isDynamic).toBe(false);
  });

  test("static page", () => {
    const route = parseRoute("about.tsx");
    expect(route.segments).toEqual([{ type: "static", value: "about" }]);
    expect(route.isDynamic).toBe(false);
    expect(route.priority).toBe(1);
  });

  test("nested static page", () => {
    const route = parseRoute("blog/index.tsx");
    expect(route.segments).toEqual([{ type: "static", value: "blog" }]);
    expect(route.isDynamic).toBe(false);
  });

  test("deeply nested page", () => {
    const route = parseRoute("docs/guides/intro.tsx");
    expect(route.segments).toEqual([
      { type: "static", value: "docs" },
      { type: "static", value: "guides" },
      { type: "static", value: "intro" },
    ]);
    expect(route.priority).toBe(3);
  });

  test("named param", () => {
    const route = parseRoute("blog/[slug].tsx");
    expect(route.segments).toEqual([
      { type: "static", value: "blog" },
      { type: "param", value: "slug" },
    ]);
    expect(route.isDynamic).toBe(true);
    expect(route.priority).toBe(11);
  });

  test("catch-all rest param", () => {
    const route = parseRoute("docs/[...path].tsx");
    expect(route.segments).toEqual([
      { type: "static", value: "docs" },
      { type: "rest", value: "path" },
    ]);
    expect(route.isDynamic).toBe(true);
    expect(route.priority).toBe(101);
  });

  test("multiple params", () => {
    const route = parseRoute("[org]/[repo].tsx");
    expect(route.segments).toEqual([
      { type: "param", value: "org" },
      { type: "param", value: "repo" },
    ]);
    expect(route.isDynamic).toBe(true);
    expect(route.priority).toBe(20);
  });

  test("strips various extensions", () => {
    expect(parseRoute("page.jsx").segments[0].value).toBe("page");
    expect(parseRoute("page.ts").segments[0].value).toBe("page");
    expect(parseRoute("page.js").segments[0].value).toBe("page");
  });
});

describe("matchRoute", () => {
  test("matches root (no segments)", () => {
    const route = parseRoute("index.tsx");
    expect(matchRoute(route, "/")).toEqual({});
  });

  test("matches static page", () => {
    const route = parseRoute("about.tsx");
    expect(matchRoute(route, "/about")).toEqual({});
  });

  test("no match for wrong path", () => {
    const route = parseRoute("about.tsx");
    expect(matchRoute(route, "/contact")).toBeNull();
  });

  test("no match for extra segments", () => {
    const route = parseRoute("about.tsx");
    expect(matchRoute(route, "/about/team")).toBeNull();
  });

  test("captures named param", () => {
    const route = parseRoute("blog/[slug].tsx");
    expect(matchRoute(route, "/blog/hello-world")).toEqual({ slug: "hello-world" });
  });

  test("no match when param segment missing", () => {
    const route = parseRoute("blog/[slug].tsx");
    expect(matchRoute(route, "/blog")).toBeNull();
  });

  test("captures rest param", () => {
    const route = parseRoute("docs/[...path].tsx");
    expect(matchRoute(route, "/docs/guides/intro")).toEqual({ path: "guides/intro" });
  });

  test("rest captures single segment", () => {
    const route = parseRoute("docs/[...path].tsx");
    expect(matchRoute(route, "/docs/overview")).toEqual({ path: "overview" });
  });

  test("matches nested static", () => {
    const route = parseRoute("blog/index.tsx");
    expect(matchRoute(route, "/blog")).toEqual({});
  });

  test("multiple params captured", () => {
    const route = parseRoute("[org]/[repo].tsx");
    expect(matchRoute(route, "/acme/widget")).toEqual({ org: "acme", repo: "widget" });
  });
});

describe("routeToOutputPath", () => {
  test("root index", () => {
    const route = parseRoute("index.tsx");
    expect(routeToOutputPath(route, {})).toBe("index.html");
  });

  test("static page", () => {
    const route = parseRoute("about.tsx");
    expect(routeToOutputPath(route, {})).toBe("about/index.html");
  });

  test("nested static", () => {
    const route = parseRoute("blog/index.tsx");
    expect(routeToOutputPath(route, {})).toBe("blog/index.html");
  });

  test("dynamic param", () => {
    const route = parseRoute("blog/[slug].tsx");
    expect(routeToOutputPath(route, { slug: "hello" })).toBe("blog/hello/index.html");
  });

  test("rest param", () => {
    const route = parseRoute("docs/[...path].tsx");
    expect(routeToOutputPath(route, { path: "guides/intro" })).toBe("docs/guides/intro/index.html");
  });
});

describe("findRoute", () => {
  const routes = [
    parseRoute("index.tsx"),
    parseRoute("about.tsx"),
    parseRoute("blog/index.tsx"),
    parseRoute("blog/[slug].tsx"),
    parseRoute("docs/[...path].tsx"),
  ].sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    return a.priority - b.priority;
  });

  test("finds root", () => {
    const result = findRoute(routes, "/");
    expect(result).not.toBeNull();
    expect(result!.route.file).toBe("index.tsx");
  });

  test("finds static page", () => {
    const result = findRoute(routes, "/about");
    expect(result).not.toBeNull();
    expect(result!.route.file).toBe("about.tsx");
  });

  test("static beats dynamic", () => {
    const result = findRoute(routes, "/blog");
    expect(result).not.toBeNull();
    expect(result!.route.file).toBe("blog/index.tsx");
  });

  test("falls through to dynamic", () => {
    const result = findRoute(routes, "/blog/my-post");
    expect(result).not.toBeNull();
    expect(result!.route.file).toBe("blog/[slug].tsx");
    expect(result!.params).toEqual({ slug: "my-post" });
  });

  test("rest catches deep paths", () => {
    const result = findRoute(routes, "/docs/a/b/c");
    expect(result).not.toBeNull();
    expect(result!.route.file).toBe("docs/[...path].tsx");
    expect(result!.params).toEqual({ path: "a/b/c" });
  });

  test("returns null for no match", () => {
    const result = findRoute(routes, "/contact");
    expect(result).toBeNull();
  });
});
