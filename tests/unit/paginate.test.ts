import { describe, expect, test } from "bun:test";
import { createPaginate, type PaginatePageUrls } from "@pletivo/core/paginate";
import { parseRoute } from "@pletivo/core/router";

function pages(file: string, base: string, trailingSlash?: string): unknown[] {
  const paginate = createPaginate(parseRoute(file), base, trailingSlash);
  return paginate([1, 2, 3], { pageSize: 1 }).map((path) => path.props?.page);
}

const withUrl = (url: PaginatePageUrls) => expect.objectContaining({ url });

describe("paginate URLs", () => {
  test("a native project's URLs end with a slash", () => {
    expect(pages("[...page].astro", "/")[1]).toEqual(withUrl({ current: "/2/", prev: "/", next: "/3/", first: "/", last: "/3/" }));
  });

  test("an Astro project's URLs end with a slash only under trailingSlash: always", () => {
    expect(pages("[...page].astro", "/", "ignore")[1]).toEqual(withUrl({ current: "/2", prev: "/", next: "/3", first: "/", last: "/3" }));
    expect(pages("blog/[page].astro", "/", "never")[0]).toEqual(withUrl({ current: "/blog/1", next: "/blog/2", last: "/blog/3" }));
    expect(pages("blog/[page].astro", "/", "always")[2]).toEqual(withUrl({ current: "/blog/3/", prev: "/blog/2/", first: "/blog/1/" }));
  });

  test("an Astro project's base keeps its own trailing slash on the first page", () => {
    expect(pages("[...page].astro", "/docs/", "ignore")[1]).toEqual(withUrl({
      current: "/docs/2",
      prev: "/docs/",
      next: "/docs/3",
      first: "/docs/",
      last: "/docs/3",
    }));
    expect(pages("[...page].astro", "/docs", "ignore")[1]).toEqual(
      withUrl({ current: "/docs/2", prev: "/docs/", next: "/docs/3", first: "/docs/", last: "/docs/3" }),
    );
  });
});
