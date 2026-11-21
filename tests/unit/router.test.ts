import { describe, test, expect } from "bun:test";
import { isRouteFile, parseRoute, matchRoute, resolveScriptRoute, routeToOutputPath, findRoute } from "@pletivo/core/router";

describe("isRouteFile", () => {
  test("a _-prefixed file is not a route", () => {
    expect(isRouteFile("_draft.md")).toBe(false);
    expect(isRouteFile("blog/_draft.astro")).toBe(false);
  });

  test("nothing under a _-prefixed directory is a route, at any depth", () => {
    expect(isRouteFile("_components/Card.astro")).toBe(false);
    expect(isRouteFile("blog/_drafts/post.md")).toBe(false);
    expect(isRouteFile("_lib/deep/index.tsx")).toBe(false);
  });

  test("a _-prefixed dynamic route is not a route", () => {
    expect(isRouteFile("_[slug].astro")).toBe(false);
    expect(isRouteFile("_[...rest].astro")).toBe(false);
  });

  test("a _-prefixed endpoint is not a route", () => {
    expect(isRouteFile("_data.json.ts")).toBe(false);
    expect(isRouteFile("api/_feed.xml.js")).toBe(false);
  });

  test("its siblings, and names with `_` past the first character, are routes", () => {
    expect(isRouteFile("draft.md")).toBe(true);
    expect(isRouteFile("blog/[slug].astro")).toBe(true);
    expect(isRouteFile("data.json.ts")).toBe(true);
    expect(isRouteFile("snake_case.astro")).toBe(true);
    expect(isRouteFile("[_id].astro")).toBe(true);
  });

  test("a .-prefixed file is not a route", () => {
    expect(isRouteFile(".hidden.astro")).toBe(false);
    expect(isRouteFile("blog/.draft.md")).toBe(false);
    expect(isRouteFile(".data.json.ts")).toBe(false);
  });

  test("nothing under a .-prefixed directory is a route, at any depth", () => {
    expect(isRouteFile(".hidden/x.astro")).toBe(false);
    expect(isRouteFile("blog/.drafts/deep/post.md")).toBe(false);
  });

  test("a .well-known directory is the exception, at any depth", () => {
    expect(isRouteFile(".well-known/security.txt.ts")).toBe(true);
    expect(isRouteFile(".well-known/about.astro")).toBe(true);
    expect(isRouteFile("docs/.well-known/index.md")).toBe(true);
  });

  test("inside .well-known, the . and _ rules still apply to each name", () => {
    expect(isRouteFile(".well-known/.hidden.txt.ts")).toBe(false);
    expect(isRouteFile(".well-known/_draft.astro")).toBe(false);
    expect(isRouteFile(".well-known.astro")).toBe(false);
  });

  test("names with `.` past the first character are routes", () => {
    expect(isRouteFile("robots.txt.ts")).toBe(true);
    expect(isRouteFile("v1.2/notes.md")).toBe(true);
  });
});

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

  // A getStaticPaths() entry with a missing slug used to reach path.join and
  // abort the build with an unattributable TypeError.
  test("missing required param names the route", () => {
    const route = parseRoute("blog/[slug].tsx");
    expect(() => routeToOutputPath(route, {})).toThrow(/blog\/\[slug\]\.tsx.*slug/s);
    expect(() => routeToOutputPath(route, { slug: undefined })).toThrow(/slug/);
    expect(() => routeToOutputPath(route, { slug: "" })).toThrow(/slug/);
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

describe("endpoint routes", () => {
  test("script file carrying its own extension is an endpoint", () => {
    const route = parseRoute("robots.txt.ts");
    expect(route.isEndpoint).toBe(true);
    expect(route.segments).toEqual([{ type: "static", value: "robots.txt" }]);
    expect(routeToOutputPath(route, {})).toBe("robots.txt");
  });

  test("endpoint output keeps its extension instead of index.html", () => {
    expect(routeToOutputPath(parseRoute("eshop.json.ts"), {})).toBe("eshop.json");
    expect(routeToOutputPath(parseRoute("rss.xml.js"), {})).toBe("rss.xml");
  });

  test("nested endpoint", () => {
    const route = parseRoute("api/products.json.ts");
    expect(route.isEndpoint).toBe(true);
    expect(routeToOutputPath(route, {})).toBe("api/products.json");
  });

  test("endpoint URL matches its full filename", () => {
    const route = parseRoute("robots.txt.ts");
    expect(matchRoute(route, "/robots.txt")).toEqual({});
    expect(matchRoute(route, "/robots")).toBeNull();
  });

  test("ordinary pages are not endpoints", () => {
    expect(parseRoute("index.tsx").isEndpoint).toBe(false);
    expect(parseRoute("about.astro").isEndpoint).toBe(false);
    expect(parseRoute("blog/[slug].tsx").isEndpoint).toBe(false);
    expect(routeToOutputPath(parseRoute("about.tsx"), {})).toBe("about/index.html");
  });

  test("extensionless script route with GET() and no default export is an endpoint", () => {
    const route = resolveScriptRoute(parseRoute("api.ts"), { GET: () => new Response("") });
    expect(route.isEndpoint).toBe(true);
    expect(routeToOutputPath(route, {})).toBe("api");
    expect(routeToOutputPath(resolveScriptRoute(parseRoute("v1/users.js"), { GET: () => new Response("") }), {})).toBe("v1/users");
  });

  test("a default export keeps an extensionless script route an HTML page", () => {
    const route = resolveScriptRoute(parseRoute("api.ts"), { default: () => "", GET: () => new Response("") });
    expect(route.isEndpoint).toBe(false);
    expect(routeToOutputPath(route, {})).toBe("api/index.html");
    expect(resolveScriptRoute(parseRoute("about.tsx"), { GET: () => new Response("") }).isEndpoint).toBe(false);
  });

  test("template formats are never endpoints even with a dotted name", () => {
    // `.astro`/`.md` always render HTML — only .ts/.js opt into raw output.
    expect(parseRoute("weird.name.astro").isEndpoint).toBe(false);
    expect(parseRoute("weird.name.md").isEndpoint).toBe(false);
  });
});

describe("routeToOutputPath with Astro's build.format", () => {
  const out = (file: string, format: "directory" | "file" | "preserve", params = {}) =>
    routeToOutputPath(parseRoute(file), params, format);

  test("directory: <path>/index.html, but the 404 and 500 pages are <status>.html", () => {
    expect(out("about.astro", "directory")).toBe("about/index.html");
    expect(out("index.astro", "directory")).toBe("index.html");
    expect(out("404.md", "directory")).toBe("404.html");
    expect(out("500.astro", "directory")).toBe("500.html");
    expect(out("blog/404.astro", "directory")).toBe("blog/404/index.html");
  });

  test("file: <path>.html, the root index.html", () => {
    expect(out("one.astro", "file")).toBe("one.html");
    expect(out("sub/page.astro", "file")).toBe("sub/page.html");
    expect(out("sub/index.astro", "file")).toBe("sub.html");
    expect(out("index.astro", "file")).toBe("index.html");
    expect(out("[locale].astro", "file", { locale: "en-us" })).toBe("en-us.html");
  });

  test("preserve: an index route keeps index.html, any other page is <path>.html", () => {
    expect(out("sub/index.astro", "preserve")).toBe("sub/index.html");
    expect(out("sub/page.astro", "preserve")).toBe("sub/page.html");
  });

  test("an endpoint keeps its own file name under every format", () => {
    expect(out("rss.xml.ts", "file")).toBe("rss.xml");
  });
});
